import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { signHmacToken } from "../worker/crypto";
import worker from "../worker/index";
import type { DashboardEnv } from "../worker/types";
import { quotaNamespace } from "./fixtures/quota";
import { sqliteD1 } from "./fixtures/sqlite";

const secret = "dev-controls-test-session-secret";
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function setup(envOverrides: Partial<DashboardEnv> = {}) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`
    INSERT INTO users(epic_account_id, display_name, email)
      VALUES('epic_dev_7da0b3179a5b5ef4f1a2d118', 'EpicDeveloper', 'dev@local.test');
    INSERT INTO projects(id, owner_epic_id, name, slug)
      VALUES('prj_dev_1', 'epic_dev_7da0b3179a5b5ef4f1a2d118', 'Dev Project', 'dev-project');
  `);

  const kvStore = new Map<string, unknown>();
  const env = {
    DB: db,
    API_KEY_RATE_LIMITER: quotaNamespace(),
    DASHBOARD_SESSION_SECRET: secret,
    ENABLE_DEV_AUTH: "true",
    API_KEYS_KV: {
      get: vi.fn(async (id: string) => kvStore.get(id) ?? null),
      put: vi.fn(async (id: string, value: string) => {
        kvStore.set(id, JSON.parse(value));
      }),
      delete: vi.fn(async (id: string) => {
        kvStore.delete(id);
      }),
    },
    ...envOverrides,
  } as unknown as DashboardEnv;

  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    origin = "http://localhost:4002",
  ) {
    const token = await signHmacToken(
      {
        user: {
          epicAccountId: "epic_dev_7da0b3179a5b5ef4f1a2d118",
          displayName: "EpicDeveloper",
          avatarUrl: "",
        },
        exp: Date.now() + 60_000,
        iat: Date.now(),
      },
      secret,
    );
    return worker.fetch(
      new Request(`${origin}/_dashboard/api/dev${path}`, {
        method,
        headers: {
          origin,
          "content-type": "application/json",
          cookie: `egdata_dash_session=${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      context,
    );
  }

  return { sqlite, call };
}

describe("local dev controls routes", () => {
  it("returns 404 outside localhost or when OAuth credentials or disabled flag apply", async () => {
    const prodOrigin = setup();
    expect(
      (await prodOrigin.call("/state", "GET", undefined, "https://devs.egdata.app"))
        .status,
    ).toBe(404);

    const withOAuth = setup({
      EPIC_CLIENT_ID: "client",
      EPIC_CLIENT_SECRET: "secret",
    });
    expect((await withOAuth.call("/state", "GET")).status).toBe(404);

    const disabledDev = setup({ ENABLE_DEV_AUTH: "false" });
    expect((await disabledDev.call("/state", "GET")).status).toBe(404);
  });

  it("seeds sample D1 records idempotently and updates local role/tier/limits", async () => {
    const { call } = setup();

    const seedRes = await call("/seed", "POST");
    expect(seedRes.status).toBe(200);
    expect(await seedRes.json()).toMatchObject({
      ok: true,
      adminGranted: true,
      seededUsers: 3,
    });

    // Idempotent second run
    const seedAgain = await call("/seed", "POST");
    expect(seedAgain.status).toBe(200);

    const patchRes = await call("/state", "PATCH", {
      isAdmin: true,
      projectLimit: 8,
      onboardingVerified: true,
      project: {
        id: "prj_dev_1",
        tier: "scale",
        customRpm: 1200,
        dailyCapMode: "custom",
        dailyCapCustom: 25000,
      },
    });
    expect(patchRes.status).toBe(200);

    const stateRes = await call("/state?projectId=prj_dev_1");
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as {
      isAdmin: boolean;
      projectLimit: number;
      onboardingVerified: boolean;
      seededUserCount: number;
      project: {
        tier: string;
        customRpm: number | null;
        entitlement: {
          rpmLimit: number;
          initialDailyLimit: number | null;
          grantSource: string;
        } | null;
      } | null;
    };
    expect(state.isAdmin).toBe(true);
    expect(state.projectLimit).toBe(8);
    expect(state.onboardingVerified).toBe(true);
    expect(state.seededUserCount).toBe(3);
    expect(state.project?.tier).toBe("scale");
    expect(state.project?.customRpm).toBe(1200);
    expect(state.project?.entitlement).toMatchObject({
      grantSource: "manual",
      rpmLimit: 1200,
      initialDailyLimit: 25000,
    });
  });
});
