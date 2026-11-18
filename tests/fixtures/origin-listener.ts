import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";

interface FixtureOrigin {
  get(
    path: string,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<Response>;
  ready(): Promise<void>;
  checkHealth(status: number): Promise<void>;
  exited(): Promise<number | null>;
  output(): string;
}

export async function withOrigin(
  origin: string,
  settings: Record<string, string>,
  check: (app: FixtureOrigin) => Promise<void>,
) {
  expect(new URL(process.env.EGDATA_TEST_MONGO ?? "").hostname).toBe(
    "127.0.0.1",
  );
  const cwd = await mkdtemp(join(tmpdir(), "egdata-fixture-origin-"));
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    const env = { ...process.env };
    // Never start a child with credentials or endpoints from a developer's .env.
    const inherited = new Set([
      "PATH",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "LLVM_PROFILE_FILE",
    ]);
    for (const key of Object.keys(env)) {
      if (!inherited.has(key.toUpperCase())) delete env[key];
    }
    Object.assign(env, {
      NODE_ENV: "production",
      MONGO_URL: process.env.EGDATA_TEST_MONGO,
      MONGO_CA: process.env.EGDATA_TEST_MONGO_CA,
      MONGO_CERT: process.env.EGDATA_TEST_MONGO_CERT,
      REDISHOST: "127.0.0.1",
      V1_WORKER_TOKEN: "redis-fixture-worker",
      ORIGIN_AUTH_TOKEN: "redis-fixture-origin",
      OPENSEARCH_URL: "http://127.0.0.1:1",
      NEON_CONNECTION_URI: "postgres://fixture:fixture@127.0.0.1:1/fixture",
      BETTER_AUTH_SECRET: "redis-fixture-session-secret-for-local-startup",
      ...settings,
    });
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((done) => reservation.close(() => done()));
    // Node hardcodes HTTP port 4000. Redirect only that listen call in the
    // child so its real entrypoint, Mongo/index initialization and middleware run.
    const redirect = `import {Server} from "node:net"; const listen=Server.prototype.listen;
          Server.prototype.listen=function(port,...args){return port===4000 ? listen.call(this,${port},"127.0.0.1",...args.filter(a=>typeof a==="function")) : listen.call(this,port,...args)};`;
    const launched =
      origin === "node"
        ? spawn(
            process.execPath,
            [
              "--import",
              "data:text/javascript," + encodeURIComponent(redirect),
              resolve("dist/index.js"),
            ],
            { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
          )
        : spawn(
            resolve(process.env.EGDATA_TEST_RUST_ORIGIN_BIN ?? ""),
            ["--port", String(port)],
            { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
          );
    worker = launched;
    let log = "";
    launched.stdout?.on("data", (chunk) => {
      log = (log + chunk).slice(-4000);
    });
    launched.stderr?.on("data", (chunk) => {
      log = (log + chunk).slice(-4000);
    });
    const get = (
      path: string,
      signal = AbortSignal.timeout(15_000),
      headers: Record<string, string> = {},
    ) =>
      fetch("http://127.0.0.1:" + port + path, {
        headers: {
          ...headers,
          "x-egdata-origin-token": "redis-fixture-origin",
          "x-egdata-worker-token": "redis-fixture-worker",
          "x-egdata-key-id": "key_fixture",
          "x-egdata-key-tier": "free",
        },
        signal,
      });
    const ready = async () => {
      await expect
        .poll(
          async () => {
            if (launched.exitCode !== null)
              throw new Error("Origin exited: " + log);
            try {
              return (await get("/v1/countries")).status;
            } catch {
              return 0;
            }
          },
          { timeout: 20_000, interval: 75 },
        )
        .toBe(200);
    };
    const checkHealth = async (expected: number) => {
      const response = await get("/v1/health");
      expect(response.status).toBe(expected);
      expect(await response.json()).toMatchObject({
        data: {
          services: {
            mongodb: { status: "ok" },
            redis: { status: expected === 200 ? "ok" : "error" },
          },
        },
      });
    };
    const exit = once(launched, "exit").then(([code]) => code as number | null);
    await check({
      get,
      checkHealth,
      ready,
      exited: () => exit,
      output: () => log,
    });
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
    }
    await rm(cwd, { recursive: true, force: true });
  }
}
