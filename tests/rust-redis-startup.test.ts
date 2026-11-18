import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Redis } from "ioredis";
import { expect, it } from "vitest";
import { withOrigin } from "./fixtures/origin-listener.js";

// A closed gate refuses connections. Opening it forwards to the same real Redis
// so the origins must recover without a restart. Dropping sockets tests a later outage.
async function redisGate(upstream: URL, stallHandshake = false) {
  let enabled = false;
  const sockets = new Set<Socket>();
  const server = net.createServer((client) => {
    if (!enabled) {
      if (!stallHandshake) return void client.destroy();
      sockets.add(client);
      client.on("error", () => client.destroy());
      client.on("close", () => sockets.delete(client));
      return;
    }
    const peer = net.connect(Number(upstream.port), upstream.hostname);
    for (const socket of [client, peer]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        client.destroy();
        peer.destroy();
      });
    }
    client.pipe(peer).pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as net.AddressInfo).port,
    open() {
      for (const socket of sockets) socket.destroy();
      enabled = true;
    },
    shut() {
      enabled = false;
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      this.shut();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const services = process.env.EGDATA_TEST_REDIS && process.env.EGDATA_TEST_MONGO;
for (const origin of ["node", "rust"]) {
  it.skipIf(
    !services ||
      (origin === "rust" && !process.env.EGDATA_TEST_RUST_ORIGIN_BIN),
  )(
    origin +
      " serves HTTP while Redis is down and reconnects without restarting",
    async () => {
      const upstream = new URL(process.env.EGDATA_TEST_REDIS ?? "");
      const mongo = new URL(process.env.EGDATA_TEST_MONGO ?? "");
      expect([upstream.hostname, mongo.hostname]).toEqual([
        "127.0.0.1",
        "127.0.0.1",
      ]);
      const gate = await redisGate(upstream);
      const dedicated = await redisGate(upstream, true);
      const redis = new Redis(upstream.href);
      const id = randomUUID();
      const savedKey = "q:" + id;
      const cacheKey =
        id + ':v1:offer-details.price-history.by-region:id="' + id + '"';
      try {
        await redis.set(savedKey, JSON.stringify({ query: id }), "EX", 120);
        await redis.set(cacheKey, JSON.stringify({ US: [] }), "EX", 120);
        await withOrigin(
          origin,
          {
            REDISPORT: String(gate.port),
            CACHE_REDIS_HOST: "127.0.0.1",
            CACHE_REDIS_PORT: String(dedicated.port),
            RESPONSE_CACHE_PREFIX: id + ":",
          },
          async ({ get, checkHealth, ready }) => {
            await ready();
            await checkHealth(503);
            const history = "/v1/offers/" + id + "/price-history";
            // A dedicated cache that accepts TCP but never finishes its handshake
            // must not stall this Mongo read for its 1000 ms connection timeout.
            expect(
              await Promise.race([
                get(history).then((r) => r.status),
                delay(750, "blocked on cache"),
              ]),
            ).toBe(404);
            const pending = get("/v1/search/" + id);
            expect(
              await Promise.race([
                pending.then(() => "returned"),
                delay(150, "waiting"),
              ]),
            ).toBe("waiting");
            gate.open();
            const saved = await pending;
            expect(saved.status).toBe(200);
            expect(await saved.json()).toMatchObject({ data: { query: id } });
            await checkHealth(200);
            dedicated.open();
            await expect
              .poll(async () => (await get(history)).status, { timeout: 8000 })
              .toBe(200);
            expect(await (await get(history)).json()).toMatchObject({
              data: { US: [] },
            });
            gate.shut();
            // No previous shared request has observed the socket closing. This read
            // must still survive reconnecting, including on an idle RESP2 socket.
            await delay(100);
            const interrupted = get("/v1/search/" + id).then(
              (response) => response.status,
              () => 0,
            );
            await checkHealth(503);
            expect(
              await Promise.race([interrupted, delay(100, "waiting")]),
            ).toBe("waiting");
            expect((await get(history)).status).toBe(200);
            gate.open();
            expect(await interrupted).toBe(200);
            await expect
              .poll(async () => (await get("/v1/health")).status, {
                timeout: 8000,
              })
              .toBe(200);
          },
        );
      } finally {
        try {
          await redis.del(savedKey, cacheKey);
        } finally {
          redis.disconnect();
        }
        await Promise.all([gate.close(), dedicated.close()]);
      }
    },
    60_000,
  );
  it.skipIf(
    !services ||
      (origin === "rust" && !process.env.EGDATA_TEST_RUST_ORIGIN_BIN),
  )(
    origin +
      " serves public routes when a malformed shared Redis port closes the client",
    async () => {
      for (const raw of ["letters", "-1", "65536", "0x", "9".repeat(400)]) {
        await withOrigin(
          origin,
          { REDISPORT: raw },
          async ({ ready, get, checkHealth }) => {
            await ready();
            await checkHealth(503);
            const response = await get(
              "/v1/search/invalid-port",
              AbortSignal.timeout(3000),
            );
            expect(response.status, raw).toBe(500);
            expect(await response.json()).toMatchObject({
              code: "INTERNAL_ERROR",
              status: 500,
              instance: "/v1/search/invalid-port",
            });
            const missing = await get("/v1/offers/invalid-port/price-history");
            expect(missing.status).toBe(404);
          },
        );
      }
      await withOrigin(
        origin,
        { REDISPORT: "-0" },
        async ({ ready, get, checkHealth }) => {
          await ready();
          await checkHealth(503);
          await expect(
            get("/v1/search/zero-port", AbortSignal.timeout(250)),
          ).rejects.toMatchObject({ name: "TimeoutError" });
        },
      );
      await withOrigin(
        origin,
        {
          REDISPORT: "letters",
          ANTI_ABUSE_MODE: "observe",
          ANTI_ABUSE_SECRET: "redis-fixture-observation-secret-for-tests",
        },
        async ({ ready, checkHealth }) => {
          await ready();
          await checkHealth(503);
        },
      );
    },
    90_000,
  );

  it.skipIf(
    !services ||
      (origin === "rust" && !process.env.EGDATA_TEST_RUST_ORIGIN_BIN),
  )(
    origin +
      " serves public requests with a malformed optional session database URI",
    async () => {
      await withOrigin(
        origin,
        {
          REDISPORT: "letters",
          NEON_CONNECTION_URI:
            "postgresql://fixture:private@127.0.0.1:invalid/db",
        },
        async ({ ready, checkHealth, get }) => {
          await ready();
          await checkHealth(503);
          const token = "fixture-signed-session";
          const sig = createHmac(
            "sha256",
            "redis-fixture-session-secret-for-local-startup",
          )
            .update(token)
            .digest("base64");
          for (const [cookie, expected] of [
            ["", 401],
            ["__Secure-better-auth.session_token=bad", 401],
            [
              "__Secure-better-auth.session_token=" +
                encodeURIComponent(token + "." + sig),
              500,
            ],
          ] as const) {
            const response = await get("/profiles/me", undefined, { cookie });
            expect(response.status, await response.text()).toBe(expected);
          }
        },
      );
    },
    30_000,
  );
  it.skipIf(
    !services ||
      (origin === "rust" && !process.env.EGDATA_TEST_RUST_ORIGIN_BIN),
  )(
    origin + " rejects invalid dedicated service configuration at startup",
    async () => {
      const cases: Array<[Record<string, string>, RegExp]> = [
        [{ CACHE_REDIS_USER: "fixture" }, /CACHE_REDIS_HOST is required/],
        [
          { CACHE_REDIS_HOST: "127.0.0.1", CACHE_REDIS_PORT: "65536" },
          /CACHE_REDIS_PORT must be an integer/,
        ],
        [
          { CACHE_REDIS_HOST: "127.0.0.1", CACHE_REDIS_TLS: "yes" },
          /CACHE_REDIS_TLS must be true or false/,
        ],
        [
          {
            ANTI_ABUSE_MODE: "observe",
            ANTI_ABUSE_SECRET: "redis-fixture-observation-secret-for-tests",
            ANTI_ABUSE_REDIS_PORT: "6379",
          },
          /ANTI_ABUSE_REDIS_HOST is required/,
        ],
        [{ MONGO_CA: join(tmpdir(), randomUUID() + ".pem") }, /MongoDB/i],
        [
          {
            CACHE_REDIS_USER: "fixture",
            MONGO_CA: join(tmpdir(), randomUUID() + ".pem"),
          },
          /CACHE_REDIS_HOST is required/,
        ],
        [
          {
            ANTI_ABUSE_MODE: "observe",
            ANTI_ABUSE_SECRET: "redis-fixture-observation-secret-for-tests",
            ANTI_ABUSE_REDIS_TLS: "true",
            MONGO_CA: join(tmpdir(), randomUUID() + ".pem"),
          },
          /ANTI_ABUSE_REDIS_HOST is required/,
        ],
      ];
      for (const [settings, message] of cases) {
        await withOrigin(
          origin,
          { REDISPORT: "bad", ...settings },
          async ({ exited, output }) => {
            expect(await exited(), JSON.stringify(settings)).toBe(1);
            expect(output()).toMatch(message);
          },
        );
      }
    },
    90_000,
  );
}
