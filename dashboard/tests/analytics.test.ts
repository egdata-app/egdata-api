import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsDashboardSummary,
  UsageTableResult,
} from "../worker/analytics-types";
import { UNATTRIBUTED_LEGACY_ID } from "../worker/analytics-types";
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
  sqlite.exec(readFileSync("migrations/0008_developer_accounts.sql", "utf8"));
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
  it("removes client identifiers before storage and only returns coarse dimensions", async () => {
    const { env, event, call } = await setup();
    event({
      clientIp: "203.0.113.22",
      userAgent: "Mozilla/5.0 private-user-marker",
      origin: "https://private.example",
    });
    const { getLocalTelemetry } = await import("../worker/analytics");
    for (const value of [
      JSON.stringify(getLocalTelemetry()),
      JSON.stringify(vi.mocked(env.ANALYTICS.writeDataPoint).mock.calls),
    ]) {
      expect(value).not.toContain("203.0.113.22");
      expect(value).not.toContain("private-user-marker");
      expect(value).not.toContain("private.example");
    }
    const countries = (await (
      await call("/table?dimension=ips")
    ).json()) as UsageTableResult;
    expect(countries.rows[0]).toMatchObject({
      label: "ES",
      detail: "Country only",
    });
    const clients = (await (
      await call("/table?dimension=userAgents")
    ).json()) as UsageTableResult;
    expect(clients.rows[0].label).toBe("browser");
    env.CF_ACCOUNT_ID = "account";
    env.CF_ANALYTICS_API_TOKEN = "token";
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        queries.push(String(init.body));
        return Response.json({ data: [] });
      }),
    );
    for (const dimension of ["ips", "origins", "userAgents"])
      await call(`/table?dimension=${dimension}&search=private`);
    expect(queries[0]).not.toContain("blob9");
    expect(queries[1]).toContain(
      "if(blob8 = '(direct)' OR blob8 = '', '(direct)', '(present)')",
    );
    expect(queries[2]).toContain(
      "if(blob12 = 'privacy-v1', blob10, 'legacy (redacted)')",
    );
  });
  it("shows unowned legacy hits only in admin global scope and filters both API versions", async () => {
    const { env, call, event } = await setup();
    event();
    event({ routeTemplate: "/offers/{id}" });
    event({ routeTemplate: "/v1" });
    event({ routeTemplate: "/v10/offers" });
    const { default: worker } = await import("../worker/index");
    Object.assign(env, {
      REQUIRE_API_KEY: "false",
      API_PROXY_HOST: "api.egdata.app",
      UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
      ORIGIN_AUTH_TOKEN: "test-token",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    vi.setSystemTime(new Date(now.getTime() - 60_000));
    await worker.fetch(
      new Request("https://api.egdata.app/free-games"),
      env,
      context,
    );
    vi.setSystemTime(now);
    for (const path of [
      "?scope=all&apiVersion=legacy",
      "/table?scope=all&apiVersion=legacy",
    ]) {
      expect((await call(path)).status).toBe(403);
    }
    const own = (await (
      await call("?apiVersion=legacy")
    ).json()) as AnalyticsDashboardSummary;
    expect(own.totals.requests).toBe(2);
    const hidden = (await (
      await call(`?apiVersion=legacy&projectId=${UNATTRIBUTED_LEGACY_ID}`)
    ).json()) as AnalyticsDashboardSummary;
    expect(hidden.totals.requests).toBe(0);
    const legacy = (await (
      await call("?scope=all&apiVersion=legacy", "admin")
    ).json()) as AnalyticsDashboardSummary;
    expect(legacy.totals.requests).toBe(3);
    expect(legacy.projects).toContainEqual(
      expect.objectContaining({
        projectId: UNATTRIBUTED_LEGACY_ID,
        label: "Unattributed legacy traffic",
        requests: 1,
      }),
    );
    const v1 = (await (
      await call("?scope=all&apiVersion=v1", "admin")
    ).json()) as AnalyticsDashboardSummary;
    expect(v1.totals.requests).toBe(2);
    const all = (await (
      await call("?scope=all", "admin")
    ).json()) as AnalyticsDashboardSummary;
    expect(all.totals.requests).toBe(5);
    const table = (await (
      await call("/table?scope=all&apiVersion=legacy", "admin")
    ).json()) as UsageTableResult;
    expect(table.rows.map((r) => r.route).sort()).toEqual([
      "/free-games",
      "/offers/{id}",
      "/v10/offers",
    ]);
    for (const dimension of ["projects", "keys"]) {
      const named = (await (
        await call(
          `/table?scope=all&apiVersion=legacy&dimension=${dimension}&search=Unattributed`,
          "admin",
        )
      ).json()) as UsageTableResult;
      expect(named.rows).toHaveLength(1);
      expect(named.rows[0].label).toBe("Unattributed legacy traffic");
    }
  });

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
    "?apiVersion=v2",
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
        // in ORDER BY after SELECT has renamed them to d0/d1, and GROUP BY
        // must not group by constant literals or unaliased expressions.
        const grouping = query.split("GROUP BY ")[1]?.split(" ORDER BY")[0];
        if (grouping && (grouping.includes("'") || grouping.includes("if(")))
          return new Response("invalid GROUP BY expression", { status: 422 });
        const ordering = query.split("ORDER BY ")[1]?.split(" LIMIT")[0];
        if (ordering && /\bblob\d+\b/.test(ordering))
          return new Response("unable to find type of column", { status: 422 });
        return Response.json({
          data: query.includes("blob11 AS d0")
            ? [{ d0: "ES", requests: "5" }]
            : [],
        });
      }),
    );
    expect((await call()).status).toBe(200);
    for (const [dimension, columns] of [
      ["endpoints", 2],
      ["projects", 1],
      ["keys", 2],
      ["origins", 1],
      ["ips", 1],
      ["userAgents", 1],
    ] as const) {
      const response = await call(
        `/table?dimension=${dimension}&sort=p95LatencyMs&direction=asc&offset=25`,
      );
      expect(response.status).toBe(200);
      const groupCols = columns === 2 ? "d0, d1" : "d0";
      expect(queries.at(-1)).toContain(
        `GROUP BY ${groupCols} ORDER BY p95LatencyMs ASC, d0 ASC${columns === 2 ? ", d1 ASC" : ""} LIMIT 26 OFFSET 25`,
      );
      if (dimension === "ips") {
        const body = (await response.json()) as UsageTableResult;
        expect(body.rows[0]).toMatchObject({
          label: "ES",
          detail: "Country only",
        });
      }
    }
  });

  it.each([
    "legacy",
    "v1",
  ])("applies the %s filter to all remote charts, comparisons, and table pages", async (apiVersion) => {
    const { env, call } = await setup();
    env.CF_ACCOUNT_ID = "account";
    env.CF_ANALYTICS_API_TOKEN = "token";
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        queries.push(String(init.body));
        return Response.json({ data: [] });
      }),
    );
    expect(
      (await call(`?scope=all&apiVersion=${apiVersion}`, "admin")).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/table?scope=all&apiVersion=${apiVersion}&offset=25`,
          "admin",
        )
      ).status,
    ).toBe(200);
    expect(queries).toHaveLength(18);
    for (const query of queries) {
      expect(query).toContain(
        `AND ${apiVersion === "legacy" ? "NOT " : ""}(blob3 = '/v1' OR startsWith(blob3, '/v1/'))`,
      );
      expect(query).not.toContain("index1 =");
    }
    queries.length = 0;
    await call(`/table?apiVersion=${apiVersion}`);
    expect(queries[0]).toContain("index1 = 'alice'");
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

  it("supports developer insight filters, new dimensions, extended sorts, latency buckets, and endpoint highlights", async () => {
    const { env, call, event } = await setup();
    event({
      routeTemplate: "/v1/offers/{id}",
      operationId: "offers.getOfferById",
      method: "GET",
      statusCode: 200,
      cacheStatus: "HIT",
      limitOutcome: "ok",
      policyFamily: "read",
      country: "ES",
      userAgent: "curl/8.5.0",
      origin: "",
      latencyMs: 12,
      upstreamLatencyMs: 0,
      responseBytes: 1024,
    });
    event({
      routeTemplate: "/v1/search",
      operationId: "search.searchOffers",
      method: "POST",
      statusCode: 429,
      cacheStatus: "MISS",
      limitOutcome: "rate_limited",
      policyFamily: "expensive",
      errorCode: "rate_limited",
      country: "US",
      userAgent: "Mozilla/5.0 Chrome/120.0",
      origin: "https://atlas.example",
      latencyMs: 650,
      upstreamLatencyMs: 420,
      responseBytes: 256,
    });
    event({
      routeTemplate: "/v1/offers/{id}",
      operationId: "offers.getOfferById",
      method: "GET",
      statusCode: 500,
      cacheStatus: "MISS",
      limitOutcome: "ok",
      policyFamily: "read",
      errorCode: "upstream_5xx",
      country: "ES",
      userAgent: "node-fetch/3.0",
      origin: "https://atlas.example",
      latencyMs: 1400,
      upstreamLatencyMs: 1350,
      responseBytes: 512,
    });
    event({
      keyId: "console_session_1",
      routeTemplate: "/v1/offers/{id}",
      operationId: "offers.getOfferById",
      method: "GET",
      statusCode: 200,
      cacheStatus: "MISS",
      limitOutcome: "ok",
      policyFamily: "read",
      country: "ES",
      userAgent: "Mozilla/5.0 Chrome/120.0",
      origin: "https://devs.egdata.app",
      latencyMs: 30,
    });

    const writeCalls = (
      env.ANALYTICS?.writeDataPoint as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(writeCalls).toHaveLength(4);
    expect(writeCalls[1][0].blobs.slice(12)).toEqual([
      "search.searchOffers",
      "expensive",
      "rate_limited",
    ]);
    expect(writeCalls[1][0].doubles.slice(5)).toEqual([420, 256]);

    // Exclude API Console removes 1 event
    const noConsoleRes = await call("?excludeConsole=true");
    expect(noConsoleRes.status).toBe(200);
    const noConsole = (await noConsoleRes.json()) as AnalyticsDashboardSummary;
    expect(noConsole.totals.requests).toBe(3);
    expect(noConsole.totals.cacheMisses).toBe(2);
    expect(noConsole.totals.status2xx).toBe(1);
    expect(noConsole.totals.status4xx).toBe(1);
    expect(noConsole.totals.status5xx).toBe(1);
    expect(noConsole.totals.avgHitLatencyMs).toBe(12);
    expect(noConsole.totals.avgMissLatencyMs).toBe(1025);
    expect(
      noConsole.latencyDistribution?.reduce((s, b) => s + b.requests, 0),
    ).toBe(3);
    expect(noConsole.busiestEndpoints?.[0]?.operationId).toBe("getOffer");
    expect(noConsole.errorEndpoints?.[0]?.errors).toBeGreaterThanOrEqual(1);
    expect(noConsole.policyBreakdown?.length).toBeGreaterThan(0);

    // Filter by statusClass=5xx
    const only5xx = (await (
      await call("?statusClass=5xx")
    ).json()) as AnalyticsDashboardSummary;
    expect(only5xx.totals.requests).toBe(1);
    expect(only5xx.totals.errors).toBe(1);

    // Filter by cacheStatus=HIT and country=ES and originPresence=direct
    const hitDirect = (await (
      await call("?cacheStatus=HIT&country=ES&originPresence=direct")
    ).json()) as AnalyticsDashboardSummary;
    expect(hitDirect.totals.requests).toBe(1);
    expect(hitDirect.totals.cacheHits).toBe(1);

    // Table with minRequests=2 excludes /v1/search (1 request)
    const minReqTable = (await (
      await call("/table?dimension=endpoints&minRequests=2")
    ).json()) as UsageTableResult;
    expect(minReqTable.rows).toHaveLength(1);
    expect(minReqTable.rows[0].label).toBe("/v1/offers/{id}");
    expect(minReqTable.rows[0].method).toBe("GET");
    expect(minReqTable.rows[0].operationId).toBe("getOffer");

    // Table dimensions: statusCodes, limitOutcomes, cacheStatuses, policies + sort=label
    for (const dimension of [
      "statusCodes",
      "limitOutcomes",
      "cacheStatuses",
      "policies",
    ]) {
      const tableRes = await call(
        `/table?dimension=${dimension}&sort=label&direction=asc`,
      );
      expect(tableRes.status).toBe(200);
      const table = (await tableRes.json()) as UsageTableResult;
      expect(table.rows.length).toBeGreaterThan(0);
      expect(table.rows.map((r) => r.label)).toEqual(
        [...table.rows.map((r) => r.label)].sort((a, b) => a.localeCompare(b)),
      );
    }

    // Custom start/end window outside events returns 0 requests; >31d span rejected
    const emptyWindow = (await (
      await call(
        "?start=2026-11-01T00:00:00.000Z&end=2026-11-02T00:00:00.000Z",
      )
    ).json()) as AnalyticsDashboardSummary;
    expect(emptyWindow.totals.requests).toBe(0);
    const badWindow = await call(
      "?start=2026-09-01T00:00:00.000Z&end=2026-11-02T00:00:00.000Z",
    );
    expect(badWindow.status).toBe(400);
  });

  it("compiles remote SQL predicates for new filters without invalid GROUP BY expressions", async () => {
    const { env, call } = await setup();
    env.CF_ACCOUNT_ID = "account";
    env.CF_ANALYTICS_API_TOKEN = "token";
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        queries.push(String(init.body));
        return Response.json({ data: [] });
      }),
    );

    const res = await call(
      "?statusClass=4xx&excludeConsole=true&policyFamily=expensive&originPresence=present&clientCategory=application&country=DE",
    );
    expect(res.status).toBe(200);
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query).toContain("startsWith(blob5, '4')");
      expect(query).toContain("NOT startsWith(blob1, 'console_')");
      expect(query).toContain("blob14 = 'expensive'");
      expect(query).toContain("blob8 != '(direct)' AND blob8 != ''");
      expect(query).toContain("blob11 = 'DE'");
      expect(query).toContain("= 'application'");
      expect(query).not.toMatch(/GROUP BY[^;\n]*(if\(|')/);
    }
  });
});
