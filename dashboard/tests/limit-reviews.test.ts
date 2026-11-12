import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signHmacToken } from "../worker/crypto";
import { insertLimitRequest } from "../worker/db";
import worker from "../worker/index";
import { resolveApiKeyMetadata, syncKeyToKv } from "../worker/key-cache";
import { isDashboardAdmin } from "../worker/limit-reviews";
import type { DashboardEnv, EpicSessionUser } from "../worker/types";
import { quotaForKey } from "../worker/v1-routes";
import { sqliteD1 } from "./fixtures/sqlite";

const adminId = "ac7b3a70e3ce4652b49c38e648001d9e";
const origin = "https://devs.egdata.app";
const secret = "test-session-secret-at-least-32-characters";
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  sqlite.exec(
    readFileSync("migrations/0005_dashboard_session_revocations.sql", "utf8"),
  );
  sqlite
    .prepare(
      "INSERT INTO users(epic_account_id,display_name) VALUES(?, 'Admin'),('owner','Owner'),('other','Other')",
    )
    .run(adminId);
  sqlite.exec(
    readFileSync("migrations/0004_limit_request_reviews.sql", "utf8"),
  );
  sqlite.exec(
    "INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('project','owner','Project','project'),('other-project','other','Other','other');",
  );
  const hash = crypto.randomUUID();
  sqlite
    .prepare(
      "INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash,scopes_json,allowed_ips_json,active) VALUES('key','project','owner','Key','egk',?,'[\"offers:read\"]','[\"203.0.113.1\"]',0)",
    )
    .run(hash);
  sqlite.exec(
    "INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash,revoked_at) VALUES('revoked','project','owner','Revoked','egk','revoked','2026-11-01'),('other-key','other-project','other','Other','egk','other',NULL)",
  );
  const cache = new Map<string, unknown>();
  const env = {
    DB: db,
    DASHBOARD_SESSION_SECRET: secret,
    API_KEYS_KV: {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        cache.set(key, JSON.parse(value));
      }),
      delete: vi.fn(async (key: string) => {
        cache.delete(key);
      }),
    },
  } as unknown as DashboardEnv;
  const request = await insertLimitRequest(db, {
    ownerEpicId: "owner",
    projectId: "project",
    contactEmail: "owner@example.com",
    requestedTier: "custom",
    requestedRpm: 4321,
    expectedMonthlyRequests: 1_000_000,
    useCase: "A real integration needing more capacity.",
    websiteUrl: "https://example.com",
    emailDeliveryStatus: "sent",
  });
  if (!request) throw new Error("Failed to seed the review request");
  const call = async (
    path: string,
    id: string | null = adminId,
    body?: unknown,
    requestOrigin = origin,
  ) => {
    const token = id
      ? await signHmacToken(
          {
            user: {
              epicAccountId: id,
              displayName: "Admin",
              avatarUrl: "",
              roles: ["admin"],
              isAdmin: true,
            },
            exp: Date.now() + 60_000,
            iat: Date.now(),
          },
          secret,
        )
      : null;
    return worker.fetch(
      new Request(`${origin}/_dashboard/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: requestOrigin,
          "content-type": "application/json",
          ...(token ? { cookie: `egdata_dash_session=${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      context,
    );
  };
  const review = (
    body: unknown = { decision: "approved" },
    id: string | null = adminId,
    requestOrigin = origin,
  ) =>
    call(`/admin/limit-requests/${request.id}/review`, id, body, requestOrigin);
  return { db, sqlite, env, request, call, review, hash };
}

describe("administrator limit reviews", () => {
  it("bootstraps only the designated existing user and fails closed for other identities", async () => {
    const { db, env, sqlite } = await setup();
    expect(sqlite.prepare("SELECT user_id,role FROM user_roles").all()).toEqual(
      [{ user_id: adminId, role: "admin" }],
    );
    expect(await isDashboardAdmin(env, null)).toBe(false);
    expect(
      await isDashboardAdmin(env, {
        epicAccountId: "owner",
      } as EpicSessionUser),
    ).toBe(false);
    await expect(
      db
        .prepare("INSERT INTO user_roles(user_id, role) VALUES(?, 'admin')")
        .bind(adminId)
        .run(),
    ).rejects.toThrow();
  });

  it("requires a session, DB role, and same-origin mutations; signed session claims cannot grant admin", async () => {
    const { call, review, sqlite } = await setup();
    expect((await call("/admin/limit-requests", null)).status).toBe(401);
    expect((await review({ decision: "approved" }, null)).status).toBe(401);
    expect((await call("/admin/limit-requests", "owner")).status).toBe(403);
    expect((await review({ decision: "approved" }, "owner")).status).toBe(403);
    expect(
      (await review({ decision: "approved" }, adminId, "https://evil.example"))
        .status,
    ).toBe(403);
    expect((await call("/auth/session")).status).toBe(200);
    expect(await (await call("/auth/session")).json()).toMatchObject({
      isAdmin: true,
    });
    expect(await (await call("/auth/session", "owner")).json()).toMatchObject({
      isAdmin: false,
    });
    sqlite.exec("DELETE FROM user_roles");
    expect((await review()).status).toBe(403);
    expect(await (await call("/auth/session")).json()).toMatchObject({
      isAdmin: false,
    });
    expect(
      sqlite.prepare("SELECT status FROM limit_requests").get(),
    ).toMatchObject({ status: "pending" });
  });

  it.each([
    "pro",
    "enterprise",
    "custom",
  ])("approves exact RPM for %s and gives new keys the same grant", async (tier) => {
    const { call, review, sqlite, env, hash } = await setup();
    sqlite.prepare("UPDATE limit_requests SET requested_tier=?").run(tier);
    const response = await review({
      decision: "approved",
      note: "Capacity approved.",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: {
        status: "approved",
        reviewedBy: adminId,
        reviewedAt: expect.any(String),
        reviewNote: "Capacity approved.",
      },
      quotaPropagationSeconds: 300,
    });
    const approvedTier = tier === "custom" ? "enterprise" : tier;
    expect(
      sqlite
        .prepare("SELECT tier,custom_rpm FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ tier: approvedTier, custom_rpm: 4321 });
    expect(
      sqlite
        .prepare(
          "SELECT tier,custom_rpm,active,scopes_json,allowed_ips_json FROM api_keys WHERE id='key'",
        )
        .get(),
    ).toEqual({
      tier: approvedTier,
      custom_rpm: 4321,
      active: 0,
      scopes_json: '["offers:read"]',
      allowed_ips_json: '["203.0.113.1"]',
    });
    expect(
      sqlite
        .prepare("SELECT tier,custom_rpm FROM api_keys WHERE id='revoked'")
        .get(),
    ).toEqual({ tier: "free", custom_rpm: null });
    expect(
      sqlite
        .prepare("SELECT tier,custom_rpm FROM api_keys WHERE id='other-key'")
        .get(),
    ).toEqual({ tier: "free", custom_rpm: null });
    expect(env.API_KEYS_KV.delete).toHaveBeenCalledWith(`apikey:${hash}`);
    const created = await call("/keys", "owner", {
      projectId: "project",
      name: "Future key",
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      key: { tier: string; customRpm: number };
    };
    expect(body.key).toMatchObject({ tier: approvedTier, customRpm: 4321 });
    expect(quotaForKey(body.key)).toBe(4321);
    expect(
      (await review({ decision: "declined", note: "Overwrite attempt" }))
        .status,
    ).toBe(409);
    expect(
      sqlite.prepare("SELECT status,review_note FROM limit_requests").get(),
    ).toMatchObject({ status: "approved", review_note: "Capacity approved." });
    expect(await (await call("/limit-requests", "owner")).json()).toMatchObject(
      { requests: [{ status: "approved", reviewNote: "Capacity approved." }] },
    );
  });

  it("declines with an audit trail without changing quotas or caches", async () => {
    const { review, sqlite, env } = await setup();
    expect(
      (
        await review({
          decision: "declined",
          note: "Please describe caching first.",
        })
      ).status,
    ).toBe(200);
    expect(
      sqlite
        .prepare("SELECT status,reviewed_by,review_note FROM limit_requests")
        .get(),
    ).toMatchObject({
      status: "declined",
      reviewed_by: adminId,
      review_note: "Please describe caching first.",
    });
    expect(
      sqlite
        .prepare("SELECT tier,custom_rpm FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ tier: "free", custom_rpm: null });
    expect(env.API_KEYS_KV.delete).not.toHaveBeenCalled();
    expect((await review()).status).toBe(409);
  });

  it("accepts only one decision when both reviewers read a pending request", async () => {
    const { review, db, sqlite } = await setup();
    const batch = db.batch.bind(db);
    let previous: Promise<unknown> = Promise.resolve();
    // Match D1's serialized batch transactions while both HTTP handlers race.
    vi.spyOn(db, "batch").mockImplementation((statements) => {
      const current = previous.then(() => batch(statements));
      previous = current;
      return current;
    });
    const responses = await Promise.all([
      review({ decision: "approved", note: "First" }),
      review({ decision: "declined", note: "Second" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const winner = sqlite
      .prepare("SELECT status,review_note FROM limit_requests")
      .get();
    const project = sqlite
      .prepare("SELECT custom_rpm FROM projects WHERE id='project'")
      .get();
    expect(project?.custom_rpm).toBe(
      winner?.status === "approved" ? 4321 : null,
    );
    expect(winner?.review_note).toBe(
      winner?.status === "approved" ? "First" : "Second",
    );
  });

  it("rolls the entire decision back if updating a key fails", async () => {
    const { review, sqlite } = await setup();
    sqlite.exec(
      "CREATE TRIGGER reject_key_update BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await review()).status).toBe(500);
    expect(
      sqlite.prepare("SELECT status,reviewed_at FROM limit_requests").get(),
    ).toEqual({ status: "pending", reviewed_at: null });
    expect(
      sqlite
        .prepare("SELECT tier,custom_rpm FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ tier: "free", custom_rpm: null });
  });

  it("invalidates cached permissions and preserves a committed review if KV fails", async () => {
    const { review, sqlite, env, hash } = await setup();
    sqlite.exec("UPDATE api_keys SET active=1 WHERE id='key'");
    const before = await resolveApiKeyMetadata(env, context, hash);
    if (!before) throw new Error("Expected a seeded active key");
    await syncKeyToKv(env, hash, before);
    expect(
      (await resolveApiKeyMetadata(env, context, hash))?.customRpm,
    ).toBeNull();
    expect((await review()).status).toBe(200);
    expect((await resolveApiKeyMetadata(env, context, hash))?.customRpm).toBe(
      4321,
    );
    const second = await setup();
    vi.mocked(second.env.API_KEYS_KV.delete).mockRejectedValue(
      new Error("KV unavailable"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await second.review()).status).toBe(200);
    expect(
      second.sqlite.prepare("SELECT status FROM limit_requests").get(),
    ).toEqual({ status: "approved" });
  });

  it("validates review input and returns not found for an unknown request", async () => {
    const { review, call } = await setup();
    for (const body of [
      { decision: "pending" },
      { decision: "approved", note: "x".repeat(2001) },
      { decision: "approved", requestedRpm: 999999 },
      null,
    ]) {
      expect((await review(body)).status).toBe(400);
    }
    expect(
      (
        await call("/admin/limit-requests/missing/review", adminId, {
          decision: "approved",
        })
      ).status,
    ).toBe(404);
    expect((await call("/admin/limit-requests?status=invalid")).status).toBe(
      400,
    );
    expect((await call("/admin/limit-requests?offset=-1")).status).toBe(400);
  });

  it("paginates all users' requests for admins while retaining owner-only history", async () => {
    const { call, sqlite } = await setup();
    for (let i = 0; i < 26; i++) {
      sqlite
        .prepare(
          "INSERT INTO limit_requests(id,owner_epic_id,project_id,contact_email,requested_tier,requested_rpm,expected_monthly_requests,use_case) VALUES(?,'other','other-project','other@example.com','pro',1200,100000,'Integration')",
        )
        .run(`other-${i}`);
    }
    const page = (await (await call("/admin/limit-requests")).json()) as {
      requests: unknown[];
      hasMore: boolean;
    };
    expect(page.requests).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    const next = (await (
      await call("/admin/limit-requests?offset=25")
    ).json()) as { requests: unknown[]; hasMore: boolean };
    expect(next.requests).toHaveLength(2);
    expect(next.hasMore).toBe(false);
    const own = (await (await call("/limit-requests", "owner")).json()) as {
      requests: unknown[];
    };
    expect(own.requests).toHaveLength(1);
  });
});
