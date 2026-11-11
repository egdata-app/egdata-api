import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./fixtures/sqlite";
import { signHmacToken, verifyHmacToken } from "../worker/crypto";
import {
  readDashboardSession,
  issueDashboardSessionCookie,
  startEpicOAuthRedirect,
  type AuthHonoEnv,
} from "../worker/epic-auth";
import {
  invalidateLocalKeyCache,
  resolveApiKeyMetadata,
  syncKeyToKv,
} from "../worker/key-cache";
import { insertLimitRequest } from "../worker/db";
import type { CachedKeyMetadata, DashboardEnv } from "../worker/types";
import worker from "../worker/index";
import { sendLimitIncreaseRequestEmail } from "../worker/email";

vi.mock("../worker/email", () => ({
  sendLimitIncreaseRequestEmail: vi.fn(async () => ({ status: "sent" })),
}));

const secret = "test-session-signing-secret-32-characters";
const user = {
  epicAccountId: "owner",
  displayName: "Owner",
  avatarUrl: "",
  preferredLanguage: "en",
  email: "owner@example.com",
};
function database() {
  const result = sqliteD1();
  result.sqlite.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  result.sqlite.exec(
    "INSERT INTO users(epic_account_id,display_name) VALUES('owner','Owner'); INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('project','owner','Project','project');",
  );
  return result;
}
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("dashboard authentication boundaries", () => {
  it("rejects the public fallback signature on deployed hosts, even with dev auth enabled", async () => {
    const token = await signHmacToken(
      { user, exp: Date.now() + 60_000, iat: Date.now() },
      "egdata-local-dev-session-secret-change-in-prod-32b",
    );
    const app = new Hono<AuthHonoEnv>();
    app.onError(() => new Response("Not configured", { status: 503 }));
    app.get("/", async (c) => c.json(await readDashboardSession(c)));
    for (const configured of [undefined, "short"]) {
      const res = await app.request(
        "https://devs.egdata.app/",
        { headers: { cookie: `egdata_dash_session=${token}` } },
        {
          DASHBOARD_SESSION_SECRET: configured,
          ENABLE_DEV_AUTH: "true",
        } as DashboardEnv,
      );
      expect(res.status).toBe(503);
    }
    const res = await app.request(
      "https://devs.egdata.app/",
      { headers: { cookie: `egdata_dash_session=${token}` } },
      { DASHBOARD_SESSION_SECRET: secret } as DashboardEnv,
    );
    expect(await res.json()).toBeNull();
  });
  it("issues valid sessions with a configured secret and restricts demo login to explicit localhost development", async () => {
    const app = new Hono<AuthHonoEnv>();
    app.get("/session", async (c) => {
      await issueDashboardSessionCookie(c, user);
      return c.text("ok");
    });
    app.get("/login", startEpicOAuthRedirect);
    const env = {
      DASHBOARD_SESSION_SECRET: secret,
      ENABLE_DEV_AUTH: "true",
    } as DashboardEnv;
    const res = await app.request("https://devs.egdata.app/session", {}, env);
    expect(res.headers.get("set-cookie")).toContain("Secure");
    const token = res.headers.get("set-cookie")!.split(";")[0].split("=")[1];
    expect(
      await verifyHmacToken(decodeURIComponent(token), secret),
    ).toMatchObject({ user });
    expect(
      (await app.request("https://devs.egdata.app/login", {}, env)).status,
    ).toBe(503);
    expect(
      (await app.request("http://localhost/login", {}, {} as DashboardEnv))
        .status,
    ).toBe(503);
  });
  it.each([
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "https://evil.example",
  ])("rejects unsafe post-login redirect %s", async (redirect) => {
    const { db } = database();
    const app = new Hono<AuthHonoEnv>();
    app.get("/login", startEpicOAuthRedirect);
    const res = await app.request(
      `http://localhost/login?redirect=${encodeURIComponent(redirect)}`,
      {},
      { DB: db, ENABLE_DEV_AUTH: "true" } as DashboardEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("bounded API key caching", () => {
  it("expires delayed backfills after revocation, including memory and stale KV reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
    const { db, sqlite } = database();
    const hash = crypto.randomUUID();
    sqlite
      .prepare(
        "INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash) VALUES('key','project','owner','Key','egk',?)",
      )
      .run(hash);
    let cached: any = null;
    const writes: Array<() => void> = [];
    const put = vi.fn(async (_key: string, value: string) => {
      writes.push(() => {
        cached = JSON.parse(value);
      });
    });
    const env = {
      DB: db,
      API_KEYS_KV: { get: async () => cached, put },
    } as unknown as DashboardEnv;
    expect((await resolveApiKeyMetadata(env, context, hash))?.active).toBe(
      true,
    );
    sqlite.exec(
      "UPDATE api_keys SET active=0, revoked_at='2026-11-11T10:00:01Z'",
    );
    writes[0](); // Delayed old write lands after revocation.
    expect(put.mock.calls[0]).toHaveLength(3);
    vi.advanceTimersByTime(300_001);
    expect(await resolveApiKeyMetadata(env, context, hash)).toBeNull();
    invalidateLocalKeyCache(hash);
  });
  it("puts an absolute expiration on explicit updates and refuses old unbounded KV entries", async () => {
    const { db } = database();
    const hash = crypto.randomUUID();
    const meta = { keyId: "missing", active: true } as CachedKeyMetadata;
    const put = vi.fn(
      async (
        _key: string,
        _value: string,
        _options: KVNamespacePutOptions,
      ) => {},
    );
    const env = {
      DB: db,
      API_KEYS_KV: { get: async () => meta, put },
    } as unknown as DashboardEnv;
    expect(await resolveApiKeyMetadata(env, context, hash)).toBeNull();
    await syncKeyToKv(env, hash, meta);
    expect(put.mock.calls[0][2]).toMatchObject({
      expiration: expect.any(Number),
    });
    invalidateLocalKeyCache(hash);
  });
});

describe("limit request admission", () => {
  const input = {
    ownerEpicId: "owner",
    projectId: "project",
    contactEmail: "owner@example.com",
    requestedTier: "pro" as const,
    requestedRpm: 1200,
    expectedMonthlyRequests: 100000,
    useCase: "A sufficiently detailed integration description.",
    websiteUrl: "",
    emailDeliveryStatus: "queued",
  };
  it("atomically admits one pending request and at most three requests per owner per day", async () => {
    const { db, sqlite } = database();
    const concurrent = await Promise.all([
      insertLimitRequest(db, input),
      insertLimitRequest(db, input),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      sqlite.exec("UPDATE limit_requests SET status='approved'");
      expect(await insertLimitRequest(db, input)).not.toBeNull();
    }
    sqlite.exec("UPDATE limit_requests SET status='approved'");
    expect(await insertLimitRequest(db, input)).toBeNull();
  });
  it("rejects foreign-origin mutations and sends only the persisted request ID", async () => {
    const { db, sqlite } = database();
    const env = { DB: db, DASHBOARD_SESSION_SECRET: secret } as DashboardEnv;
    const token = await signHmacToken(
      { user, exp: Date.now() + 60_000, iat: Date.now() },
      secret,
    );
    const request = (origin: string) =>
      new Request("https://devs.egdata.app/_dashboard/api/limit-requests", {
        method: "POST",
        headers: {
          origin,
          cookie: `egdata_dash_session=${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    expect(
      (await worker.fetch(request("https://evil.example"), env, context))
        .status,
    ).toBe(403);
    const res = await worker.fetch(
      request("https://devs.egdata.app"),
      env,
      context,
    );
    expect(res.status).toBe(201);
    const result = (await res.json()) as any;
    expect(sendLimitIncreaseRequestEmail).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ requestId: result.request.id }),
    );
    expect(
      sqlite
        .prepare("SELECT id, email_delivery_status FROM limit_requests")
        .get(),
    ).toMatchObject({ id: result.request.id, email_delivery_status: "sent" });
    expect(
      (await worker.fetch(request("https://devs.egdata.app"), env, context))
        .status,
    ).toBe(429);
    expect(sendLimitIncreaseRequestEmail).toHaveBeenCalledTimes(1);
  });
});
