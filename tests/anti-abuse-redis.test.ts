import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RedisSummaryStore,
  SUMMARY_PREFIX,
  SUMMARY_SCRIPT,
} from "../src/services/abuse-observation.js";
import {
  type AbuseEvent,
  AbuseScorer,
  RedisRiskStore,
} from "../src/services/abuse-scorer.js";
import {
  AbuseTrialController,
  TRIAL_KEY,
} from "../src/services/abuse-trial.js";

// Explicit opt-in only: never use the application's production Redis variables.
const url = process.env.ANTI_ABUSE_TEST_REDIS_URL;
describe.skipIf(!url)("anti-abuse Redis integration", () => {
  let redis: Redis;
  let peer: Redis;
  let store: RedisRiskStore;
  let otherStore: RedisRiskStore;
  const cleanup: string[] = [];
  const key = () => {
    const value = `integration:${randomUUID()}`;
    cleanup.push(
      `egdata:abuse:{${value}}:events`,
      `egdata:abuse:{${value}}:trap`,
    );
    return value;
  };
  const event = (at: number, page = 1): AbuseEvent => ({
    at,
    page,
    route: "/offers",
    deep: true,
    support: false,
    mismatch: 0,
  });

  beforeAll(async () => {
    redis = new Redis(url as string, {
      lazyConnect: true,
      commandTimeout: 1000,
      maxRetriesPerRequest: 0,
    });
    peer = new Redis(url as string, {
      lazyConnect: true,
      commandTimeout: 1000,
      maxRetriesPerRequest: 0,
    });
    await Promise.all([redis.connect(), peer.connect()]);
    store = new RedisRiskStore(redis);
    otherStore = new RedisRiskStore(peer);
  });
  afterAll(async () => {
    try {
      if (cleanup.length) await redis?.del(...cleanup);
    } finally {
      redis?.disconnect();
      peer?.disconnect();
    }
  });

  it.each([
    "REST",
    "GraphQL",
  ])("combines alternating %s pagination requests across independent scorers", async (kind) => {
    const shared = key();
    const a = new AbuseScorer(store);
    const b = new AbuseScorer(otherStore);
    const start = Date.now() - 5000;
    for (let page = 1; page <= 30; page++) {
      const worker = page % 2 ? a : b;
      const entry = event(start + page * 100, page);
      if (kind === "GraphQL") {
        entry.route = "/graphql";
        entry.page = undefined;
        entry.resources = [{ route: "/graphql/Query.offers", page }];
      }
      worker.enqueue([shared], entry);
      await worker.drain();
    }
    expect(a.risk([shared])).toBeGreaterThan(0.8);
    expect(b.risk([shared])).toBeGreaterThan(0.8);
    // Each worker alone saw page steps of TWO; only the shared graph sees +1.
    expect(a.stats.storeErrors + b.stats.storeErrors).toBe(0);
  });

  it("prunes by actual arrival time, retains duplicates, caps windows and expires keys", async () => {
    const node = key();
    const now = Date.now();
    await store.append(node, event(now - 61_000));
    const fresh = await store.append(node, event(now));
    expect(fresh.events).toHaveLength(1);
    await Promise.all(
      Array.from({ length: 150 }, () => store.append(node, event(now))),
    );
    const bounded = await store.append(node, event(now));
    expect(bounded.events).toHaveLength(128);
    expect(await redis.pttl(`egdata:abuse:{${node}}:events`)).toBeGreaterThan(
      59_000,
    );
    expect(
      await redis.pttl(`egdata:abuse:{${node}}:events`),
    ).toBeLessThanOrEqual(60_000);
    expect(bounded.events.every((entry) => entry.at === now)).toBe(true);
  });

  it("propagates trap risk to a cold instance even after the event window is gone", async () => {
    const node = key();
    await store.append(node, { ...event(Date.now()), trap: true });
    await redis.del(`egdata:abuse:{${node}}:events`);
    const cold = new AbuseScorer(otherStore);
    expect(cold.risk([node])).toBe(0);
    cold.enqueue([node], event(Date.now()));
    await cold.drain();
    expect(cold.risk([node])).toBe(1);
    expect(await redis.pttl(`egdata:abuse:{${node}}:trap`)).toBeGreaterThan(
      590_000,
    );
    const result = await otherStore.append(node, event(Date.now()));
    expect(result.trapped).toBe(true);
    expect(result.events.some((entry) => entry.trap)).toBe(false);
  });

  it("retains compact summaries for 24 hours, atomically deduplicates batches, and expires old buckets", async () => {
    const minute = Math.floor(Date.now() / 60000) - 5;
    const summaryKey = `${SUMMARY_PREFIX}${minute}`;
    const oldMinute = minute - 1440;
    cleanup.push(summaryKey, `${SUMMARY_PREFIX}${oldMinute}`);
    const store = new RedisSummaryStore(redis);
    await store.write([{ minute, values: { requests: 3, bodyBytes: 1200 } }]);
    await store.write([{ minute, values: { requests: 2, bodyBytes: 800 } }]);
    expect(await redis.hget(summaryKey, "requests")).toBe("5");
    expect(await redis.hget(summaryKey, "bodyBytes")).toBe("2000");
    expect(await redis.ttl(summaryKey)).toBeGreaterThan(85000);
    expect(await redis.ttl(summaryKey)).toBeLessThanOrEqual(86400);
    const args = [
      summaryKey,
      "__batch:replay",
      JSON.stringify({ requests: 1 }),
      minute * 60 + 60 + 86400,
    ];
    await redis.eval(SUMMARY_SCRIPT, 1, ...args);
    await redis.eval(SUMMARY_SCRIPT, 1, ...args);
    expect(await redis.hget(summaryKey, "requests")).toBe("6");
    await store.write([{ minute: oldMinute, values: { requests: 1 } }]);
    expect(await redis.exists(`${SUMMARY_PREFIX}${oldMinute}`)).toBe(0);
  });

  it("propagates scoped trial activation and rollback between Redis clients", async () => {
    cleanup.push(TRIAL_KEY);
    const now = Date.now();
    const fingerprint = "a".repeat(64),
      path = `/offers/${"b".repeat(32)}`;
    await redis.set(
      TRIAL_KEY,
      JSON.stringify({
        id: "integration",
        createdAt: now,
        expiresAt: now + 30000,
        fingerprints: [fingerprint],
        route: "offer-details",
      }),
      "PX",
      30000,
    );
    const trial = new AbuseTrialController(peer);
    await trial.poll();
    expect(trial.matches(fingerprint, path, "GET")).toBe(true);
    expect(await redis.pttl(TRIAL_KEY)).toBeLessThanOrEqual(30000);
    await redis.del(TRIAL_KEY);
    await trial.poll();
    expect(trial.matches(fingerprint, path, "GET")).toBe(false);
    trial.close();
  });
});
