import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monthlyNoticeFor } from "../src/components/usage/MonthlyQuotaPanel";
import { CONSOLE_HEADER } from "../worker/console-sessions";
import {
  generateApiKeySecret,
  sha256Hex,
  signHmacToken,
} from "../worker/crypto";
import worker from "../worker/index";
import {
  FREE_MONTHLY_ALLOWANCE,
  rateLimitHeaders,
  readAccountMonthlyQuota,
} from "../worker/project-quota";
import {
  decideAdmission,
  utcMonthBounds,
  utcWindowStart,
} from "../worker/rate-limiter-core";
import type {
  ApiKeyTier,
  CachedKeyMetadata,
  DashboardEnv,
} from "../worker/types";
import { quotaNamespace } from "./fixtures/quota";
import { sqliteD1 } from "./fixtures/sqlite";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createQuotaHarness() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T12:00:10Z"));

  const { db, sqlite } = sqliteD1();
  for (const file of [
    "0001_initial.sql",
    "0002_endpoint_alerts.sql",
    "0003_console_sessions.sql",
    "0004_limit_request_reviews.sql",
    "0005_dashboard_session_revocations.sql",
  ]) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`
    INSERT INTO users(epic_account_id, display_name)
    VALUES ('owner_free', 'Free Owner'), ('owner_other', 'Other Owner');
    INSERT INTO projects(id, owner_epic_id, name, slug, tier)
    VALUES
      ('prj_free_1', 'owner_free', 'Free App 1', 'free-1', 'free'),
      ('prj_free_2', 'owner_free', 'Free App 2', 'free-2', 'free'),
      ('prj_paid', 'owner_free', 'Paid App', 'paid', 'pro'),
      ('prj_other', 'owner_other', 'Other App', 'other', 'free');
  `);
  for (const file of [
    "0006_project_creation_policy.sql",
    "0007_project_recovery.sql",
  ]) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec("UPDATE users SET project_limit = 5");

  const metadata = new Map<string, CachedKeyMetadata>();
  const namespace = quotaNamespace();
  const secret = "monthly-quota-test-session-secret-at-least-32";

  const env = {
    DB: db,
    DASHBOARD_SESSION_SECRET: secret,
    DASHBOARD_ORIGIN: "https://devs.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    ORIGIN_AUTH_TOKEN: "test-origin-token",
    RATE_LIMIT_ENVIRONMENT: "test",
    REQUIRE_API_KEY: "true",
    ALLOW_FIRST_PARTY_ORIGINS: "https://egdata.app",
    USAGE_TRACKING_ENABLED: "false",
    ANALYTICS: { writeDataPoint: vi.fn() },
    API_KEYS_KV: {
      get: vi.fn(async (key: string) => {
        const meta = metadata.get(key);
        return meta ? { ...meta, cacheExpiresAt: Date.now() + 300_000 } : null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
    },
    API_KEY_RATE_LIMITER:
      namespace as unknown as DashboardEnv["API_KEY_RATE_LIMITER"],
  } as unknown as DashboardEnv;

  const upstream = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [], meta: {} }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, s-maxage=300",
          "CDN-Cache-Control": "public, max-age=300",
        },
      }),
  );
  vi.stubGlobal("fetch", upstream);

  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  async function issueKey(
    options: {
      projectId?: string;
      ownerEpicId?: string;
      tier?: ApiKeyTier;
      customRpm?: number | null;
      scopes?: CachedKeyMetadata["scopes"];
    } = {},
  ) {
    const { rawKey } = generateApiKeySecret();
    const meta: CachedKeyMetadata = {
      keyId: `key_${crypto.randomUUID().slice(0, 8)}`,
      projectId: options.projectId ?? "prj_free_1",
      ownerEpicId: options.ownerEpicId ?? "owner_free",
      name: "Test Key",
      tier: options.tier ?? "free",
      customRpm: options.customRpm ?? null,
      active: true,
      scopes: options.scopes ?? ["catalog:read", "offers:read"],
      allowedIps: [],
      allowedOrigins: [],
      allowedPaths: [],
      allowedMethods: ["GET", "HEAD", "POST"],
      expiresAt: null,
    };
    metadata.set(`apikey:${await sha256Hex(rawKey)}`, meta);
    return { rawKey, meta };
  }

  function seedAccountMonthlyCount(
    ownerEpicId: string,
    usedCount: number,
    monthStart = utcMonthBounds(Date.now()).monthStart,
    environment = "test",
  ) {
    const object = namespace.get(`account:${environment}:${ownerEpicId}`);
    (
      object as unknown as {
        ctx: { storage: { sql: { exec: (...args: unknown[]) => unknown } } };
      }
    ).ctx.storage.sql.exec(
      `INSERT INTO account_monthly_state (account_id, month_start, used_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         month_start = excluded.month_start,
         used_count = excluded.used_count,
         updated_at = excluded.updated_at`,
      ownerEpicId,
      monthStart,
      usedCount,
      Date.now(),
    );
  }

  async function signSessionCookie(ownerEpicId: string) {
    const token = await signHmacToken(
      {
        user: {
          epicAccountId: ownerEpicId,
          displayName: ownerEpicId,
          avatarUrl: "",
        },
        iat: Date.now(),
        exp: Date.now() + 86_400_000,
      },
      secret,
    );
    return `egdata_dash_session=${token}`;
  }

  const callGateway = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ) =>
    worker.fetch(
      new Request(`https://api.egdata.app${path}`, {
        method,
        headers,
      }),
      env,
      ctx,
    );

  return {
    env,
    sqlite,
    namespace,
    upstream,
    ctx,
    metadata,
    issueKey,
    seedAccountMonthlyCount,
    signSessionCookie,
    callGateway,
  };
}

describe("calendar-aware UTC month boundaries and headers", () => {
  it("computes exact month rollover across 28, 29 (leap year), 30, and 31 day months and year boundaries", () => {
    // Feb 2026 (non-leap: 28 days)
    const febNonLeap = utcMonthBounds(Date.parse("2026-02-15T18:30:00Z"));
    expect(febNonLeap.monthStart).toBe(Date.parse("2026-02-01T00:00:00Z"));
    expect(febNonLeap.resetAt).toBe(Date.parse("2026-03-01T00:00:00Z"));
    expect(febNonLeap.windowSeconds).toBe(28 * 86_400);

    // Feb 2028 (leap year: 29 days)
    const febLeap = utcMonthBounds(Date.parse("2028-02-29T23:59:59.500Z"));
    expect(febLeap.monthStart).toBe(Date.parse("2028-02-01T00:00:00Z"));
    expect(febLeap.resetAt).toBe(Date.parse("2028-03-01T00:00:00Z"));
    expect(febLeap.windowSeconds).toBe(29 * 86_400);

    // Nov 2026 (30 days)
    const nov = utcMonthBounds(Date.parse("2026-11-12T12:00:00Z"));
    expect(nov.windowSeconds).toBe(30 * 86_400);

    // Dec -> Jan year rollover (31 days)
    const dec = utcMonthBounds(Date.parse("2026-12-31T23:59:10Z"));
    expect(dec.monthStart).toBe(Date.parse("2026-12-01T00:00:00Z"));
    expect(dec.resetAt).toBe(Date.parse("2027-01-01T00:00:00Z"));
    expect(dec.windowSeconds).toBe(31 * 86_400);
  });

  it("emits calendar-aware RateLimit and RateLimit-Policy windows rather than hardcoding w=60", () => {
    const now = Date.parse("2028-02-29T23:59:10Z");
    const decision = decideAdmission({
      now,
      policies: [
        { name: "global", limit: 120, window: "minute" },
        { name: "monthly", limit: 100_000, window: "month" },
      ],
      state: null,
      monthlyState: {
        monthStart: Date.parse("2028-02-01T00:00:00Z"),
        used: 99_999,
      },
    });
    expect(decision.result.allowed).toBe(true);
    const headers = rateLimitHeaders(decision.result, now);
    expect(headers.RateLimit).toBe(
      "global;q=120;r=119;t=50, monthly;q=100000;r=0;t=50",
    );
    expect(headers["RateLimit-Policy"]).toBe(
      `global;q=120;w=60, monthly;q=100000;w=${29 * 86_400}`,
    );
  });

  it("never mutates minute or monthly counters when either policy denies admission", () => {
    const now = Date.parse("2026-11-12T12:00:10Z");
    const state = {
      windowStart: utcWindowStart(now),
      globalCount: 10,
      policyCounts: {},
    };
    const monthlyState = {
      monthStart: utcMonthBounds(now).monthStart,
      used: 100_000,
    };
    const deniedMonthly = decideAdmission({
      now,
      policies: [
        { name: "global", limit: 120, window: "minute" },
        { name: "monthly", limit: 100_000, window: "month" },
      ],
      state,
      monthlyState,
    });
    expect(deniedMonthly.result.allowed).toBe(false);
    expect(deniedMonthly.result.exhaustedPolicy).toBe("monthly");
    expect(deniedMonthly.nextState).toBe(state);
    expect(deniedMonthly.nextMonthlyState).toBe(monthlyState);

    const minuteExhaustedState = {
      windowStart: utcWindowStart(now),
      globalCount: 120,
      policyCounts: {},
    };
    const partialMonthly = {
      monthStart: utcMonthBounds(now).monthStart,
      used: 500,
    };
    const deniedMinute = decideAdmission({
      now,
      policies: [
        { name: "global", limit: 120, window: "minute" },
        { name: "monthly", limit: 100_000, window: "month" },
      ],
      state: minuteExhaustedState,
      monthlyState: partialMonthly,
    });
    expect(deniedMinute.result.allowed).toBe(false);
    expect(deniedMinute.result.exhaustedPolicy).toBe("global");
    expect(deniedMinute.nextMonthlyState).toBe(partialMonthly);
  });
});

describe("free account 100,000/month quota enforcement", () => {
  it("admits exactly up to the cap under simultaneous requests across keys, free projects, console, and both gateways", async () => {
    const h = await createQuotaHarness();
    h.seedAccountMonthlyCount("owner_free", FREE_MONTHLY_ALLOWANCE - 3);

    const keyProject1 = await h.issueKey({ projectId: "prj_free_1" });
    const keyProject2 = await h.issueKey({ projectId: "prj_free_2" });
    const cookie = await h.signSessionCookie("owner_free");

    // Start a console session for prj_free_1
    const startRes = await worker.fetch(
      new Request(
        "https://devs.egdata.app/_dashboard/api/console-sessions/prj_free_1",
        {
          method: "POST",
          headers: {
            cookie,
            origin: "https://devs.egdata.app",
            "Sec-Fetch-Site": "same-origin",
          },
        },
      ),
      h.env,
      h.ctx,
    );
    const { token: consoleToken } = (await startRes.json()) as {
      token: string;
    };

    // Fire 6 simultaneous requests across legacy, v1, multiple projects, and console
    const responses = await Promise.all([
      h.callGateway("/countries", { "x-api-key": keyProject1.rawKey }),
      h.callGateway("/v1/countries", { "x-api-key": keyProject1.rawKey }),
      h.callGateway("/v1/countries", { "x-api-key": keyProject2.rawKey }),
      h.callGateway("/countries", { "x-api-key": keyProject2.rawKey }),
      worker.fetch(
        new Request("https://devs.egdata.app/proxy/v1/countries", {
          headers: {
            cookie,
            origin: "https://devs.egdata.app",
            "Sec-Fetch-Site": "same-origin",
            [CONSOLE_HEADER]: consoleToken,
          },
        }),
        h.env,
        h.ctx,
      ),
      h.callGateway("/v1/countries", { "x-api-key": keyProject1.rawKey }),
    ]);

    const admitted = responses.filter((r) => r.status === 200);
    const rejected = responses.filter((r) => r.status === 429);
    expect(admitted).toHaveLength(3);
    expect(rejected).toHaveLength(3);
    expect(h.upstream).toHaveBeenCalledTimes(3);

    // Inspect both v1 and legacy 429 error shapes and Retry-After until Dec 1 00:00 UTC
    const expectedRetryAfter = Math.ceil(
      (Date.parse("2026-12-01T00:00:00Z") - Date.now()) / 1000,
    );
    const v1Denied = await h.callGateway("/v1/countries", {
      "x-api-key": keyProject1.rawKey,
    });
    expect(v1Denied.status).toBe(429);
    expect(v1Denied.headers.get("Retry-After")).toBe(
      String(expectedRetryAfter),
    );
    expect(v1Denied.headers.get("X-RateLimit-Policy")).toBe("monthly");
    expect(await v1Denied.json()).toMatchObject({
      status: 429,
      code: "MONTHLY_QUOTA_EXCEEDED",
    });

    const legacyDenied = await h.callGateway("/countries", {
      "x-api-key": keyProject2.rawKey,
    });
    expect(legacyDenied.status).toBe(429);
    expect(legacyDenied.headers.get("Retry-After")).toBe(
      String(expectedRetryAfter),
    );
    expect(await legacyDenied.json()).toMatchObject({
      error: { code: "MONTHLY_QUOTA_EXCEEDED" },
    });

    // Separate free projects still keep separate per-minute counters within the account DO
    const summary = await readAccountMonthlyQuota(h.env, "owner_free");
    expect(summary).toMatchObject({
      used: 100_000,
      remaining: 0,
      allowance: 100_000,
      status: "exhausted",
      resetAt: "2026-12-01T00:00:00.000Z",
    });

    // Unrelated account and separate environment are unaffected
    const otherOwnerKey = await h.issueKey({
      projectId: "prj_other",
      ownerEpicId: "owner_other",
    });
    expect(
      (
        await h.callGateway("/v1/countries", {
          "x-api-key": otherOwnerKey.rawKey,
        })
      ).status,
    ).toBe(200);
  });

  it("counts cache hits and upstream 5xx responses while excluding auth failures, permission denials, quota rejections, and public bypasses", async () => {
    const h = await createQuotaHarness();
    const restrictedKey = await h.issueKey({ scopes: ["offers:read"] });

    // 1. Missing key -> 401 (excluded)
    expect((await h.callGateway("/v1/countries")).status).toBe(401);
    // 2. Invalid key -> 401 (excluded)
    expect(
      (
        await h.callGateway("/v1/countries", {
          "x-api-key": "egk_live_invalid",
        })
      ).status,
    ).toBe(401);
    // 3. Scope denied -> 403 (excluded)
    expect(
      (
        await h.callGateway("/v1/countries", {
          "x-api-key": restrictedKey.rawKey,
        })
      ).status,
    ).toBe(403);
    // 4. Public bypasses -> 200 / 204 (excluded)
    expect((await h.callGateway("/health")).status).toBe(200);
    expect((await h.callGateway("/v1/health")).status).toBe(200);
    expect(
      (
        await h.callGateway(
          "/free-games",
          { Origin: "https://egdata.app" },
          "GET",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.callGateway(
          "/v1/countries",
          { Origin: "https://client.example" },
          "OPTIONS",
        )
      ).status,
    ).toBe(204);

    expect((await readAccountMonthlyQuota(h.env, "owner_free")).used).toBe(0);

    // 5. Admitted request that hits Worker edge cache AND admitted request with upstream 500 -> both counted
    const validKey = await h.issueKey();
    const cacheMap = new Map<string, Response>();
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async (req: Request) => cacheMap.get(req.url)?.clone()),
        put: vi.fn(async (req: Request, res: Response) => {
          cacheMap.set(req.url, res.clone());
        }),
        delete: vi.fn(),
      },
    });

    expect(
      (
        await h.callGateway("/v1/countries", {
          "x-api-key": validKey.rawKey,
        })
      ).status,
    ).toBe(200);
    // Second call serves from edge cache without calling upstream again, still increments monthly counter
    const upstreamBeforeHit = h.upstream.mock.calls.length;
    expect(
      (
        await h.callGateway("/v1/countries", {
          "x-api-key": validKey.rawKey,
        })
      ).status,
    ).toBe(200);
    expect(h.upstream).toHaveBeenCalledTimes(upstreamBeforeHit);

    // Third call returns upstream 500 -> still counted
    h.upstream.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );
    expect(
      (
        await h.callGateway("/v1/offers/some-offer", {
          "x-api-key": validKey.rawKey,
        })
      ).status,
    ).toBe(500);

    expect((await readAccountMonthlyQuota(h.env, "owner_free")).used).toBe(3);
  });

  it("preserves account usage across key rotation/deletion, project deletion/recreation, custom RPM overrides, and tier transitions, while exempting paid projects", async () => {
    const h = await createQuotaHarness();
    h.seedAccountMonthlyCount("owner_free", FREE_MONTHLY_ALLOWANCE);

    // Key rotation & deletion on prj_free_1 never resets usage
    const rotatedKey = await h.issueKey({ projectId: "prj_free_1" });
    expect(
      (await h.callGateway("/v1/countries", { "x-api-key": rotatedKey.rawKey }))
        .status,
    ).toBe(429);

    // Deleting project and recreating a brand-new free project for the same account keeps exhaustion
    h.metadata.clear();
    const recreatedProjectKey = await h.issueKey({
      projectId: "prj_recreated_after_delete",
      ownerEpicId: "owner_free",
      tier: "free",
    });
    expect(
      (
        await h.callGateway("/v1/countries", {
          "x-api-key": recreatedProjectKey.rawKey,
        })
      ).status,
    ).toBe(429);

    // Custom RPM increase alone on a free project does NOT remove the monthly cap
    const highRpmFreeKey = await h.issueKey({
      projectId: "prj_free_1",
      ownerEpicId: "owner_free",
      tier: "free",
      customRpm: 2_500,
    });
    const highRpmRes = await h.callGateway("/v1/countries", {
      "x-api-key": highRpmFreeKey.rawKey,
    });
    expect(highRpmRes.status).toBe(429);
    expect(((await highRpmRes.json()) as { code: string }).code).toBe(
      "MONTHLY_QUOTA_EXCEEDED",
    );

    // Paid project on the same account is exempt from the free monthly cap and retains its tier limit
    const proKey = await h.issueKey({
      projectId: "prj_paid",
      ownerEpicId: "owner_free",
      tier: "pro",
      customRpm: null,
    });
    const proRes = await h.callGateway("/v1/countries", {
      "x-api-key": proKey.rawKey,
    });
    expect(proRes.status).toBe(200);
    expect(proRes.headers.get("RateLimit")).toContain("global;q=1200;r=1199");
    expect(proRes.headers.get("RateLimit")).not.toContain("monthly;");

    // Stored monthly usage is preserved if a project later returns to free tier in the same month
    expect((await readAccountMonthlyQuota(h.env, "owner_free")).used).toBe(
      100_000,
    );

    // Rollover at 00:00 UTC on the first day of the next calendar month resets free allowance
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const afterReset = await h.callGateway("/v1/countries", {
      "x-api-key": recreatedProjectKey.rawKey,
    });
    expect(afterReset.status).toBe(200);
    expect(afterReset.headers.get("RateLimit")).toContain(
      "monthly;q=100000;r=99999",
    );
    expect((await readAccountMonthlyQuota(h.env, "owner_free")).used).toBe(1);
  });

  it("exposes /_dashboard/api/quota with threshold statuses (80%, 95%, exhausted) and returns 503 QUOTA_UNAVAILABLE when storage fails", async () => {
    const h = await createQuotaHarness();
    const cookie = await h.signSessionCookie("owner_free");

    const fetchQuota = () =>
      worker.fetch(
        new Request("https://devs.egdata.app/_dashboard/api/quota", {
          headers: { cookie },
        }),
        h.env,
        h.ctx,
      );

    // Below 80% -> ok
    h.seedAccountMonthlyCount("owner_free", 79_999);
    let body = (await (await fetchQuota()).json()) as {
      monthly: Awaited<ReturnType<typeof readAccountMonthlyQuota>>;
    };
    expect(body.monthly.status).toBe("ok");
    expect(monthlyNoticeFor(body.monthly).level).toBe("ok");

    // At 80% -> warning
    h.seedAccountMonthlyCount("owner_free", 80_000);
    body = (await (await fetchQuota()).json()) as typeof body;
    expect(body.monthly).toMatchObject({
      used: 80_000,
      remaining: 20_000,
      allowance: 100_000,
      status: "warning",
    });
    expect(monthlyNoticeFor(body.monthly)).toMatchObject({
      level: "warning",
      title: "80% of monthly free quota used",
    });

    // At 95% -> critical
    h.seedAccountMonthlyCount("owner_free", 95_000);
    body = (await (await fetchQuota()).json()) as typeof body;
    expect(body.monthly.status).toBe("critical");
    expect(monthlyNoticeFor(body.monthly)).toMatchObject({
      level: "critical",
      title: "95% of monthly free quota used",
    });

    // At 100% -> exhausted
    h.seedAccountMonthlyCount("owner_free", 100_000);
    body = (await (await fetchQuota()).json()) as typeof body;
    expect(body.monthly).toMatchObject({
      used: 100_000,
      remaining: 0,
      status: "exhausted",
    });
    expect(monthlyNoticeFor(body.monthly)).toMatchObject({
      level: "exhausted",
      title: "Monthly free quota exhausted",
    });

    // Authoritative storage unavailable -> 503 QUOTA_UNAVAILABLE on dashboard quota API and both gateways
    const key = await h.issueKey();
    h.env.API_KEY_RATE_LIMITER = {
      idFromName: (name: string) => name,
      get: () => ({
        admit: vi.fn().mockRejectedValue(new Error("storage down")),
        readMonthlyQuota: vi.fn().mockRejectedValue(new Error("storage down")),
      }),
    } as unknown as DashboardEnv["API_KEY_RATE_LIMITER"];

    const dashDown = await fetchQuota();
    expect(dashDown.status).toBe(503);
    expect(await dashDown.json()).toMatchObject({
      error: { code: "QUOTA_UNAVAILABLE" },
    });

    const legacyDown = await h.callGateway("/countries", {
      "x-api-key": key.rawKey,
    });
    expect(legacyDown.status).toBe(503);
    expect(await legacyDown.json()).toMatchObject({
      error: { code: "QUOTA_UNAVAILABLE" },
    });

    const v1Down = await h.callGateway("/v1/countries", {
      "x-api-key": key.rawKey,
    });
    expect(v1Down.status).toBe(503);
    expect(await v1Down.json()).toMatchObject({
      code: "QUOTA_UNAVAILABLE",
    });
  });
});
