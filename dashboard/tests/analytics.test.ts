import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsDashboardSummary,
  UsageTableResult,
} from "../worker/analytics-types";
import { signHmacToken } from "../worker/crypto";
import type { DashboardEnv } from "../worker/types";
import { sqliteD1 } from "./fixtures/sqlite";

const origin = "https://devs.egdata.app";
const secret = "analytics-test-session-secret-32-characters";
const now = new Date("2026-11-11T12:00:00Z");
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  sqlite.exec(
    readFileSync("migrations/0005_dashboard_session_revocations.sql", "utf8"),
  );
  sqlite.exec(
    readFileSync("migrations/0004_limit_request_reviews.sql", "utf8"),
  );
  sqlite.exec(
    "INSERT INTO users(epic_account_id,display_name) VALUES('admin','Admin'),('alice','Alice'),('bob','Bob'); INSERT INTO user_roles(user_id,role) VALUES('admin','admin'); INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('a','alice','Atlas App','atlas'),('b','bob','Beacon App','beacon'); INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash) VALUES('ka','a','alice','Atlas production','egk','hash-a'),('kb','b','bob','Beacon production','egk','hash-b');",
  );
  // D1 batch returns result rows for SELECT; emulate that for read-only analytics.
  db.batch = async <T>(statements: D1PreparedStatement[]) =>
    Promise.all(statements.map((stmt) => stmt.all<T>()));
  const env = {
    DB: db,
    DASHBOARD_SESSION_SECRET: secret,
    ANALYTICS: { writeDataPoint: vi.fn() },
  } as unknown as DashboardEnv;
  const { recordApiTelemetry } = await import("../worker/analytics");
  const { default: worker } = await import("../worker/index");
  const event = (
    overrides: Partial<Parameters<typeof recordApiTelemetry>[1]> = {},
    ago = 60_000,
  ) => {
    vi.setSystemTime(new Date(now.getTime() - ago));
    recordApiTelemetry(env, {
      ownerEpicId: "alice",
      projectId: "a",
      keyId: "ka",
      routeTemplate: "/v1/offers/{id}",
      method: "GET",
      statusCode: 200,
      cacheStatus: "MISS",
      limitOutcome: "ok",
      origin: "https://atlas.example",
      clientIp: "192.0.2.1",
      userAgent: "Atlas SDK",
      country: "ES",
      latencyMs: 100,
      ...overrides,
    });
    vi.setSystemTime(now);
  };
  const call = async (path = "", user: string | null = "alice") => {
    const token = user
      ? await signHmacToken(
          {
            user: {
              epicAccountId: user,
              displayName: user,
              avatarUrl: "",
              isAdmin: true,
              roles: ["admin"],
            },
            iat: Date.now(),
            exp: Date.now() + 60_000,
          },
          secret,
        )
      : null;
    return worker.fetch(
      new Request(`${origin}/_dashboard/api/analytics${path}`, {
        headers: token ? { cookie: `egdata_dash_session=${token}` } : {},
      }),
      env,
      context,
    );
  };
  return { env, sqlite, event, call };
}

describe("usage authorization and aggregation", () => {
  it("requires a live DB admin role for both global reporting routes, ignoring cookie claims", async () => {
    const { call, sqlite } = await setup();
    for (const path of ["?scope=all", "/table?scope=all"]) {
      expect((await call(path, null)).status).toBe(401);
      expect((await call(path)).status).toBe(403);
      expect((await call(path, "admin")).status).toBe(200);
    }
    sqlite.exec("DELETE FROM user_roles");
    expect((await call("?scope=all", "admin")).status).toBe(403);
    expect((await call("/table?scope=all", "admin")).status).toBe(403);
  });

  it("keeps project and key filters inside the caller's owner boundary; admins opt into all owners", async () => {
    const { call, event } = await setup();
    event();
    event({
      ownerEpicId: "bob",
      projectId: "b",
      keyId: "kb",
      statusCode: 429,
      limitOutcome: "rate_limited",
      cacheStatus: "EDGE_BLOCK",
    });
    const own = (await (await call()).json()) as AnalyticsDashboardSummary;
    expect(own.totals.requests).toBe(1);
    expect(own.projects.map((p) => p.label)).toEqual(["Atlas App"]);
    expect(
      (
        (await (
          await call("?projectId=b&keyId=kb")
        ).json()) as AnalyticsDashboardSummary
      ).totals.requests,
    ).toBe(0);
    expect(
      (
        (await (
          await call("/table?dimension=projects&search=Beacon")
        ).json()) as UsageTableResult
      ).rows,
    ).toEqual([]);
    expect(
      ((await (await call("", "admin")).json()) as AnalyticsDashboardSummary)
        .totals.requests,
    ).toBe(0);
    const all = (await (
      await call("?scope=all", "admin")
    ).json()) as AnalyticsDashboardSummary;
    expect(all.totals).toMatchObject({
      requests: 2,
      errors: 1,
      rateLimited: 1,
      blockedPolicy: 0,
    });
    expect(all.projects.map((p) => p.label)).toEqual([
      "Atlas App",
      "Beacon App",
    ]);
    expect(all.keys[0]).toMatchObject({
      label: "Beacon production",
      keyId: "kb",
      rateLimited: 1,
    });
    expect(JSON.stringify(all)).not.toContain("hash-b");
    expect(
      (
        (await (
          await call("?scope=all&projectId=b&keyId=kb", "admin")
        ).json()) as AnalyticsDashboardSummary
      ).totals.requests,
    ).toBe(1);
  });

  it("counts cache, policy failures, errors and limits without treating allowed requests as successful HTTP responses", async () => {
    const { event, call } = await setup();
    event({ cacheStatus: "HIT", latencyMs: 10 });
    event({ statusCode: 500, latencyMs: 500 });
    event({
      statusCode: 403,
      limitOutcome: "method_denied",
      cacheStatus: "EDGE_BLOCK",
      latencyMs: 3,
      method: "POST",
    });
    event({
      statusCode: 429,
      limitOutcome: "rate_limited",
      cacheStatus: "EDGE_BLOCK",
      latencyMs: 2,
    });
    const data = (await (await call()).json()) as AnalyticsDashboardSummary;
    expect(data.totals).toMatchObject({
      requests: 4,
      cacheHits: 1,
      cacheHitRate: 25,
      errors: 3,
      errorRate: 75,
      rateLimited: 1,
      blockedPolicy: 1,
      avgLatencyMs: 128.8,
      p95LatencyMs: 500,
    });
    expect(data.previous).toBeNull();
    expect(data.source).toBe("local_buffer");
    expect(data.timeseries).toHaveLength(1); // unknown history must not become fabricated zeroes
    expect(data.statusCodes.map((s) => s.status).sort()).toEqual([
      "200",
      "403",
      "429",
      "500",
    ]);
    const detail = (await (
      await call(`?route=${encodeURIComponent("/v1/offers/{id}")}&method=POST`)
    ).json()) as AnalyticsDashboardSummary;
    expect(detail.totals).toMatchObject({ requests: 1, blockedPolicy: 1 });
  });

  it("paginates beyond the previous top-15 cap and searches/sorts all matching endpoints", async () => {
    const { event, call } = await setup();
    for (let i = 0; i < 32; i++)
      event({
        routeTemplate: `/v1/item-${String(i).padStart(2, "0")}`,
        latencyMs: i,
      });
    const first = (await (
      await call("/table?limit=25&sort=p95LatencyMs&direction=desc")
    ).json()) as UsageTableResult;
    const second = (await (
      await call("/table?limit=25&offset=25&sort=p95LatencyMs&direction=desc")
    ).json()) as UsageTableResult;
    expect(first.rows).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(second.rows).toHaveLength(7);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(
      32,
    );
    expect(first.rows[0].p95LatencyMs).toBe(31);
    const search = (await (
      await call("/table?search=item-01")
    ).json()) as UsageTableResult;
    expect(search.rows.map((r) => r.label)).toEqual(["/v1/item-01"]);
    const appSearch = (await (
      await call("/table?dimension=projects&search=ATLAS")
    ).json()) as UsageTableResult;
    expect(appSearch.rows[0].label).toBe("Atlas App");
    const keySearch = (await (
      await call("/table?dimension=keys&search=production")
    ).json()) as UsageTableResult;
    expect(keySearch.rows[0].label).toBe("Atlas production");
  });

  it.each([
    "?scope=everyone",
    "?hours=-1",
    "?hours=721",
    "?hours=NaN",
    "?projectId=a%27",
    "?end=tomorrow",
    "/table?sort=DROP",
    "/table?direction=sideways",
    "/table?limit=101",
    "/table?offset=-1",
    "/table?dimension=secrets",
  ])("rejects invalid filters %s", async (path) => {
    const { call } = await setup();
    expect((await call(path)).status).toBe(400);
  });

  it("uses equal, non-overlapping remote windows, weighted percentiles, UTC buckets, and safe SQL filters", async () => {
    const { env, call } = await setup();
    env.CF_ACCOUNT_ID = "test-account";
    env.CF_ANALYTICS_API_TOKEN = "test-token";
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const query = String(init.body);
        queries.push(query);
        let data: object[] = [];
        if (query.includes("GROUP BY bucket"))
          data = [
            {
              bucket: "2026-11-11 11:00:00",
              requests: "8",
              p95LatencyMs: "230",
            },
          ];
        else if (!query.includes("GROUP BY"))
          data = [
            {
              requests: query.includes("2026-11-09 12:00:00") ? "4" : "8",
              errors: "2",
              p95LatencyMs: "230",
            },
          ];
        return Response.json({ data });
      }),
    );
    const data = (await (
      await call("?projectId=a")
    ).json()) as AnalyticsDashboardSummary;
    expect(data.totals.requests).toBe(8);
    expect(data.previous?.requests).toBe(4);
    expect(data.timeseries).toHaveLength(24);
    expect(data.timeseries.filter((p) => p.requests === 0)).toHaveLength(23);
    expect(data.timeseries.at(-1)?.bucket).toBe("2026-11-11T11:00:00.000Z");
    expect(
      queries.every(
        (q) => q.includes("index1 = 'alice'") && q.includes("blob2 = 'a'"),
      ),
    ).toBe(true);
    expect(queries[0]).toContain(
      "quantileExactWeighted(0.95)(double2, _sample_interval)",
    );
    expect(queries[1]).toContain(
      "timestamp < toDateTime('2026-11-10 12:00:00')",
    );
    const attack = "a' OR 1=1 --";
    await call(
      `/table?search=${encodeURIComponent(attack)}&route=${encodeURIComponent(attack)}&offset=25`,
    );
    expect(queries.at(-1)).toContain("blob3 = 'a'' OR 1=1 --'");
    expect(queries.at(-1)).toContain(
      "position(lowerUTF8('a'' OR 1=1 --') IN lowerUTF8(blob3))",
    );
    expect(queries.at(-1)).toContain("LIMIT 26 OFFSET 25");
    queries.length = 0;
    await call("/table?scope=all", "admin");
    expect(queries[0]).not.toContain("index1 =");
  });

  it("sorts remote dimensions by projected aliases accepted by Analytics Engine", async () => {
    const { env, call } = await setup();
    env.CF_ACCOUNT_ID = "test-account";
    env.CF_ANALYTICS_API_TOKEN = "test-token";
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const query = String(init.body);
        queries.push(query);
        // Reproduce the live SQL planner: source columns are no longer visible
        // in ORDER BY after SELECT has renamed them to d0/d1.
        const ordering = query.split("ORDER BY ")[1]?.split(" LIMIT")[0];
        if (ordering && /\bblob\d+\b/.test(ordering))
          return new Response("unable to find type of column", { status: 422 });
        return Response.json({ data: [] });
      }),
    );
    expect((await call()).status).toBe(200);
    for (const [dimension, columns] of [
      ["endpoints", 2],
      ["projects", 1],
      ["keys", 2],
      ["origins", 1],
      ["ips", 2],
      ["userAgents", 1],
    ] as const) {
      const response = await call(
        `/table?dimension=${dimension}&sort=p95LatencyMs&direction=asc&offset=25`,
      );
      expect(response.status).toBe(200);
      expect(queries.at(-1)).toContain(
        `ORDER BY p95LatencyMs ASC, d0 ASC${columns === 2 ? ", d1 ASC" : ""} LIMIT 26 OFFSET 25`,
      );
    }
  });

  it("reports a remote failure instead of quietly substituting incomplete local history", async () => {
    const { env, call, event } = await setup();
    event();
    env.CF_ACCOUNT_ID = "account";
    env.CF_ANALYTICS_API_TOKEN = "secret-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("private upstream error", { status: 503 }),
      ),
    );
    const result = await call();
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private upstream error");
  });
});
