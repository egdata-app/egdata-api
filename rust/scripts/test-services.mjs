// Every run owns its Compose project, TLS identity, published loopback ports and data volumes.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const project = "egdata-tests-" + randomUUID();
const composeArgs = ["compose", "-p", project, "-f", "compose.tests.yaml"];
const compare = process.argv[2] === "--compare-origins";
const recovery = process.argv[2] === "--redis-recovery";
const args = process.argv.slice(2);
const search =
  compare ||
  (!recovery &&
    (!args.length ||
      args.includes("--ignored") ||
      args.includes("--include-ignored")));
const withOrigin =
  compare || (!recovery && Boolean(process.env.EGDATA_TEST_ORIGIN_IMAGE));
if (withOrigin) composeArgs.push("--profile", "origin");
if (search) composeArgs.push("--profile", "search");

function compose(args, capture = false) {
  const result = spawnSync("docker", [...composeArgs, ...args], {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Docker Compose failed during " + args[0]);
  return result.stdout?.trim();
}

const certDir = mkdtempSync(join(tmpdir(), "egdata-test-certs-"));
try {
  try {
    compose([
      "up",
      "--wait",
      "--wait-timeout",
      "150",
      "-d",
      ...(recovery ? ["mongo", "redis"] : []),
    ]);
  } catch (error) {
    if (search) compose(["logs", "--tail", "12", "search"]);
    throw error;
  }
  const address = (service, port) =>
    compose(["port", service, String(port)], true);
  let origin;
  if (withOrigin) {
    origin = "http://" + address("origin", 4000);
    const headers = { "x-egdata-origin-token": "fixture-origin-token" };
    const deadline = Date.now() + 45_000;
    let health;
    while (Date.now() < deadline) {
      try {
        health = await (
          await fetch(origin + "/v1/health", {
            headers,
            signal: AbortSignal.timeout(2000),
          })
        ).json();
        if (health.data?.status === "ok") break;
      } catch {
        // Startup includes TLS authentication and additive catalog indexes.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (health?.data?.status !== "ok") {
      compose(["logs", "--tail", "15", "origin"]);
      throw new Error(
        "Packaged origin failed its MongoDB and Redis health check",
      );
    }
    const denied = await fetch(origin + "/v1/health");
    if (denied.status !== 403)
      throw new Error("Packaged origin accepted an untrusted request");
    await denied.body?.cancel();
    console.log(
      "Packaged origin ready with X.509 MongoDB, Redis and Postgres; gateway authentication verified.",
    );
  }
  const copyCert = (name) => {
    const path = join(certDir, name);
    compose(["cp", "mongo:/tmp/egdata-certs/" + name, path]);
    chmodSync(path, 0o600);
    return path;
  };
  const env = {
    ...process.env,
    EGDATA_TEST_MONGO: "mongodb://" + address("mongo", 27017),
    EGDATA_TEST_MONGO_CA: copyCert("ca.pem"),
    EGDATA_TEST_MONGO_CERT: copyCert("client.pem"),
    EGDATA_TEST_REDIS: "redis://" + address("redis", 6379),
    EGDATA_TEST_PG: recovery
      ? undefined
      : "postgresql://egdata_test:egdata_test@" +
        address("postgres", 5432) +
        "/egdata_test",
  };
  if (search) env.EGDATA_TEST_OPENSEARCH = "http://" + address("search", 9200);
  if (recovery) {
    const root = resolve(cwd, "..");
    const run = (command, args, directory) => {
      const result = spawnSync(command, args, {
        cwd: directory,
        env,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(command + " failed during Redis recovery test");
    };
    run(
      "cargo",
      ["build", "--locked", "-p", "egdata-api", "--bin", "egdata-api"],
      cwd,
    );
    // Resolve the actual Cargo target even when it comes from a local config.
    const metadata = spawnSync(
      "cargo",
      ["metadata", "--locked", "--no-deps", "--format-version", "1"],
      { cwd, env, encoding: "utf8" },
    );
    if (metadata.error) throw metadata.error;
    if (metadata.status !== 0)
      throw new Error("Cannot locate the built origin: " + metadata.stderr);
    env.EGDATA_TEST_RUST_ORIGIN_BIN = join(
      JSON.parse(metadata.stdout).target_directory,
      "debug",
      process.platform === "win32" ? "egdata-api.exe" : "egdata-api",
    );
    run(
      process.execPath,
      [join(root, "node_modules/@rslib/core/bin/rslib.js"), "build"],
      root,
    );
    run(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "tests/rust-redis-startup.test.ts",
        "tests/rust-search-startup.test.ts",
      ],
      root,
    );
  } else if (compare) {
    const root = resolve(cwd, "..");
    const clusterOracle = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "tests/rust-search-cluster-oracle.test.ts",
      ],
      { cwd: root, env, stdio: "inherit" },
    );
    if (clusterOracle.error) throw clusterOracle.error;
    if (clusterOracle.status !== 0)
      throw new Error("OpenSearch cluster comparison failed");
    const { compareOrigins } = await import("./compare-origins.mjs");
    const runOrigin = (args) =>
      spawnSync(
        "docker",
        [
          ...composeArgs,
          "exec",
          "-T",
          "origin",
          "/usr/local/bin/egdata-api",
          ...args,
        ],
        { cwd, encoding: "utf8" },
      );
    await compareOrigins(cwd, certDir, env, origin, runOrigin);
  } else {
    const result = spawnSync(
      "cargo",
      args.length
        ? args
        : ["test", "--locked", "--workspace", "--", "--ignored"],
      { cwd, env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} finally {
  try {
    compose(["down", "-v", "--remove-orphans"]);
  } finally {
    rmSync(certDir, { recursive: true, force: true });
  }
}
