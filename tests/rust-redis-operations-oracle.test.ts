import { Redis } from "ioredis";
import { expect, it } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import {
  RedisSummaryStore,
  SUMMARY_PREFIX,
} from "../src/services/abuse-observation.js";
import { telemetryRedisOptions } from "../src/services/anti-abuse-runtime.js";
import {
  COHORT_PREFIX,
  RedisCohortStore,
} from "../src/services/pow-cohorts.js";

it("records telemetry endpoint selection without opening a connection", () => {
  type Input = Record<string, string>;
  const shared = {
    REDISHOST: "shared",
    REDISPORT: "6300",
    REDISUSER: "primary",
    REDISPASSWORD: "shared-fixture",
    REDISTLS: "true",
  };
  const cache = {
    CACHE_REDIS_HOST: " cache ",
    CACHE_REDIS_PASSWORD: " cache-fixture ",
    CACHE_REDIS_PORT: "6400",
  };
  const inputs: Input[] = [
    {},
    shared,
    { ...shared, REDISTLS: " true " },
    ...["letters", "-1", "65536", "0", "1.5", "0x", "9".repeat(400), " "].map(
      (REDISPORT) => ({ ...shared, REDISPORT }),
    ),
    { ...shared, ...cache },
    { ...shared, ...cache, ANTI_ABUSE_REDIS_HOST: " private " },
    { ...cache, ANTI_ABUSE_REDIS_PORT: "6379" },
    { CACHE_REDIS_PASSWORD: "x" },
    {
      ANTI_ABUSE_REDIS_HOST: "   ",
      ANTI_ABUSE_REDIS_PASSWORD: "   ",
      ...cache,
    },
    ...[
      "6379",
      "1e3",
      "0x18EB",
      "0b101",
      "0x+1",
      "0b+1",
      "0o17",
      "0",
      "65536",
      "no",
      " ",
      "+42",
    ].map((port) => ({
      ANTI_ABUSE_REDIS_HOST: "local",
      ANTI_ABUSE_REDIS_PORT: port,
    })),
    ...["false", "true", " true ", "1"].map((tls) => ({
      CACHE_REDIS_HOST: "local",
      CACHE_REDIS_TLS: tls,
    })),
  ];
  assertOracle(
    "redis-telemetry-config-node",
    inputs.map((input) => {
      try {
        const options = telemetryRedisOptions(input as NodeJS.ProcessEnv);
        return {
          input,
          output: {
            host: options.host,
            port: Number.isFinite(options.port)
              ? options.port
              : String(options.port),
            username: options.username ?? null,
            password: options.password ?? null,
            tls: !!options.tls,
          },
        };
      } catch (error) {
        return { input, output: { error: (error as Error).message } };
      }
    }),
  );
});

const url = process.env.ANTI_ABUSE_TEST_REDIS_URL;
it.skipIf(!url)(
  "records Lua writes, deadline instants and retained state at an error boundary",
  async () => {
    if (!url) throw new Error("Disposable Redis URL is required");
    const redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    await redis.connect();
    const day = 40000,
      minute = day * 1440;
    const keys = [
      COHORT_PREFIX + day,
      COHORT_PREFIX + (day + 1),
      SUMMARY_PREFIX + minute,
      SUMMARY_PREFIX + (minute + 1),
    ];
    async function snapshot() {
      return Promise.all(
        keys.map(async (key) => {
          const type = await redis.type(key);
          if (type === "none") return null;
          if (type === "string") return { type, value: await redis.get(key) };
          const raw = await redis.hgetall(key);
          const values = Object.fromEntries(
            Object.entries(raw).map(([k, v]) => [
              k.startsWith("__batch:") ? "batch" : k,
              v.startsWith("{") ? JSON.parse(v) : v,
            ]),
          );
          return {
            type,
            values,
            expireAt: await redis.call("EXPIRETIME", key),
          };
        }),
      );
    }
    const summary = new RedisSummaryStore(redis),
      cohort = new RedisCohortStore(redis);
    const row = (d: number, id: string, t: number) => ({
      day: d,
      id,
      firstChallenge: t,
      lastChallenge: t,
      lastPuzzle: 0,
      lastSolve: 0,
    });
    const rows = [
      row(day + 1, "recent", 10),
      row(day, "older", 15),
      row(day + 1, "recent", 8),
    ];
    const sums = [
      { minute, values: { requests: 3 } },
      { minute: minute + 1, values: { requests: 4 } },
    ];
    const cases = [];
    try {
      await redis.del(...keys);
      await redis.set(keys[0], "wrong-type");
      await expect(cohort.write(rows)).rejects.toThrow("WRONGTYPE");
      cases.push({ name: "cohort partial", rows, state: await snapshot() });
      await redis.del(keys[0]);
      await cohort.write(rows);
      cases.push({ name: "cohort retry", rows, state: await snapshot() });
      await redis.set(keys[3], "wrong-type");
      await expect(summary.write(sums)).rejects.toThrow("WRONGTYPE");
      cases.push({ name: "summary partial", sums, state: await snapshot() });
      await redis.del(keys[3]);
      await summary.write([sums[1]]);
      cases.push({
        name: "summary retry",
        sums: [sums[1]],
        state: await snapshot(),
      });
      assertOracle("redis-operations-node", cases);
    } finally {
      await redis.del(...keys);
      redis.disconnect();
    }
  },
);
