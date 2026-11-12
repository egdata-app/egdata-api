import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  signHmacToken,
  timingSafeStringEqual,
  verifyHmacToken,
} from "../worker/crypto";
import { insertLimitRequest } from "../worker/db";
import { sendLimitIncreaseRequestEmail } from "../worker/email";
import {
  type AuthHonoEnv,
  issueDashboardSessionCookie,
  readDashboardSession,
  startEpicOAuthRedirect,
} from "../worker/epic-auth";
import worker from "../worker/index";
import {
  invalidateLocalKeyCache,
  resolveApiKeyMetadata,
  syncKeyToKv,
} from "../worker/key-cache";
import type { CachedKeyMetadata, DashboardEnv } from "../worker/types";
import { sqliteD1 } from "./fixtures/sqlite";

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
    readFileSync("migrations/0003_console_sessions.sql", "utf8"),
  );
  result.sqlite.exec(
    readFileSync("migrations/0004_limit_request_reviews.sql", "utf8"),
  );
  result.sqlite.exec(
    readFileSync("migrations/0005_dashboard_session_revocations.sql", "utf8"),
  );
  result.sqlite.exec(
    readFileSync("migrations/0006_project_creation_policy.sql", "utf8"),
  );
  result.sqlite.exec(
    readFileSync("migrations/0007_project_recovery.sql", "utf8"),
  );
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

describe("dashboard API hardening", () => {
  it("rejects non-portal origins when DASHBOARD_ORIGIN is configured, while permitting localhost dev", async () => {
    const { db } = database();
    const env = {
      DB: db,
      DASHBOARD_SESSION_SECRET: secret,
      DASHBOARD_ORIGIN: "https://devs.egdata.app",
    } as DashboardEnv;
    const workersDevRes = await worker.fetch(
      new Request(
        "https://egdata-dashboard.example.workers.dev/_dashboard/api/auth/session",
      ),
      env,
      context,
    );
    expect(workersDevRes.status).toBe(403);
    expect(workersDevRes.headers.get("cache-control")).toBe("no-store");

    const portalRes = await worker.fetch(
      new Request("https://devs.egdata.app/_dashboard/api/auth/session"),
      env,
      context,
    );
    expect(portalRes.status).toBe(200);

    const localRes = await worker.fetch(
      new Request("http://localhost:4002/_dashboard/api/auth/session"),
      env,
      context,
    );
    expect(localRes.status).toBe(200);
  });

  it("restricts /analytics/simulate to local development or administrators", async () => {
    const { db, sqlite } = database();
    sqlite.exec(
      "INSERT INTO users(epic_account_id,display_name) VALUES('admin','Admin'); INSERT INTO user_roles(user_id,role) VALUES('admin','admin'); INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash) VALUES('k1','project','owner','K','egk','h1'),('k2','project','admin','K','egk','h2');",
    );
    const writeDataPoint = vi.fn();
    const env = {
      DB: db,
      DASHBOARD_SESSION_SECRET: secret,
      ANALYTICS: { writeDataPoint },
    } as unknown as DashboardEnv;

    const ownerToken = await signHmacToken(
      { user, exp: Date.now() + 60_000, iat: Date.now() },
      secret,
    );
    const adminToken = await signHmacToken(
      {
        user: { ...user, epicAccountId: "admin" },
        exp: Date.now() + 60_000,
        iat: Date.now(),
      },
      secret,
    );

    // Ordinary user in production -> 403
    expect(
      (
        await worker.fetch(
          new Request(
            "https://devs.egdata.app/_dashboard/api/analytics/simulate",
            {
              method: "POST",
              headers: {
                origin: "https://devs.egdata.app",
                cookie: `egdata_dash_session=${ownerToken}`,
              },
            },
          ),
          env,
          context,
        )
      ).status,
    ).toBe(403);
    expect(writeDataPoint).not.toHaveBeenCalled();

    // Admin in production -> 200
    expect(
      (
        await worker.fetch(
          new Request(
            "https://devs.egdata.app/_dashboard/api/analytics/simulate",
            {
              method: "POST",
              headers: {
                origin: "https://devs.egdata.app",
                cookie: `egdata_dash_session=${adminToken}`,
              },
            },
          ),
          env,
          context,
        )
      ).status,
    ).toBe(200);

    // Ordinary user in local dev with ENABLE_DEV_AUTH=true -> 200
    expect(
      (
        await worker.fetch(
          new Request(
            "http://localhost:4002/_dashboard/api/analytics/simulate",
            {
              method: "POST",
              headers: {
                origin: "http://localhost:4002",
                cookie: `egdata_dash_session=${ownerToken}`,
              },
            },
          ),
          { ...env, ENABLE_DEV_AUTH: "true" } as DashboardEnv,
          context,
        )
      ).status,
    ).toBe(200);
  });

  it("rate limits /_dashboard/api/* and /_internal/change-records per IP", async () => {
    const { db } = database();
    let allowed = true;
    const limit = vi.fn(async () => ({ success: allowed }));
    const env = {
      DB: db,
      DASHBOARD_SESSION_SECRET: secret,
      CHANGELOG_INGEST_TOKEN: "secret-ingest",
      RATE_LIMITER_DASHBOARD_API: { limit },
    } as unknown as DashboardEnv;

    expect(
      (
        await worker.fetch(
          new Request("https://devs.egdata.app/_dashboard/api/auth/session", {
            headers: { "cf-connecting-ip": "203.0.113.9" },
          }),
          env,
          context,
        )
      ).status,
    ).toBe(200);
    expect(limit).toHaveBeenCalledWith({ key: "dash:203.0.113.9" });

    await worker.fetch(
      new Request("https://devs.egdata.app/_dashboard/api/auth/session", {
        headers: { "x-forwarded-for": "198.51.100.1" },
      }),
      env,
      context,
    );
    expect(limit).toHaveBeenCalledWith({ key: "dash:unknown" });

    allowed = false;
    const blockedDash = await worker.fetch(
      new Request("https://devs.egdata.app/_dashboard/api/auth/session", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
      context,
    );
    expect(blockedDash.status).toBe(429);
    expect(blockedDash.headers.get("retry-after")).toBe("60");

    const blockedIngest = await worker.fetch(
      new Request("https://devs.egdata.app/_internal/change-records", {
        method: "POST",
        headers: {
          "x-forwarded-for": "198.51.100.2",
          authorization: "Bearer secret-ingest",
        },
        body: "{}",
      }),
      env,
      context,
    );
    expect(blockedIngest.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "ingest:unknown" });
  });

  it("revokes dashboard session tokens server-side upon logout", async () => {
    const { db, sqlite } = database();
    const env = {
      DB: db,
      DASHBOARD_SESSION_SECRET: secret,
    } as unknown as DashboardEnv;
    const token = await signHmacToken(
      { user, exp: Date.now() + 60_000, iat: Date.now() },
      secret,
    );
    const cookie = `egdata_dash_session=${token}`;

    // Before logout, session is valid
    expect(
      (
        await worker.fetch(
          new Request("https://devs.egdata.app/_dashboard/api/projects", {
            headers: { cookie },
          }),
          env,
          context,
        )
      ).status,
    ).toBe(200);

    // Logout revokes the token in D1.
    const logoutRes = await worker.fetch(
      new Request("https://devs.egdata.app/_dashboard/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://devs.egdata.app", cookie },
      }),
      env,
      context,
    );
    expect(logoutRes.status).toBe(200);
    expect(
      sqlite
        .prepare("SELECT token_hash FROM dashboard_session_revocations")
        .all(),
    ).toHaveLength(1);

    // Replaying the stolen cookie after logout is rejected (401)
    expect(
      (
        await worker.fetch(
          new Request("https://devs.egdata.app/_dashboard/api/projects", {
            headers: { cookie },
          }),
          env,
          context,
        )
      ).status,
    ).toBe(401);
  });

  it("does not report logout success when writing the revocation record fails", async () => {
    const token = await signHmacToken(
      { user, exp: Date.now() + 60_000, iat: Date.now() },
      secret,
    );
    const failingDb = {
      prepare: (query: string) => ({
        bind: () => ({
          run: async () => {
            if (query.includes("dashboard_session_revocations")) {
              throw new Error("D1 unavailable");
            }
            return {};
          },
        }),
      }),
    };
    const response = await worker.fetch(
      new Request("https://devs.egdata.app/_dashboard/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "https://devs.egdata.app",
          cookie: `egdata_dash_session=${token}`,
        },
      }),
      {
        DB: failingDb,
        DASHBOARD_SESSION_SECRET: secret,
      } as unknown as DashboardEnv,
      context,
    );
    expect(response.status).toBe(500);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com",
    "not-a-url",
  ])("rejects unsafe websiteUrl protocol %s on projects and limit requests", async (badUrl) => {
    const { db } = database();
    const env = { DB: db, DASHBOARD_SESSION_SECRET: secret } as DashboardEnv;
    const token = await signHmacToken(
      { user, exp: Date.now() + 60_000, iat: Date.now() },
      secret,
    );
    const headers = {
      origin: "https://devs.egdata.app",
      cookie: `egdata_dash_session=${token}`,
      "content-type": "application/json",
    };

    expect(
      (
        await worker.fetch(
          new Request("https://devs.egdata.app/_dashboard/api/projects", {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "My App", websiteUrl: badUrl }),
          }),
          env,
          context,
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await worker.fetch(
          new Request("https://devs.egdata.app/_dashboard/api/limit-requests", {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: "project",
              contactEmail: "owner@example.com",
              requestedTier: "pro",
              requestedRpm: 1200,
              expectedMonthlyRequests: 100_000,
              useCase: "Valid long enough use case description here.",
              websiteUrl: badUrl,
            }),
          }),
          env,
          context,
        )
      ).status,
    ).toBe(400);
  });

  it("attaches security headers to all SPA routes, not only /docs", async () => {
    const env = {
      ASSETS: {
        fetch: vi.fn(
          async () => new Response("<html></html>", { status: 200 }),
        ),
      },
    } as unknown as DashboardEnv;

    const rootRes = await worker.fetch(
      new Request("https://devs.egdata.app/keys"),
      env,
      context,
    );
    expect(rootRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(rootRes.headers.get("x-frame-options")).toBe("DENY");
    expect(rootRes.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );

    const docsRes = await worker.fetch(
      new Request("https://devs.egdata.app/docs"),
      env,
      context,
    );
    expect(docsRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(docsRes.headers.get("x-frame-options")).toBe("DENY");
    expect(docsRes.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("compares strings using fixed-length SHA-256 digests without length early-return", async () => {
    expect(await timingSafeStringEqual("alpha-secret", "alpha-secret")).toBe(
      true,
    );
    expect(await timingSafeStringEqual("alpha-secret", "short")).toBe(false);
    expect(await timingSafeStringEqual("alpha-secret", "alpha-secrex")).toBe(
      false,
    );
    expect(await timingSafeStringEqual("", "")).toBe(true);
  });
});
