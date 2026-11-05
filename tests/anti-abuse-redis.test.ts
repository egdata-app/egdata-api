import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AbuseEvent,
  AbuseScorer,
  RedisRiskStore,
} from "../src/services/abuse-scorer.js";

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

  it("combines alternating pagination requests across independent scorers", async () => {
    const shared = key();
    const a = new AbuseScorer(store);
    const b = new AbuseScorer(otherStore);
    const start = Date.now() - 5000;
    for (let page = 1; page <= 30; page++) {
      const worker = page % 2 ? a : b;
      worker.enqueue([shared], event(start + page * 100, page));
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
});
