import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

import { describe, expect, it, vi } from "vitest";
import { ApiKeyRateLimiter } from "../worker/rate-limiter";
import {
  OUTBOX_MAX_ATTEMPTS,
  flushUsage,
  captureUsage,
  retryDelay,
} from "../worker/usage-outbox";
import type { DashboardEnv } from "../worker/types";

function setup(fail = false) {
  const sqlite = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const storage = {
    sql: {
      exec(query: string, ...values: any[]) {
        const stmt = sqlite.prepare(query);
        const rows = stmt.columns().length
          ? stmt.all(...values)
          : (stmt.run(...values), []);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T) {
      sqlite.exec("BEGIN");
      try {
        const result = fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(value: number) {
      alarm = value;
    },
  } as unknown as DurableObjectStorage;
  const queue = {
    sendBatch: vi.fn(async () => {
      if (fail) throw new Error("queue unavailable");
    }),
  } as unknown as Queue;
  const limiter = new ApiKeyRateLimiter(
    {
      storage,
      id: { toString: () => "object_id" },
    } as unknown as DurableObjectState,
    {
      USAGE_TRACKING_ENABLED: "true",
      ENDPOINT_USAGE_QUEUE: queue,
    } as DashboardEnv,
  );
  return {
    limiter,
    storage,
    sqlite,
    queue,
    clearAlarm: () => {
      alarm = null;
    },
    getAlarm: () => alarm,
  };
}

describe("durable admission outbox", () => {
  it("prunes expired daily buckets without maintenance-only alarms", () => {
    const { storage, sqlite, getAlarm } = setup();
    const event = {
      keyId: "key_a",
      projectId: "project_a",
      operationId: "getOffer",
      usageDate: "2026-10-07",
      firstUsedAt: Date.parse("2026-10-07T23:59:59Z"),
    };
    captureUsage(storage, event);
    captureUsage(storage, {
      ...event,
      usageDate: "2026-10-08",
      firstUsedAt: Date.parse("2026-10-08T00:00:00Z"),
    });
    captureUsage(storage, {
      ...event,
      usageDate: "2026-11-11",
      firstUsedAt: Date.parse("2026-11-11T00:00:00Z"),
    });
    expect(
      sqlite
        .prepare("SELECT usage_date FROM usage_outbox ORDER BY usage_date")
        .all(),
    ).toEqual([{ usage_date: "2026-10-08" }, { usage_date: "2026-11-11" }]);
    expect(getAlarm()).toBeNull();
  });
  it("emits one event per internal key/operation/UTC day with original first use", async () => {
    const { limiter, sqlite, storage, queue, clearAlarm, getAlarm } = setup();
    const request = {
      keyId: "key_a",
      policies: [{ name: "global", limit: 120 }],
      usage: { projectId: "project_a", operationId: "getOffer" },
    };
    await limiter.admit(request);
    await limiter.admit(request);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM usage_outbox").get()?.n,
    ).toBe(1);
    expect(getAlarm()).not.toBeNull();
    const first = sqlite
      .prepare("SELECT first_used_at FROM usage_outbox")
      .get()?.first_used_at;
    clearAlarm();
    await flushUsage(storage, queue, async () => {});
    expect(queue.sendBatch).toHaveBeenCalledOnce();
    expect(getAlarm()).toBeNull();
    await limiter.admit(request);
    clearAlarm();
    await flushUsage(storage, queue, async () => {});
    expect(queue.sendBatch).toHaveBeenCalledOnce();
    expect(
      sqlite.prepare("SELECT first_used_at FROM usage_outbox").get()
        ?.first_used_at,
    ).toBe(first);
  });
  it("never captures denied admissions and never writes D1 per request", async () => {
    const { limiter, sqlite } = setup();
    const request = {
      keyId: "key_a",
      policies: [{ name: "global", limit: 1 }],
      usage: { projectId: "project_a", operationId: "getOffer" },
    };
    expect((await limiter.admit(request)).allowed).toBe(true);
    expect(
      (
        await limiter.admit({
          ...request,
          usage: { ...request.usage, operationId: "getItem" },
        })
      ).allowed,
    ).toBe(false);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM usage_outbox").get()?.n,
    ).toBe(1);
  });
  it("retains failed events, backs off, bounds retries and exposes exhaustion", async () => {
    const { limiter, sqlite, storage, queue, clearAlarm, getAlarm } =
      setup(true);
    const failure = vi.fn(async () => {});
    await limiter.admit({
      keyId: "key_a",
      policies: [{ name: "global", limit: 120 }],
      usage: { projectId: "project_a", operationId: "getOffer" },
    });
    let now = Date.now();
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      clearAlarm();
      await flushUsage(storage, queue, failure, now);
      now += retryDelay(i + 1) + 1000;
    }
    expect(failure).toHaveBeenLastCalledWith(OUTBOX_MAX_ATTEMPTS);
    expect(getAlarm()).toBeNull();
    expect(
      sqlite.prepare("SELECT attempts,delivered FROM usage_outbox").get(),
    ).toEqual({ attempts: OUTBOX_MAX_ATTEMPTS, delivered: 0 });
    clearAlarm();
    await flushUsage(storage, queue, failure, now);
    expect(queue.sendBatch).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS);
    await limiter.retryUsage();
    expect(getAlarm()).not.toBeNull();
  });
});
