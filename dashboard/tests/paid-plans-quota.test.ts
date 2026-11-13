import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateApiKeySecret,
  sha256Hex,
  signHmacToken,
} from "../worker/crypto";
import worker from "../worker/index";
import {
  evaluatePlanEntitlement,
  PLAN_VERSIONS,
  resolveExpensivePeriodBudgetKey,
} from "../worker/plans";
import {
  creditAdmittedRequestUsage,
  readAccountMonthlyQuota,
  readProjectBillingQuota,
  resolveEffectiveProjectEntitlement,
  syncProjectEntitlementToLimiter,
} from "../worker/project-quota";
import {
  applyUsageCredit,
  decideAdmission,
  utcMonthBounds,
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

const DASHBOARD_SECRET = "paid-plans-test-session-secret-min-32-chars";

async function createPaidPlansHarness(options?: {
  commercialLimitsEnabled?: boolean;
}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T12:00:10Z"));

  const { db, sqlite } = sqliteD1();
  sqlite.exec("PRAGMA foreign_keys = ON");

  const migrationFiles = readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    if (file === "0006_project_creation_policy.sql") {
      // Seed multi-project legacy rows before 0006 project-creation cooldown trigger
      sqlite.exec(`
        INSERT INTO users(epic_account_id, display_name)
        VALUES
          ('owner_free', 'Free Owner'),
          ('owner_pro', 'Pro Owner'),
          ('owner_legacy', 'Legacy Owner');
        INSERT INTO projects(id, owner_epic_id, name, slug, tier, custom_rpm)
        VALUES
          ('prj_free_1', 'owner_free', 'Free App 1', 'free-1', 'free', NULL),
          ('prj_free_2', 'owner_free', 'Free App 2', 'free-2', 'free', NULL),
          ('prj_sub', 'owner_pro', 'Subscribed App', 'sub-app', 'free', NULL),
          ('prj_legacy_pro', 'owner_legacy', 'Grandfathered Pro', 'legacy-pro', 'pro', 1500),
          ('prj_legacy_ent', 'owner_legacy', 'Grandfathered Ent', 'legacy-ent', 'enterprise', NULL);
      `);
    }
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
    if (file === "0006_project_creation_policy.sql") {
      sqlite.exec("UPDATE users SET project_limit = 5");
    }
  }

  const kvStore = new Map<string, CachedKeyMetadata>();
  const namespace = quotaNamespace();
  const analyticsWrites: unknown[] = [];

  const env = {
    DB: db,
    DASHBOARD_SESSION_SECRET: DASHBOARD_SECRET,
    DASHBOARD_ORIGIN: "https://devs.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    ORIGIN_AUTH_TOKEN: "origin-secret-token",
    FIRST_PARTY_SERVICE_TOKEN: "trusted-first-party-secret",
    REQUIRE_API_KEY: "true",
    ALLOW_FIRST_PARTY_ORIGINS: "https://egdata.app",
    COMMERCIAL_PLAN_LIMITS_ENABLED: options?.commercialLimitsEnabled
      ? "true"
      : "false",
    RATE_LIMIT_ENVIRONMENT: "test",
    USAGE_TRACKING_ENABLED: "false",
    ANALYTICS: {
      writeDataPoint: vi.fn((point) => analyticsWrites.push(point)),
    },
    API_KEYS_KV: {
      get: vi.fn(async (key: string) => {
        const meta = kvStore.get(key);
        return meta ? { ...meta, cacheExpiresAt: Date.now() + 300_000 } : null;
      }),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, JSON.parse(value) as CachedKeyMetadata);
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
    },
    API_KEY_RATE_LIMITER:
      namespace as unknown as DashboardEnv["API_KEY_RATE_LIMITER"],
  } as unknown as DashboardEnv;

  const upstream = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, items: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, s-maxage=300",
        },
      }),
  );
  vi.stubGlobal("fetch", upstream);

  const pendingWaitUntils: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pendingWaitUntils.push(Promise.resolve(promise).catch(() => {}));
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  async function flushWaitUntils() {
    await Promise.all(pendingWaitUntils.splice(0));
  }

  async function issueKey(options?: {
    projectId?: string;
    ownerEpicId?: string;
    tier?: ApiKeyTier;
    customRpm?: number | null;
    scopes?: CachedKeyMetadata["scopes"];
    entitlementRevision?: number;
  }) {
    const { rawKey } = generateApiKeySecret();
    const meta: CachedKeyMetadata = {
      keyId: `key_${crypto.randomUUID().slice(0, 8)}`,
      projectId: options?.projectId ?? "prj_free_1",
      ownerEpicId: options?.ownerEpicId ?? "owner_free",
      name: "Test Key",
      tier: options?.tier ?? "free",
      customRpm: options?.customRpm ?? null,
      active: true,
      scopes: options?.scopes ?? [
        "catalog:read",
        "offers:read",
        "items:read",
        "builds:read",
        "search:read",
        "graphql:read",
        "profiles:read",
        "stats:read",
      ],
      allowedIps: [],
      allowedOrigins: [],
      allowedPaths: [],
      allowedMethods: ["GET", "HEAD", "POST"],
      expiresAt: null,
      entitlementRevision: options?.entitlementRevision,
    };
    kvStore.set(`apikey:${await sha256Hex(rawKey)}`, meta);
    return { rawKey, meta };
  }

  async function signConsoleSession(ownerEpicId: string, projectId: string) {
    const cookie = await signHmacToken(
      {
        user: {
          epicAccountId: ownerEpicId,
          displayName: ownerEpicId,
          avatarUrl: "",
        },
        iat: Date.now(),
        exp: Date.now() + 86_400_000,
      },
      DASHBOARD_SECRET,
    );
    const consoleToken = await signHmacToken(
      {
        typ: "console_session",
        jti: `cs_${crypto.randomUUID().slice(0, 8)}`,
        ownerEpicId,
        projectId,
        iat: Date.now(),
        exp: Date.now() + 3600_000,
      },
      DASHBOARD_SECRET,
    );
    sqlite.exec(
      `INSERT INTO console_sessions(id, owner_epic_id, project_id, expires_at)
       VALUES('${consoleToken.slice(0, 24)}', '${ownerEpicId}', '${projectId}', '${new Date(Date.now() + 3600_000).toISOString()}')`,
    );
    return {
      cookie: `egdata_dash_session=${cookie}`,
      consoleToken,
    };
  }

  const callGateway = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    body?: string,
  ) =>
    worker.fetch(
      new Request(`https://api.egdata.app${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
      }),
      env,
      ctx,
    );

  return {
    env,
    sqlite,
    namespace,
    kvStore,
    upstream,
    ctx,
    flushWaitUntils,
    issueKey,
    signConsoleSession,
    callGateway,
  };
}

describe("0012 migration & Phase B paid-plans foundations", () => {
  it("applies 0001..0012 with foreign keys ON, backfills grandfathered grants, and supports scale tier", async () => {
    const { db, sqlite } = sqliteD1();
    sqlite.exec("PRAGMA foreign_keys = ON");
    const files = readdirSync("migrations")
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (file === "0006_project_creation_policy.sql") {
        sqlite.exec(`
          INSERT INTO users(epic_account_id, display_name)
          VALUES ('owner_1', 'Owner 1');
          INSERT INTO projects(id, owner_epic_id, name, slug, tier, custom_rpm)
          VALUES
            ('p_free', 'owner_1', 'Free', 'free', 'free', NULL),
            ('p_free_custom', 'owner_1', 'Free Custom RPM', 'free-custom', 'free', 300),
            ('p_pro', 'owner_1', 'Legacy Pro', 'legacy-pro', 'pro', 1200),
            ('p_ent', 'owner_1', 'Legacy Ent', 'legacy-ent', 'enterprise', 8000);
          INSERT INTO limit_requests(id, owner_epic_id, project_id, contact_email, requested_tier, requested_rpm, expected_monthly_requests, use_case)
          VALUES ('lr_1', 'owner_1', 'p_pro', 'dev@example.com', 'pro', 1200, 1000000, 'Price tracker integration');
        `);
      }
      sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
      if (file === "0006_project_creation_policy.sql") {
        sqlite.exec("UPDATE users SET project_limit = 5");
      }
    }

    // Seeded plan_versions exist
    const plans = sqlite
      .prepare(
        "SELECT version_id, rpm_limit, period_allowance, price_eur_cents FROM plan_versions ORDER BY price_eur_cents ASC",
      )
      .all();
    expect(plans).toEqual([
      { version_id: "free-v1", rpm_limit: 60, period_allowance: 100_000, price_eur_cents: 0 },
      { version_id: "pro-v1", rpm_limit: 200, period_allowance: 300_000, price_eur_cents: 900 },
      { version_id: "scale-v1", rpm_limit: 600, period_allowance: 1_000_000, price_eur_cents: 1_900 },
    ]);

    // Existing paid manual rows backfilled into entitlement_grants; free custom_rpm stays on free-v1
    const grants = sqlite
      .prepare(
        "SELECT project_id, source, tier, rpm_limit FROM entitlement_grants ORDER BY project_id ASC",
      )
      .all();
    expect(grants).toEqual([
      { project_id: "p_ent", source: "manual", tier: "enterprise", rpm_limit: 8000 },
      { project_id: "p_pro", source: "manual", tier: "pro", rpm_limit: 1200 },
    ]);

    const freeCustomEnt = await resolveEffectiveProjectEntitlement(
      {
        DB: db,
        COMMERCIAL_PLAN_LIMITS_ENABLED: "true",
      } as unknown as DashboardEnv,
      {
        projectId: "p_free_custom",
        ownerEpicId: "owner_1",
        tier: "free",
        customRpm: 300,
      },
    );
    expect(freeCustomEnt).toMatchObject({
      tier: "free",
      planId: "free",
      planVersionId: "free-v1",
      rpmLimit: 300,
      periodAllowance: 100_000,
      periodType: "calendar_month",
      entitlements: [...PLAN_VERSIONS["free-v1"].entitlements],
    });

    // CHECK constraints accept 'scale' on projects, api_keys, and limit_requests
    sqlite.exec(`
      INSERT INTO users(epic_account_id, display_name) VALUES ('owner_2', 'Owner 2');
      INSERT INTO projects(id, owner_epic_id, name, slug, tier)
      VALUES ('p_scale', 'owner_2', 'Scale App', 'scale-app', 'scale');
      INSERT INTO api_keys(id, project_id, owner_epic_id, name, key_prefix, key_hash, tier)
      VALUES ('k_scale', 'p_scale', 'owner_2', 'Key', 'egk_', 'hash_scale', 'scale');
      INSERT INTO limit_requests(id, owner_epic_id, project_id, contact_email, requested_tier, requested_rpm, expected_monthly_requests, use_case)
      VALUES ('lr_2', 'owner_2', 'p_scale', 'dev@example.com', 'scale', 600, 900000, 'Scale workload');
    `);
    expect(
      sqlite.prepare("SELECT tier FROM projects WHERE id = 'p_scale'").get(),
    ).toEqual({ tier: "scale" });
  });

  it("5.1: preserves unrelated active-window policy counters across mixed sequences and concurrent bursts", async () => {
    const now = Date.UTC(2026, 10, 12, 12, 0, 10);
    // Pure core verification: heavy -> ordinary -> heavy keeps heavy=1 so second heavy is rejected at cap=1
    const heavy1 = decideAdmission({
      now,
      state: null,
      policies: [
        { name: "global", limit: 60, window: "minute" },
        { name: "heavy", limit: 1, window: "minute" },
      ],
    });
    expect(heavy1.result.allowed).toBe(true);
    expect(heavy1.nextState.policyCounts).toEqual({ heavy: 1 });

    const ordinary = decideAdmission({
      now: now + 1000,
      state: heavy1.nextState,
      policies: [{ name: "global", limit: 60, window: "minute" }],
    });
    expect(ordinary.result.allowed).toBe(true);
    expect(ordinary.nextState.policyCounts).toEqual({ heavy: 1 });

    const heavy2 = decideAdmission({
      now: now + 2000,
      state: ordinary.nextState,
      policies: [
        { name: "global", limit: 60, window: "minute" },
        { name: "heavy", limit: 1, window: "minute" },
      ],
    });
    expect(heavy2.result.allowed).toBe(false);
    expect(heavy2.result.exhaustedPolicy).toBe("heavy");

    // Next minute window resets counters cleanly
    const heavyNextMinute = decideAdmission({
      now: now + 60_000,
      state: ordinary.nextState,
      policies: [
        { name: "global", limit: 60, window: "minute" },
        { name: "heavy", limit: 1, window: "minute" },
      ],
    });
    expect(heavyNextMinute.result.allowed).toBe(true);

    // Live gateway verification: 5 offers-list requests allowed on Free, interleaved with ordinary GET, 6th rejected
    const h = await createPaidPlansHarness({ commercialLimitsEnabled: true });
    const { rawKey } = await h.issueKey();

    for (let i = 0; i < 5; i++) {
      expect(
        (await h.callGateway("/v1/offers", { "x-api-key": rawKey })).status,
      ).toBe(200);
      expect(
        (await h.callGateway("/v1/countries", { "x-api-key": rawKey })).status,
      ).toBe(200);
    }

    const denied = await h.callGateway("/v1/offers", { "x-api-key": rawKey });
    expect(denied.status).toBe(429);

    // Concurrent burst against bulk endpoint on a fresh project must cap at 5/min
    const { rawKey: bulkKey } = await h.issueKey({ projectId: "prj_free_2" });
    const burst = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.callGateway(
          "/v1/builds/resolve-launcher-records",
          { "x-api-key": bulkKey, "Content-Type": "application/json" },
          "POST",
          JSON.stringify({ roots: [] }),
        ),
      ),
    );
    expect(burst.filter((res) => res.status === 200)).toHaveLength(5);
    expect(burst.filter((res) => res.status === 429)).toHaveLength(3);
  });

  it("5.2: rejects spoofed Origin bypass across legacy routes and authenticates only with FIRST_PARTY_SERVICE_TOKEN", async () => {
    const h = await createPaidPlansHarness({ commercialLimitsEnabled: true });
    const spoofedRoutes: Array<{ path: string; method: string; body?: string }> =
      [
        { path: "/offers/123", method: "GET" },
        { path: "/graphql", method: "POST", body: '{"query":"{ __typename }"}' },
        {
          path: "/search/natural-language",
          method: "POST",
          body: '{"query":"rpg"}',
        },
        { path: "/catalog/items", method: "GET" },
      ];

    for (const route of spoofedRoutes) {
      const spoofed = await h.callGateway(
        route.path,
        { Origin: "https://egdata.app" },
        route.method,
        route.body,
      );
      expect(spoofed.status).toBe(401);
      expect(await spoofed.json()).toMatchObject({
        error: { code: "MISSING_API_KEY" },
      });
    }

    // Trusted first-party service token succeeds without consuming developer quota
    const trusted = await h.callGateway("/offers/123", {
      Origin: "https://egdata.app",
      "X-Egdata-First-Party-Token": "trusted-first-party-secret",
    });
    expect(trusted.status).toBe(200);
    const lastCall = h.upstream.mock.calls.at(-1) as [Request] | undefined;
    const forwardedHeaders = lastCall?.[0]
      ? new Request(lastCall[0]).headers
      : new Headers();
    expect(forwardedHeaders.get("x-egdata-first-party-token")).toBeNull();
    expect((await readAccountMonthlyQuota(h.env, "owner_free")).used).toBe(0);
  });

  it("5.3: separates catalog:read scope from feature scopes & enforces plan entitlements before cache or quota debit", async () => {
    const h = await createPaidPlansHarness({ commercialLimitsEnabled: true });
    const { rawKey } = await h.issueKey({ scopes: ["catalog:read"] });

    for (const route of [
      { path: "/v1/offers", method: "GET", isV1: true },
      { path: "/v1/search", method: "GET", isV1: true },
      {
        path: "/graphql",
        method: "POST",
        body: '{"query":"{ __typename }"}',
        isV1: false,
      },
    ]) {
      const res = await h.callGateway(
        route.path,
        { "x-api-key": rawKey },
        route.method,
        route.body,
      );
      expect(res.status).toBe(403);
      if (route.isV1) {
        expect(await res.json()).toMatchObject({ code: "SCOPE_DENIED" });
      } else {
        expect(await res.json()).toMatchObject({
          error: { code: "SCOPE_DENIED" },
        });
      }
    }
    expect((await readAccountMonthlyQuota(h.env, "owner_free")).used).toBe(0);

    // Explicitly restrict prj_free_2 entitlements to prove 403 PLAN_ENTITLEMENT_REQUIRED runs before cache/quota
    h.sqlite.exec(`
      INSERT INTO entitlement_grants(
        id, project_id, owner_epic_id, source, plan_id, plan_version_id,
        tier, rpm_limit, period_allowance, expensive_limits_json, effective_from, revision
      ) VALUES (
        'grant_restricted', 'prj_free_2', 'owner_free', 'manual', 'free', 'free-v1',
        'free', 60, 100000,
        '{"entitlements":["catalog:ordinary"]}',
        0, 9999999999999
      );
    `);

    const mockCacheMatch = vi.fn(
      async () => new Response('{"cached":true}', { status: 200 }),
    );
    vi.stubGlobal("caches", {
      default: {
        match: mockCacheMatch,
        put: vi.fn(),
        delete: vi.fn(),
      },
    });

    const { rawKey: unrestrictedKey } = await h.issueKey({
      projectId: "prj_free_2",
      scopes: ["search:read"],
    });
    const nlRes = await h.callGateway(
      "/v1/search/natural-language",
      { "x-api-key": unrestrictedKey, "Content-Type": "application/json" },
      "POST",
      JSON.stringify({ query: "indie" }),
    );
    expect(nlRes.status).toBe(403);
    expect(await nlRes.json()).toMatchObject({
      code: "PLAN_ENTITLEMENT_REQUIRED",
    });
    expect(mockCacheMatch).not.toHaveBeenCalled();
    expect((await readAccountMonthlyQuota(h.env, "owner_free")).used).toBe(0);

    // Whole-catalog replication requires explicit 'replication:export' even on paid tiers
    expect(
      evaluatePlanEntitlement(
        {
          projectId: "prj_sub",
          ownerEpicId: "owner_pro",
          planId: "scale",
          planVersionId: "scale-v1",
          tier: "scale",
          grantSource: "subscription",
          revision: 1,
          rpmLimit: 600,
          periodAllowance: 1_000_000,
          periodType: "billing_period",
          periodStart: Date.UTC(2026, 10, 1),
          periodEnd: Date.UTC(2026, 11, 1),
          expensiveMinuteLimits: { ...PLAN_VERSIONS["scale-v1"].expensiveMinuteLimits },
          expensivePeriodBudgets: { ...PLAN_VERSIONS["scale-v1"].expensivePeriodBudgets },
          entitlements: [...PLAN_VERSIONS["scale-v1"].entitlements],
          status: "active",
          graceUntil: null,
          cancelAtPeriodEnd: false,
          subscriptionId: "sub_1",
          reason: null,
        },
        { pathname: "/v1/export/offers", method: "GET" },
      ).allowed,
    ).toBe(false);
    expect(
      resolveExpensivePeriodBudgetKey("/v1/search/natural-language", "POST"),
    ).toBe("nl-search");
  });

  it("5.4 & 5.5: enforces commercial Free/Pro/Scale budgets, billing period rollover, within-period upgrades, stale KV safety, and idempotent 5xx credit", async () => {
    const h = await createPaidPlansHarness({ commercialLimitsEnabled: true });

    const periodStart = Date.UTC(2026, 10, 10, 0, 0, 0);
    const periodEnd = Date.UTC(2026, 11, 10, 0, 0, 0);

    h.sqlite.exec(`
      UPDATE projects SET tier = 'pro' WHERE id = 'prj_sub';
      INSERT INTO billing_subscriptions(
        id, owner_epic_id, project_id, environment, stripe_customer_id,
        stripe_subscription_id, plan_version_id, status,
        current_period_start, current_period_end, cancel_at_period_end
      ) VALUES (
        'sub_pro_1', 'owner_pro', 'prj_sub', 'test', 'cus_pro',
        'sub_stripe_pro', 'pro-v1', 'active',
        ${periodStart}, ${periodEnd}, 0
      );
      INSERT INTO entitlement_grants(
        id, project_id, owner_epic_id, source, plan_id, plan_version_id,
        tier, rpm_limit, period_allowance, expensive_limits_json,
        effective_from, revision, subscription_id, reason
      ) VALUES (
        'grant_pro_1', 'prj_sub', 'owner_pro', 'subscription', 'pro', 'pro-v1',
        'pro', 200, 300000,
        '${JSON.stringify({
          minute: PLAN_VERSIONS["pro-v1"].expensiveMinuteLimits,
          period: PLAN_VERSIONS["pro-v1"].expensivePeriodBudgets,
          entitlements: PLAN_VERSIONS["pro-v1"].entitlements,
        })}',
        ${periodStart}, 1000, 'sub_pro_1', 'Pro subscription active'
      );
    `);

    const proEntitlement = await resolveEffectiveProjectEntitlement(h.env, {
      projectId: "prj_sub",
      ownerEpicId: "owner_pro",
      tier: "pro",
      customRpm: null,
    });
    expect(proEntitlement.rpmLimit).toBe(200);
    expect(proEntitlement.periodAllowance).toBe(300_000);
    expect(proEntitlement.expensiveMinuteLimits["offers-list"]).toBe(20);
    await syncProjectEntitlementToLimiter(h.env, proEntitlement);

    // Grandfathered legacy Pro retains custom 1,500 RPM instead of being forced to 200 RPM
    const legacyEnt = await resolveEffectiveProjectEntitlement(h.env, {
      projectId: "prj_legacy_pro",
      ownerEpicId: "owner_legacy",
      tier: "pro",
      customRpm: 1500,
    });
    expect(legacyEnt.grantSource).toBe("manual");
    expect(legacyEnt.rpmLimit).toBe(1500);

    // Paid Pro requests track in billing-period state without touching Free monthly quota
    const { rawKey: proKey, meta: proMeta } = await h.issueKey({
      projectId: "prj_sub",
      ownerEpicId: "owner_pro",
      tier: "pro",
      entitlementRevision: 1000,
    });

    const okPro = await h.callGateway("/v1/search/natural-language", {
      "x-api-key": proKey,
      "Content-Type": "application/json",
    }, "POST", JSON.stringify({ query: "action" }));
    expect(okPro.status).toBe(200);
    expect(okPro.headers.get("RateLimit")).toContain("global;q=200;r=199");
    expect(okPro.headers.get("RateLimit")).toContain("period;q=300000;r=299999");

    const usageAfterOne = await readProjectBillingQuota(
      h.env,
      "owner_pro",
      "prj_sub",
      300_000,
      periodStart,
      periodEnd,
    );
    expect(usageAfterOne?.used).toBe(1);
    expect(usageAfterOne?.policyCounts["nl-search-period"]).toBe(1);

    // Exhaust Pro NL period budget (2,500) via DO period counter and confirm 429 EXPENSIVE_BUDGET_EXCEEDED
    const doStub = h.namespace.get("account:test:owner_pro");
    (
      doStub as unknown as {
        ctx: { storage: { sql: { exec: (...args: unknown[]) => unknown } } };
      }
    ).ctx.storage.sql.exec(
      `UPDATE project_period_state SET policies_json = ? WHERE project_id = 'prj_sub'`,
      JSON.stringify({ "nl-search-period": 2500 }),
    );
    const nlExhausted = await h.callGateway(
      "/v1/search/natural-language",
      { "x-api-key": proKey, "Content-Type": "application/json" },
      "POST",
      JSON.stringify({ query: "rpg" }),
    );
    expect(nlExhausted.status).toBe(429);
    expect(await nlExhausted.json()).toMatchObject({
      code: "EXPENSIVE_BUDGET_EXCEEDED",
    });

    // Upstream 500 credits period unit back once, idempotently (replay cannot double-credit or go negative)
    h.upstream.mockResolvedValueOnce(new Response("Upstream err", { status: 500 }));
    const errRes = await h.callGateway("/v1/countries", { "x-api-key": proKey });
    expect(errRes.status).toBe(500);
    await h.flushWaitUntils();
    const after5xx = await readProjectBillingQuota(
      h.env,
      "owner_pro",
      "prj_sub",
      300_000,
      periodStart,
      periodEnd,
    );
    expect(after5xx?.used).toBe(1);

    // Replay same credit adjustment ID directly -> still used = 1 (idempotent)
    await creditAdmittedRequestUsage(h.env, {
      adjustmentId: "manual_credit_replay_1",
      ownerEpicId: "owner_pro",
      projectId: "prj_sub",
      entitlement: proEntitlement,
      reason: "test_replay",
    });
    await creditAdmittedRequestUsage(h.env, {
      adjustmentId: "manual_credit_replay_1",
      ownerEpicId: "owner_pro",
      projectId: "prj_sub",
      entitlement: proEntitlement,
      reason: "test_replay",
    });
    await creditAdmittedRequestUsage(h.env, {
      adjustmentId: "manual_credit_replay_2",
      ownerEpicId: "owner_pro",
      projectId: "prj_sub",
      entitlement: proEntitlement,
      reason: "floor_check",
    });
    const afterFloor = await readProjectBillingQuota(
      h.env,
      "owner_pro",
      "prj_sub",
      300_000,
      periodStart,
      periodEnd,
    );
    expect(afterFloor?.used).toBe(0);
    expect(applyUsageCredit(1, 5)).toBe(0);

    // Within-period upgrade Pro -> Scale preserves consumed period count and lifts caps to 600 RPM / 1,000,000
    (
      doStub as unknown as {
        ctx: { storage: { sql: { exec: (...args: unknown[]) => unknown } } };
      }
    ).ctx.storage.sql.exec(
      `UPDATE project_period_state SET used_count = 12345 WHERE project_id = 'prj_sub'`,
    );
    h.sqlite.exec(`
      UPDATE billing_subscriptions SET plan_version_id = 'scale-v1' WHERE id = 'sub_pro_1';
      UPDATE entitlement_grants
         SET plan_id = 'scale', plan_version_id = 'scale-v1', tier = 'scale',
             rpm_limit = 600, period_allowance = 1000000,
             expensive_limits_json = '${JSON.stringify({
               minute: PLAN_VERSIONS["scale-v1"].expensiveMinuteLimits,
               period: PLAN_VERSIONS["scale-v1"].expensivePeriodBudgets,
               entitlements: PLAN_VERSIONS["scale-v1"].entitlements,
             })}',
             revision = 2000
       WHERE id = 'grant_pro_1';
      UPDATE projects SET tier = 'scale' WHERE id = 'prj_sub';
    `);
    const scaleEnt = await resolveEffectiveProjectEntitlement(h.env, {
      ...proMeta,
      tier: "scale",
    });
    await syncProjectEntitlementToLimiter(h.env, scaleEnt);
    const scaleRes = await h.callGateway("/v1/countries", { "x-api-key": proKey });
    expect(scaleRes.status).toBe(200);
    expect(scaleRes.headers.get("RateLimit")).toContain("global;q=600;");
    expect(scaleRes.headers.get("RateLimit")).toContain("period;q=1000000;r=987654");

    // Stale KV metadata still says tier='pro', but D1/DO revocation after cancel reverts capacity immediately to Free (60 RPM)
    h.sqlite.exec(`
      UPDATE billing_subscriptions SET status = 'canceled', current_period_end = ${Date.now() - 1000} WHERE id = 'sub_pro_1';
      UPDATE entitlement_grants SET revoked_at = ${Date.now()} WHERE id = 'grant_pro_1';
      UPDATE projects SET tier = 'free' WHERE id = 'prj_sub';
    `);
    expect(proMeta.tier).toBe("pro");
    const syncedFree = await resolveEffectiveProjectEntitlement(h.env, proMeta);
    await syncProjectEntitlementToLimiter(h.env, syncedFree);
    const reverted = await h.callGateway("/v1/countries", { "x-api-key": proKey });
    expect(reverted.status).toBe(200);
    expect(reverted.headers.get("RateLimit")).toContain("global;q=60;");
    expect(reverted.headers.get("RateLimit")).toContain("monthly;q=100000;");

    // Next UTC month boundary for Free account resets monthly counter
    vi.setSystemTime(new Date("2026-12-01T00:00:05Z"));
    expect(utcMonthBounds(Date.now()).monthStart).toBe(Date.UTC(2026, 11, 1));
    expect((await readAccountMonthlyQuota(h.env, "owner_pro")).used).toBe(0);
  });

  it("operator bonus credits increase period and monthly allowances even when used is zero", async () => {
    const h = await createPaidPlansHarness({ commercialLimitsEnabled: true });

    const periodStart = Date.UTC(2026, 10, 10, 0, 0, 0);
    const periodEnd = Date.UTC(2026, 11, 10, 0, 0, 0);
    const { rawKey, meta } = await h.issueKey({
      projectId: "prj_sub",
      ownerEpicId: "owner_pro",
      tier: "pro",
    });

    h.sqlite.exec(`
      UPDATE projects SET tier = 'pro' WHERE id = 'prj_sub';
      INSERT INTO billing_customers(owner_epic_id, environment, stripe_customer_id)
      VALUES ('owner_pro', 'test', 'cus_bonus_pro');
      INSERT INTO billing_subscriptions(
        id, owner_epic_id, project_id, stripe_customer_id, stripe_subscription_id,
        plan_version_id, status, current_period_start, current_period_end
      ) VALUES (
        'sub_bonus_1', 'owner_pro', 'prj_sub', 'cus_bonus_pro', 'sub_stripe_bonus_1',
        'pro-v1', 'active', ${periodStart}, ${periodEnd}
      );
      INSERT INTO entitlement_grants(
        id, project_id, owner_epic_id, source, plan_id, plan_version_id, tier,
        rpm_limit, period_allowance, expensive_limits_json, effective_from, effective_until,
        revision, subscription_id, granted_by, reason
      ) VALUES (
        'grant_bonus_1', 'prj_sub', 'owner_pro', 'subscription', 'pro', 'pro-v1', 'pro',
        200, 300000, '${JSON.stringify({
          minute: PLAN_VERSIONS["pro-v1"].expensiveMinuteLimits,
          period: PLAN_VERSIONS["pro-v1"].expensivePeriodBudgets,
          entitlements: PLAN_VERSIONS["pro-v1"].entitlements,
        })}', ${periodStart}, ${periodEnd}, 100, 'sub_bonus_1', 'stripe_webhook', 'Pro sub'
      );
    `);

    const ent = await resolveEffectiveProjectEntitlement(h.env, meta);
    await syncProjectEntitlementToLimiter(h.env, ent);

    // Before any API traffic, credit 10,000 + 1,000,000 bonus requests via DO creditUsage
    const stub = h.namespace.get("account:test:owner_pro") as unknown as {
      creditUsage: (params: Record<string, unknown>) => Promise<{
        applied: boolean;
        remainingUsed: number;
        bonus?: number;
      }>;
    };
    const r1 = await stub.creditUsage({
      adjustmentId: "adj_bonus_1",
      ownerEpicId: "owner_pro",
      projectId: "prj_sub",
      scope: "period",
      windowStart: periodStart,
      periodEnd,
      amount: 10_000,
      reason: "Test 10k",
      mode: "bonus",
    });
    expect(r1).toEqual({ applied: true, remainingUsed: 0, bonus: 10_000 });

    const r2 = await stub.creditUsage({
      adjustmentId: "adj_bonus_2",
      ownerEpicId: "owner_pro",
      projectId: "prj_sub",
      scope: "period",
      windowStart: periodStart,
      periodEnd,
      amount: 1_000_000,
      reason: "Test 1M",
      mode: "bonus",
    });
    expect(r2).toEqual({ applied: true, remainingUsed: 0, bonus: 1_010_000 });

    // Replay is idempotent
    const r2Replay = await stub.creditUsage({
      adjustmentId: "adj_bonus_2",
      ownerEpicId: "owner_pro",
      projectId: "prj_sub",
      scope: "period",
      windowStart: periodStart,
      periodEnd,
      amount: 1_000_000,
      reason: "Test 1M",
      mode: "bonus",
    });
    expect(r2Replay.applied).toBe(false);
    expect(r2Replay.bonus).toBe(1_010_000);

    const periodQuota = await readProjectBillingQuota(
      h.env,
      "owner_pro",
      "prj_sub",
      300_000,
      periodStart,
      periodEnd,
    );
    expect(periodQuota).toMatchObject({
      used: 0,
      allowance: 1_310_000,
      remaining: 1_310_000,
      bonus: 1_010_000,
    });

    // Live gateway request enforces elevated 1,310,000 period limit
    const res = await h.callGateway("/v1/countries", { "x-api-key": rawKey });
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit")).toContain("period;q=1310000;r=1309999");

    // Monthly bonus on free-tier quota also expands allowance before any usage
    const monthStart = utcMonthBounds(Date.now()).monthStart;
    await stub.creditUsage({
      adjustmentId: "adj_month_bonus_1",
      ownerEpicId: "owner_pro",
      scope: "month",
      windowStart: monthStart,
      amount: 50_000,
      reason: "Free tier boost",
      mode: "bonus",
    });
    const monthly = await readAccountMonthlyQuota(h.env, "owner_pro");
    expect(monthly.used).toBe(0);
    expect(monthly.allowance).toBe(150_000);
    expect(monthly.remaining).toBe(150_000);
  });
});
