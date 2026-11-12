import { describe, expect, it } from "vitest";
import { ApiKeyRateLimiter } from "../worker/rate-limiter";
import { decideAdmission, utcWindowStart } from "../worker/rate-limiter-core";

const globalPolicy = { name: "global", limit: 120 };

const searchPolicy = { name: "search", limit: 300 };

describe("exact per-key quota decision", () => {
  it("admits into fixed UTC-aligned 60-second windows", () => {
    const now = Date.parse("2026-05-01T12:00:37.500Z");
    expect(utcWindowStart(now)).toBe(Date.parse("2026-05-01T12:00:00.000Z"));

    const decision = decideAdmission({
      now,
      policies: [globalPolicy, searchPolicy],
      state: null,
    });
    expect(decision.result.allowed).toBe(true);
    expect(decision.result.retryAfter).toBe(23);
    expect(decision.result.policies).toEqual([
      {
        name: "global",
        limit: 120,
        used: 1,
        remaining: 119,
        resetAt: Date.parse("2026-05-01T12:01:00.000Z"),
        window: "minute",
        windowSeconds: 60,
      },
      {
        name: "search",
        limit: 300,
        used: 1,
        remaining: 299,
        resetAt: Date.parse("2026-05-01T12:01:00.000Z"),
        window: "minute",
        windowSeconds: 60,
      },
    ]);
    expect(decision.nextState).toEqual({
      windowStart: Date.parse("2026-05-01T12:00:00.000Z"),
      globalCount: 1,
      policyCounts: { search: 1 },
    });
  });

  it("denies at the exact limit and never mutates state on denial", () => {
    const now = Date.parse("2026-05-01T12:00:10.000Z");
    const state = {
      windowStart: utcWindowStart(now),
      globalCount: 120,
      policyCounts: { search: 50 },
    };
    const decision = decideAdmission({
      now,
      policies: [globalPolicy, searchPolicy],
      state,
    });
    expect(decision.result.allowed).toBe(false);
    expect(decision.result.exhaustedPolicy).toBe("global");
    expect(decision.nextState).toBe(state);
    expect(decision.result.policies[0].remaining).toBe(0);
    expect(decision.result.policies[1].remaining).toBe(250);
  });

  it("identifies the exhausted expensive policy", () => {
    const now = Date.parse("2026-05-01T12:00:10.000Z");
    const state = {
      windowStart: utcWindowStart(now),
      globalCount: 5,
      policyCounts: { search: 300 },
    };
    const decision = decideAdmission({
      now,
      policies: [globalPolicy, searchPolicy],
      state,
    });
    expect(decision.result.allowed).toBe(false);
    expect(decision.result.exhaustedPolicy).toBe("search");
  });

  it("replaces expired windows lazily without retaining history", () => {
    const now = Date.parse("2026-05-01T12:01:01.000Z");
    const decision = decideAdmission({
      now,
      policies: [globalPolicy],
      state: {
        windowStart: Date.parse("2026-05-01T12:00:00.000Z"),
        globalCount: 120,
        policyCounts: {},
      },
    });
    expect(decision.result.allowed).toBe(true);
    expect(decision.nextState).toEqual({
      windowStart: Date.parse("2026-05-01T12:01:00.000Z"),
      globalCount: 1,
      policyCounts: {},
    });
  });

  it("isolates multiple policies and validates bounds", () => {
    const now = Date.parse("2026-05-01T12:00:10.000Z");
    const state = {
      windowStart: utcWindowStart(now),
      globalCount: 1,
      policyCounts: { search: 299 },
    };
    const decision = decideAdmission({
      now,
      policies: [globalPolicy, searchPolicy],
      state,
    });
    expect(decision.result.allowed).toBe(true);
    expect(decision.nextState.policyCounts).toEqual({ search: 300 });
    expect(decision.nextState.globalCount).toBe(2);
  });

  it("requires a global first policy and bounded limits", () => {
    expect(() =>
      decideAdmission({
        now: Date.now(),
        policies: [{ name: "search", limit: 10 }],
        state: null,
      }),
    ).toThrow();
    expect(() =>
      decideAdmission({
        now: Date.now(),
        policies: [{ name: "global", limit: 0 }],
        state: null,
      }),
    ).toThrow();
  });
});

type Row = {
  key_id: string;
  window_start: number;
  global_count: number;
  policies_json: string;
};

class FakeSql {
  readonly rows = new Map<string, Row>();
  writes = 0;

  exec(query: string, ...bindings: unknown[]) {
    const normalized = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalized.startsWith("CREATE TABLE")) {
      return { toArray: () => [] };
    }
    if (normalized.startsWith("SELECT")) {
      const row = this.rows.get(String(bindings[0]));
      return { toArray: () => (row ? [{ ...row }] : []) };
    }
    if (normalized.startsWith("INSERT")) {
      this.writes++;
      const [keyId, windowStart, globalCount, policiesJson] = bindings;
      this.rows.set(String(keyId), {
        key_id: String(keyId),
        window_start: Number(windowStart),
        global_count: Number(globalCount),
        policies_json: String(policiesJson),
      });
      return { toArray: () => [] };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }
}

function fakeLimiter() {
  const sql = new FakeSql();
  const limiter = new ApiKeyRateLimiter(
    { storage: { sql } } as unknown as DurableObjectState,
    {} as import("../worker/types").DashboardEnv,
  );
  return { limiter, sql };
}

describe("ApiKeyRateLimiter Durable Object", () => {
  it("persists exactly one bounded state row per admitted request", async () => {
    const { limiter, sql } = fakeLimiter();
    const result = await limiter.admit({
      keyId: "key_test",
      policies: [globalPolicy, searchPolicy],
    });
    expect(result.allowed).toBe(true);
    expect(sql.writes).toBe(1);
    expect(sql.rows.size).toBe(1);
    const row = sql.rows.get("key_test");
    expect(row?.global_count).toBe(1);
    expect(JSON.parse(row?.policies_json ?? "{}")).toEqual({ search: 1 });
  });

  it("does not rewrite exhausted counters for denied requests", async () => {
    const { limiter, sql } = fakeLimiter();
    sql.rows.set("key_test", {
      key_id: "key_test",
      window_start: utcWindowStart(Date.now()),
      global_count: 120,
      policies_json: JSON.stringify({ search: 3 }),
    });
    const result = await limiter.admit({
      keyId: "key_test",
      policies: [globalPolicy, searchPolicy],
    });
    expect(result.allowed).toBe(false);
    expect(result.exhaustedPolicy).toBe("global");
    expect(sql.writes).toBe(0);
  });

  it("replaces expired windows in the same bounded row", async () => {
    const { limiter, sql } = fakeLimiter();
    sql.rows.set("key_test", {
      key_id: "key_test",
      window_start: utcWindowStart(Date.now()) - 60_000,
      global_count: 120,
      policies_json: JSON.stringify({ search: 300 }),
    });
    const result = await limiter.admit({
      keyId: "key_test",
      policies: [globalPolicy, searchPolicy],
    });
    expect(result.allowed).toBe(true);
    expect(sql.rows.size).toBe(1);
    expect(sql.rows.get("key_test")?.global_count).toBe(1);
  });
});
