import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signHmacToken } from "../worker/crypto";
import {
  FEATURE_FLAG_KEYS,
  isPaidPlansEnabled,
  resolveCommercialLimitsEnabled,
  resolveFeatureFlags,
} from "../worker/flags";
import worker from "../worker/index";
import type { DashboardEnv } from "../worker/types";
import { quotaNamespace } from "./fixtures/quota";
import { sqliteD1 } from "./fixtures/sqlite";

afterEach(() => {
  vi.restoreAllMocks();
});

const DASHBOARD_ORIGIN = "https://devs.egdata.app";
const DASHBOARD_SECRET = "flagship-pause-test-session-secret-32c";

async function createFlagshipTestHarness(options?: {
  flags?: Pick<Flagship, "getBooleanValue">;
  paidPlansEnv?: string;
  commercialLimitsEnv?: string;
}) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }

  sqlite.exec(`
    INSERT INTO users(epic_account_id, display_name, email, project_limit)
    VALUES
      ('owner_1', 'Owner One', 'owner1@example.com', 5),
      ('admin_1', 'Admin One', 'admin@egdata.app', 5);
    INSERT INTO user_roles(user_id, role)
    VALUES ('admin_1', 'admin');
    INSERT INTO projects(id, owner_epic_id, name, slug, tier)
    VALUES ('prj_1', 'owner_1', 'Primary App', 'primary-app', 'free');
    INSERT INTO developer_profiles(owner_id, contact_email, verified_at)
    VALUES
      ('owner_1', 'owner1@example.com', 1000),
      ('admin_1', 'admin@egdata.app', 1000);
  `);

  const env = {
    DB: db,
    FLAGS: options?.flags,
    DASHBOARD_SESSION_SECRET: DASHBOARD_SECRET,
    DASHBOARD_ORIGIN,
    API_PROXY_HOST: "api.egdata.app",
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    ORIGIN_AUTH_TOKEN: "origin-secret-token",
    RATE_LIMIT_ENVIRONMENT: "staging",
    PAID_PLANS_ENABLED: options?.paidPlansEnv,
    COMMERCIAL_PLAN_LIMITS_ENABLED: options?.commercialLimitsEnv,
    API_KEY_RATE_LIMITER:
      quotaNamespace() as unknown as DashboardEnv["API_KEY_RATE_LIMITER"],
  } as unknown as DashboardEnv;

  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  async function cookieFor(epicAccountId: string) {
    const token = await signHmacToken(
      {
        user: {
          epicAccountId,
          displayName: epicAccountId,
          avatarUrl: "",
          isAdmin: epicAccountId === "admin_1",
        },
        iat: Date.now(),
        exp: Date.now() + 86_400_000,
      },
      DASHBOARD_SECRET,
    );
    return `egdata_dash_session=${token}`;
  }

  return { env, ctx, cookieFor, sqlite };
}

describe("Cloudflare Flagship pause and targeting", () => {
  it("defaults paidPlans and commercialLimits to false when unconfigured", async () => {
    const { env } = await createFlagshipTestHarness();
    expect(await isPaidPlansEnabled(env)).toBe(false);
    expect(await resolveCommercialLimitsEnabled(env)).toBe(false);
    expect(await resolveFeatureFlags(env)).toEqual({
      paidPlans: false,
      commercialLimits: false,
    });
  });

  it("pauses all paid-plan endpoints and advertises disabled flags in session when Flagship returns false", async () => {
    const getBooleanValue = vi.fn(async () => false);
    const { env, ctx, cookieFor } = await createFlagshipTestHarness({
      flags: { getBooleanValue },
    });
    const cookie = await cookieFor("owner_1");

    const anonSessionRes = await worker.fetch(
      new Request(`${DASHBOARD_ORIGIN}/_dashboard/api/auth/session`),
      env,
      ctx,
    );
    expect(anonSessionRes.status).toBe(200);
    const anonSession = (await anonSessionRes.json()) as {
      authenticated: boolean;
      features: { paidPlans: boolean; commercialLimits: boolean };
    };
    expect(anonSession.authenticated).toBe(false);
    expect(anonSession.features).toEqual({
      paidPlans: false,
      commercialLimits: false,
    });

    const authSessionRes = await worker.fetch(
      new Request(`${DASHBOARD_ORIGIN}/_dashboard/api/auth/session`, {
        headers: { Cookie: cookie },
      }),
      env,
      ctx,
    );
    expect(authSessionRes.status).toBe(200);
    const authSession = (await authSessionRes.json()) as {
      authenticated: boolean;
      features: { paidPlans: boolean; commercialLimits: boolean };
    };
    expect(authSession.authenticated).toBe(true);
    expect(authSession.features).toEqual({
      paidPlans: false,
      commercialLimits: false,
    });

    for (const [method, path] of [
      ["GET", "/_dashboard/api/billing/plans"],
      ["POST", "/_dashboard/api/billing/checkout"],
      ["POST", "/_dashboard/api/billing/portal"],
      ["GET", "/_dashboard/api/billing/receipts"],
      ["GET", "/_dashboard/api/projects/prj_1/billing"],
      ["GET", "/_dashboard/api/projects/prj_1/entitlements"],
      ["GET", "/_dashboard/api/projects/prj_1/usage"],
    ] as const) {
      const res = await worker.fetch(
        new Request(`${DASHBOARD_ORIGIN}${path}`, {
          method,
          headers: {
            Cookie: cookie,
            ...(method !== "GET" ? { Origin: DASHBOARD_ORIGIN } : {}),
          },
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PAID_PLANS_PAUSED");
    }

    expect(getBooleanValue).toHaveBeenCalledWith(
      FEATURE_FLAG_KEYS.paidPlans,
      false,
      expect.objectContaining({
        targetingKey: "owner_1",
        userId: "owner_1",
        environment: "staging",
        isAdmin: false,
      }),
    );
  });

  it("supports per-user Cloudflare Flagship targeting while failing closed when Flagship errors", async () => {
    const getBooleanValue = vi.fn(
      async (
        key: string,
        defaultValue: boolean,
        context?: FlagshipEvaluationContext,
      ) => {
        if (context?.isAdmin === true && key === FEATURE_FLAG_KEYS.paidPlans) {
          return true;
        }
        return defaultValue;
      },
    );
    const { env, ctx, cookieFor } = await createFlagshipTestHarness({
      flags: { getBooleanValue },
    });

    const ownerCookie = await cookieFor("owner_1");
    const adminCookie = await cookieFor("admin_1");

    const ownerPlansRes = await worker.fetch(
      new Request(`${DASHBOARD_ORIGIN}/_dashboard/api/billing/plans`, {
        headers: { Cookie: ownerCookie },
      }),
      env,
      ctx,
    );
    expect(ownerPlansRes.status).toBe(404);

    const adminPlansRes = await worker.fetch(
      new Request(`${DASHBOARD_ORIGIN}/_dashboard/api/billing/plans`, {
        headers: { Cookie: adminCookie },
      }),
      env,
      ctx,
    );
    expect(adminPlansRes.status).toBe(200);
    const plansBody = (await adminPlansRes.json()) as { plans: unknown[] };
    expect(plansBody.plans).toHaveLength(3);

    // Flagship runtime error fails closed to false
    const failingEnv = {
      ...env,
      FLAGS: {
        getBooleanValue: vi.fn(async () => {
          throw new Error("flagship unavailable");
        }),
      },
    } as unknown as DashboardEnv;
    expect(await isPaidPlansEnabled(failingEnv)).toBe(false);
    expect(await resolveCommercialLimitsEnabled(failingEnv)).toBe(false);
  });
});
