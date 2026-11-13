import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdminPage,
  AdminProject,
  AdminUser,
  AdminUserDetail,
} from "../worker/admin-types";
import { recordApiTelemetry } from "../worker/analytics";
import type { AnalyticsDashboardSummary } from "../worker/analytics-types";
import { signHmacToken } from "../worker/crypto";
import {
  createProject,
  insertApiKey,
  listUserApiKeys,
  listUserProjects,
  updateApiKeyPermissions,
  upsertEpicUserAndDefaultProject,
} from "../worker/db";
import { projectOwned } from "../worker/endpoint-alerts";
import worker from "../worker/index";
import { resolveApiKeyMetadata, syncKeyToKv } from "../worker/key-cache";
import { accountLimiterObjectName } from "../worker/project-quota";
import { purgeDeletedProjects } from "../worker/project-retention";
import type { DashboardEnv } from "../worker/types";
import { quotaNamespace } from "./fixtures/quota";
import { sqliteD1 } from "./fixtures/sqlite";

const origin = "https://devs.egdata.app";
const secret = "admin-management-test-session-secret";
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO users(epic_account_id,display_name,email) VALUES
    ('admin','Administrator',NULL),('owner','Owner','owner@example.com'),('other','Other',NULL);
    INSERT INTO user_roles(user_id,role) VALUES('admin','admin');
    INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('project','owner','Project','project'),('other-project','other','Other project','other');`);
  const hash = crypto.randomUUID();
  sqlite
    .prepare(`INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash,scopes_json)
    VALUES('key','project','owner','Key','egk',?,'["offers:read"]')`)
    .run(hash);
  sqlite.exec(`INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash,active,expires_at,revoked_at) VALUES
    ('disabled','project','owner','Disabled','egk','disabled',0,NULL,NULL),
    ('expired','project','owner','Expired','egk','expired',1,'2020-01-01T00:00:00Z',NULL),
    ('revoked','project','owner','Revoked','egk','revoked',0,NULL,'2026-01-01'),
    ('other-key','other-project','other','Other key','egk','other',1,NULL,NULL);`);
  const cache = new Map<string, unknown>();
  const env = {
    DB: db,
    API_KEY_RATE_LIMITER: quotaNamespace(),
    DASHBOARD_SESSION_SECRET: secret,
    API_KEYS_KV: {
      get: vi.fn(async (id: string) => cache.get(id) ?? null),
      put: vi.fn(async (id: string, value: string) => {
        cache.set(id, JSON.parse(value));
      }),
      delete: vi.fn(async (id: string) => {
        cache.delete(id);
      }),
    },
  } as unknown as DashboardEnv;
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    user: string | null = "admin",
    requestOrigin = origin,
  ) {
    const token = user
      ? await signHmacToken(
          {
            user: {
              epicAccountId: user,
              displayName: user,
              avatarUrl: "",
              isAdmin: true,
            },
            exp: Date.now() + 60_000,
            iat: Date.now(),
          },
          secret,
        )
      : null;
    return worker.fetch(
      new Request(`${origin}/_dashboard/api/admin${path}`, {
        method,
        headers: {
          origin: requestOrigin,
          "content-type": "application/json",
          ...(token ? { cookie: `egdata_dash_session=${token}` } : {}),
        },
        ...(body === undefined && method === "GET"
          ? {}
          : {
              body: JSON.stringify(
                body === null
                  ? null
                  : {
                      reason: "Support ticket investigation",
                      ...(typeof body === "object" ? body : {}),
                    },
              ),
            }),
      }),
      env,
      context,
    );
  }
  return { db, sqlite, env, hash, call };
}

describe("administrator user and project management", () => {
  const routes: [string, string, unknown?][] = [
    ["/users", "GET"],
    ["/users/owner", "GET"],
    ["/users/owner/analytics", "GET"],
    ["/projects", "GET"],
    ["/projects/project/keys", "GET"],
    ["/users/owner/limits", "PATCH", { projectLimit: 3 }],
    ["/projects/project/limits", "PATCH", { tier: "pro", customRpm: 500 }],
    ["/keys/key", "DELETE"],
    ["/projects/project", "DELETE"],
    ["/projects/project/restore", "POST", { reason: "Appeal accepted" }],
    ["/audit", "GET"],
  ];
  it.each(
    routes,
  )("protects %s %s with session, DB admin role, and same-origin mutations", async (path, method, body) => {
    const { call, sqlite } = setup();
    expect((await call(path, method, body, null)).status).toBe(401);
    expect((await call(path, method, body, "owner")).status).toBe(403);
    if (method !== "GET")
      expect(
        (await call(path, method, body, "admin", "https://evil.example"))
          .status,
      ).toBe(403);
    sqlite.exec("DELETE FROM user_roles");
    expect((await call(path, method, body)).status).toBe(403);
  });

  it("lists accounts and projects with correct non-multiplied key counts, filters and no credentials", async () => {
    const { call, hash } = setup();
    const response = await call("/users?search=OWNER%40EXAMPLE.COM");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const users = (await response.json()) as AdminPage<AdminUser>;
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]).toMatchObject({
      id: "owner",
      projectCount: 1,
      projectLimit: 1,
      keyCount: 3,
      activeKeyCount: 1,
    });
    const projects = (await (
      await call("/projects?owner=owner")
    ).json()) as AdminPage<AdminProject>;
    expect(projects.rows).toHaveLength(1);
    expect(projects.rows[0]).toMatchObject({
      id: "project",
      effectiveRpm: 120,
      keyCount: 3,
      activeKeyCount: 1,
    });
    expect(
      (
        (await (
          await call("/projects?search=%27%20OR%201%3D1--")
        ).json()) as AdminPage<AdminProject>
      ).rows,
    ).toHaveLength(0);
    const keys = await (await call("/projects/project/keys")).text();
    expect(keys).not.toContain(hash);
    expect(keys).not.toContain('"keyHash"');
    expect(
      JSON.parse(keys)
        .keys.map((key: { id: string }) => key.id)
        .sort(),
    ).toEqual(["disabled", "expired", "key", "revoked"]);
  });

  it("paginates deterministically and validates list parameters", async () => {
    const { sqlite, call } = setup();
    for (let i = 0; i < 26; i++)
      sqlite
        .prepare("INSERT INTO users(epic_account_id,display_name) VALUES(?,?)")
        .run(`extra-${i}`, `Extra ${i}`);
    const first = (await (
      await call("/users?search=Extra")
    ).json()) as AdminPage<AdminUser>;
    const second = (await (
      await call("/users?search=Extra&offset=25")
    ).json()) as AdminPage<AdminUser>;
    expect(first.rows).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(second.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(
      new Set([...first.rows, ...second.rows].map((row) => row.id)).size,
    ).toBe(26);
    for (const query of [
      "offset=-1",
      "offset=1.5",
      "offset=1000001",
      `search=${"x".repeat(201)}`,
    ]) {
      expect((await call(`/users?${query}`)).status).toBe(400);
      expect((await call(`/projects?${query}`)).status).toBe(400);
    }
  });

  it("updates user caps while retaining the creation cooldown and existing projects", async () => {
    const { call, db, sqlite } = setup();
    expect(
      (await call("/users/owner/limits", "PATCH", { projectLimit: 3 })).status,
    ).toBe(200);
    const input = {
      ownerEpicId: "owner",
      name: "New",
      slug: "new",
      description: "",
      websiteUrl: "",
    };
    await expect(createProject(db, input)).rejects.toThrow(/24 hours/);
    sqlite.exec(
      "UPDATE users SET last_project_created_at=0 WHERE epic_account_id='owner'",
    );
    expect(await createProject(db, input)).not.toBeNull();
    expect(
      (await call("/users/owner/limits", "PATCH", { projectLimit: 1 })).status,
    ).toBe(200);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM projects WHERE owner_epic_id='owner'",
        )
        .get(),
    ).toEqual({ count: 2 });
    for (const projectLimit of [0, 101, 1.5, "2", null])
      expect(
        (await call("/users/owner/limits", "PATCH", { projectLimit })).status,
      ).toBe(400);
    expect(
      (await call("/users/missing/limits", "PATCH", { projectLimit: 2 }))
        .status,
    ).toBe(404);
  });

  it("changes shared quotas, invalidates caches, preserves key policies, and gives future keys the grant", async () => {
    const { call, db, sqlite, env, hash } = setup();
    const before = await resolveApiKeyMetadata(env, context, hash);
    if (!before) throw new Error("Missing test key");
    await syncKeyToKv(env, hash, before);
    expect(
      (
        await call("/projects/project/limits", "PATCH", {
          tier: "enterprise",
          customRpm: 9876,
        })
      ).status,
    ).toBe(200);
    expect((await resolveApiKeyMetadata(env, context, hash))?.customRpm).toBe(
      9876,
    );
    expect(
      sqlite
        .prepare("SELECT active,scopes_json FROM api_keys WHERE id='key'")
        .get(),
    ).toEqual({ active: 1, scopes_json: '["offers:read"]' });
    expect(
      sqlite.prepare("SELECT active FROM api_keys WHERE id='disabled'").get(),
    ).toEqual({ active: 0 });
    expect(
      sqlite.prepare("SELECT tier FROM api_keys WHERE id='other-key'").get(),
    ).toEqual({ tier: "free" });
    const key = await insertApiKey(db, {
      id: "future",
      projectId: "project",
      ownerEpicId: "owner",
      name: "Future",
      keyPrefix: "egk",
      keyHash: "future",
      scopes: ["offers:read"],
      allowedIps: [],
      allowedOrigins: [],
      allowedPaths: [],
      allowedMethods: ["GET"],
      expiresAt: null,
    });
    expect(key).toMatchObject({ tier: "enterprise", customRpm: 9876 });
    expect(
      (
        await call("/projects/project/limits", "PATCH", {
          tier: "pro",
          customRpm: null,
        })
      ).status,
    ).toBe(200);
    const page = (await (
      await call("/projects?owner=owner")
    ).json()) as AdminPage<AdminProject>;
    expect(page.rows[0]).toMatchObject({
      tier: "pro",
      customRpm: null,
      effectiveRpm: 1200,
    });
    for (const body of [
      { tier: "custom", customRpm: 500 },
      { tier: "free", customRpm: 0 },
      { tier: "free", customRpm: 1_000_001 },
      { tier: "free", customRpm: 1.5 },
      { tier: "free" },
      { tier: "free", customRpm: null, active: true },
    ]) {
      expect(
        (await call("/projects/project/limits", "PATCH", body)).status,
      ).toBe(400);
    }
  });

  it.each([
    150,
    500_000,
    null,
  ])("persists the database RPM boundaries and tier default (%s)", async (customRpm) => {
    const { call, sqlite } = setup();
    const response = await call("/projects/project/limits", "PATCH", {
      tier: "pro",
      customRpm,
    });
    expect(response.status).toBe(200);
    expect(
      sqlite
        .prepare("SELECT custom_rpm FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ custom_rpm: customRpm });
    expect(
      sqlite.prepare("SELECT custom_rpm FROM api_keys WHERE id='key'").get(),
    ).toEqual({ custom_rpm: customRpm });
  });

  it.each([
    1, 100, 149, 500_001, 600_000, 1_000_000,
  ])("rejects unsupported RPM %s before any mutation", async (customRpm) => {
    const { call, db, sqlite, env } = setup();
    const batch = vi.spyOn(db, "batch");
    const response = await call("/projects/project/limits", "PATCH", {
      tier: "pro",
      customRpm,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(batch).not.toHaveBeenCalled();
    expect(env.API_KEYS_KV.delete).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare("SELECT tier,custom_rpm FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ tier: "free", custom_rpm: null });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects setting customRpm on a free tier project before any mutation", async () => {
    const { call, db, env } = setup();
    const batch = vi.spyOn(db, "batch");
    const response = await call("/projects/project/limits", "PATCH", {
      tier: "free",
      customRpm: 500,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message:
          "Custom RPM overrides require pro, scale, or enterprise tier; free tier projects remain subject to the 100,000/month cap.",
      },
    });
    expect(batch).not.toHaveBeenCalled();
    expect(env.API_KEYS_KV.delete).not.toHaveBeenCalled();
  });

  it("rolls back quota changes if a key update fails", async () => {
    const { call, sqlite, env } = setup();
    sqlite.exec(
      "CREATE TRIGGER reject_update BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (
        await call("/projects/project/limits", "PATCH", {
          tier: "pro",
          customRpm: 700,
        })
      ).status,
    ).toBe(500);
    expect(
      sqlite
        .prepare("SELECT tier,custom_rpm FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ tier: "free", custom_rpm: null });
    expect(env.API_KEYS_KV.delete).not.toHaveBeenCalled();
  });

  it("revokes another user's key and removes it from authentication and lists", async () => {
    const { call, env, hash, sqlite } = setup();
    const before = await resolveApiKeyMetadata(env, context, hash);
    if (!before) throw new Error("Missing test key");
    await syncKeyToKv(env, hash, before);
    expect((await call("/keys/key", "DELETE")).status).toBe(200);
    expect(await resolveApiKeyMetadata(env, context, hash)).toBeNull();
    expect(
      sqlite
        .prepare("SELECT active,revoked_at FROM api_keys WHERE id='key'")
        .get(),
    ).toMatchObject({ active: 0, revoked_at: expect.any(String) });
    expect((await call("/keys/missing", "DELETE")).status).toBe(404);
  });

  it("soft-deletes with retained evidence, revokes credentials, hides owner access, and purges after 90 days", async () => {
    const { call, db, sqlite, env, hash } = setup();
    sqlite.exec(`INSERT INTO console_sessions VALUES('project','session','token',9999999999999);
      INSERT INTO limit_requests(id,owner_epic_id,project_id,contact_email,requested_tier,requested_rpm,expected_monthly_requests,use_case) VALUES('req','owner','project','x@example.com','pro',1200,10000,'test');
      INSERT INTO change_records(id,content_hash,record_json,merge_commit,merged_at,window_start,merge_date) VALUES('change','hash','{}','sha',1,'2026-01-01','2026-01-01');
      INSERT INTO project_alerts(project_id,record_id) VALUES('project','change');
      INSERT INTO alert_reads VALUES('owner','project','change',1);
      INSERT INTO alert_matches VALUES('project','change','op','key',1);
      INSERT INTO usage_daily VALUES('project','key','op','2026-11-12',1);
      INSERT INTO usage_dead_letters VALUES('key','op','2026-11-12','{}',1);`);
    const cooldown = sqlite
      .prepare(
        "SELECT last_project_created_at FROM users WHERE epic_account_id='owner'",
      )
      .get();
    expect((await call("/projects/project", "DELETE")).status).toBe(200);
    for (const table of [
      "limit_requests",
      "project_alerts",
      "alert_reads",
      "alert_matches",
      "usage_daily",
      "usage_dead_letters",
    ])
      expect(
        sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM console_sessions").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get(),
    ).toEqual({ count: 5 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get(),
    ).toEqual({ count: 2 });
    expect(
      sqlite
        .prepare("SELECT revoked_at FROM api_keys WHERE id='revoked'")
        .get(),
    ).toEqual({ revoked_at: "2026-01-01" });
    expect(
      sqlite
        .prepare(
          "SELECT last_project_created_at FROM users WHERE epic_account_id='owner'",
        )
        .get(),
    ).toEqual(cooldown);
    expect(env.API_KEYS_KV.delete).toHaveBeenCalledWith(`apikey:${hash}`);
    expect(await resolveApiKeyMetadata(env, context, hash)).toBeNull();
    expect((await call("/projects/project", "DELETE")).status).toBe(404);
    expect((await call("/projects/project/keys")).status).toBe(200);
    expect(await listUserProjects(db, "owner")).toEqual([]);
    expect(await listUserApiKeys(db, "owner")).toEqual([]);
    expect(await projectOwned(db, "project", "owner")).toBe(false);
    expect(
      await updateApiKeyPermissions(db, "owner", "key", { active: true }),
    ).toBeNull();
    expect(
      await upsertEpicUserAndDefaultProject(db, {
        epicAccountId: "owner",
        displayName: "Owner",
        avatarUrl: "",
      }),
    ).toEqual([]);
    expect(
      (
        (await (
          await call("/projects?owner=owner")
        ).json()) as AdminPage<AdminProject>
      ).rows,
    ).toHaveLength(0);
    const deleted = (await (
      await call("/projects?owner=owner&status=deleted")
    ).json()) as AdminPage<AdminProject>;
    expect(deleted.rows[0]).toMatchObject({
      deletedBy: "admin",
      deletionReason: "Support ticket investigation",
    });
    const deadline = deleted.rows[0].purgeAfter;
    const deletedAt = deleted.rows[0].deletedAt;
    if (!deadline || !deletedAt) throw new Error("Missing recovery timestamps");
    expect(Date.parse(deadline) - Date.parse(deletedAt)).toBeCloseTo(
      90 * 86400_000,
      -2,
    );
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM admin_audit_log WHERE project_id='project'",
        )
        .get(),
    ).toEqual({ count: 4 });
    await purgeDeletedProjects(
      db,
      new Date(Date.parse(deadline) - 1).toISOString(),
    );
    expect(
      sqlite.prepare("SELECT id FROM projects WHERE id='project'").get(),
    ).toBeDefined();
    await purgeDeletedProjects(db, deadline);
    expect(sqlite.prepare("SELECT id FROM projects").all()).toEqual([
      { id: "other-project" },
    ]);
    expect(sqlite.prepare("SELECT id FROM api_keys").all()).toEqual([
      { id: "other-key" },
    ]);
    for (const table of [
      "limit_requests",
      "project_alerts",
      "alert_reads",
      "alert_matches",
      "usage_daily",
      "usage_dead_letters",
    ])
      expect(
        sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT action FROM admin_audit_log ORDER BY sequence DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ action: "project.purged" });
    const history = await (await call("/audit?projectId=project")).text();
    expect(history).toContain("Support ticket investigation");
    expect(history).not.toContain(hash);
    expect(history).not.toContain("key_hash");
    await purgeDeletedProjects(db, deadline);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM admin_audit_log WHERE action='project.purged'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back dependent deletion on failure and reports committed changes despite KV failure", async () => {
    const { call, sqlite, env } = setup();
    sqlite.exec(
      "INSERT INTO usage_daily VALUES('project','key','op','2026-11-12',1); CREATE TRIGGER reject_delete BEFORE UPDATE OF deleted_at ON projects BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("/projects/project", "DELETE")).status).toBe(500);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM usage_daily").get(),
    ).toEqual({ count: 1 });
    expect(env.API_KEYS_KV.delete).not.toHaveBeenCalled();
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare("SELECT active,revoked_at FROM api_keys WHERE id='key'")
        .get(),
    ).toEqual({ active: 1, revoked_at: null });
    sqlite.exec("DROP TRIGGER reject_delete");
    vi.mocked(env.API_KEYS_KV.delete).mockRejectedValue(
      new Error("KV unavailable"),
    );
    expect((await call("/projects/project", "DELETE")).status).toBe(200);
  });

  it("restores within the recovery window without reviving old credentials or resetting the cooldown", async () => {
    const { db, sqlite, call, env, hash } = setup();
    const cooldown = sqlite
      .prepare(
        "SELECT last_project_created_at FROM users WHERE epic_account_id='owner'",
      )
      .get();
    expect((await call("/projects/project", "DELETE")).status).toBe(200);
    expect(
      (
        await call("/projects/project/restore", "POST", {
          reason: "Deletion was a mistake",
        })
      ).status,
    ).toBe(200);
    expect(await listUserProjects(db, "owner")).toHaveLength(1);
    expect(await projectOwned(db, "project", "owner")).toBe(true);
    expect(await listUserApiKeys(db, "owner")).toEqual([]);
    expect(await resolveApiKeyMetadata(env, context, hash)).toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT last_project_created_at FROM users WHERE epic_account_id='owner'",
        )
        .get(),
    ).toEqual(cooldown);
    expect((await call("/projects/project/restore", "POST")).status).toBe(409);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM admin_audit_log WHERE action='project.restored'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const fresh = await insertApiKey(db, {
      id: "fresh",
      projectId: "project",
      ownerEpicId: "owner",
      name: "New credential",
      keyPrefix: "egk",
      keyHash: "new-hash",
      scopes: ["offers:read"],
      allowedIps: [],
      allowedOrigins: [],
      allowedPaths: [],
      allowedMethods: ["GET"],
      expiresAt: null,
    });
    expect(fresh.active).toBe(true);
  });

  it("requires reasons, rejects expired restoration and enforces the owner's active project cap", async () => {
    const { call, sqlite } = setup();
    for (const reason of ["", "  ", "x".repeat(2001)]) {
      expect(
        (await call("/projects/project", "DELETE", { reason })).status,
      ).toBe(400);
      expect((await call("/keys/key", "DELETE", { reason })).status).toBe(400);
      expect(
        (await call("/projects/project/restore", "POST", { reason })).status,
      ).toBe(400);
    }
    expect((await call("/projects/project", "DELETE")).status).toBe(200);
    expect(
      (
        await call("/projects/project/limits", "PATCH", {
          tier: "pro",
          customRpm: 200,
        })
      ).status,
    ).toBe(404);
    expect(() =>
      sqlite.exec(
        "INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash) VALUES('late','project','owner','Late','egk','late')",
      ),
    ).toThrow("PROJECT_DELETED");
    expect(() =>
      sqlite.exec(
        "INSERT INTO console_sessions VALUES('project','login','token',9999999999999)",
      ),
    ).toThrow("PROJECT_DELETED");
    sqlite.exec(
      "UPDATE users SET last_project_created_at=0 WHERE epic_account_id='owner'; INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('replacement','owner','Replacement','replacement')",
    );
    expect((await call("/projects/project/restore", "POST")).status).toBe(409);
    expect(
      (await call("/users/owner/limits", "PATCH", { projectLimit: 2 })).status,
    ).toBe(200);
    expect((await call("/projects/project/restore", "POST")).status).toBe(200);
    expect((await call("/projects/project", "DELETE")).status).toBe(200);
    sqlite.exec(
      "UPDATE projects SET purge_after='2020-01-01T00:00:00Z' WHERE id='project'",
    );
    expect((await call("/projects/project/restore", "POST")).status).toBe(409);
  });

  it("audits exact previous limits and rolls back mutations if recording the audit fails", async () => {
    const { call, sqlite } = setup();
    expect(
      (
        await call("/users/owner/limits", "PATCH", {
          projectLimit: 4,
          reason: "Approved extra applications",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/projects/project/limits", "PATCH", {
          tier: "pro",
          customRpm: 300,
          reason: "Confirmed traffic requirements",
        })
      ).status,
    ).toBe(200);
    const history = (await (await call("/audit?owner=owner")).json()) as {
      rows: {
        action: string;
        before: unknown;
        after: unknown;
        actorId: string;
        reason: string;
      }[];
    };
    expect(history.rows).toMatchObject([
      {
        action: "project.limits_changed",
        before: { tier: "free", customRpm: null },
        after: { tier: "pro", customRpm: 300 },
        actorId: "admin",
        reason: "Confirmed traffic requirements",
      },
      {
        action: "user.limits_changed",
        before: { projectLimit: 1 },
        after: { projectLimit: 4 },
      },
    ]);
    sqlite.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit_log BEGIN SELECT RAISE(ABORT,'test audit failure'); END;",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("/projects/project", "DELETE")).status).toBe(500);
    expect(
      sqlite
        .prepare("SELECT deleted_at FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ deleted_at: null });
    expect(
      (await call("/users/owner/limits", "PATCH", { projectLimit: 9 })).status,
    ).toBe(500);
    expect(
      sqlite
        .prepare(
          "SELECT project_limit FROM users WHERE epic_account_id='owner'",
        )
        .get(),
    ).toEqual({ project_limit: 4 });
  });

  it("rolls back an interrupted purge and does not purge a project restored after selection", async () => {
    const { call, sqlite, db } = setup();
    await call("/projects/project", "DELETE");
    const deadline = sqlite
      .prepare("SELECT purge_after FROM projects WHERE id='project'")
      .get()?.purge_after as string;
    sqlite.exec(
      "INSERT INTO usage_daily VALUES('project','key','op','2026-11-12',1); CREATE TRIGGER reject_purge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'purge failure'); END;",
    );
    await expect(purgeDeletedProjects(db, deadline)).rejects.toThrow(
      "purge failure",
    );
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM usage_daily").get(),
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM admin_audit_log WHERE action='project.purged'",
        )
        .get(),
    ).toEqual({ count: 0 });
    sqlite.exec("DROP TRIGGER reject_purge");
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      // Selection occurred before another request committed restoration.
      expect((await call("/projects/project/restore", "POST")).status).toBe(
        200,
      );
      return batch(statements);
    });
    await purgeDeletedProjects(db, deadline);
    expect(
      sqlite
        .prepare("SELECT deleted_at FROM projects WHERE id='project'")
        .get(),
    ).toEqual({ deleted_at: null });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM usage_daily").get(),
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM admin_audit_log WHERE action='project.purged'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("serializes duplicate deletions and restores with one audit entry per transition", async () => {
    const { call, db, sqlite } = setup();
    const batch = db.batch.bind(db);
    let previous: Promise<unknown> = Promise.resolve();
    vi.spyOn(db, "batch").mockImplementation((statements) => {
      const current = previous.then(() => batch(statements));
      previous = current;
      return current;
    });
    const deletions = await Promise.all([
      call("/projects/project", "DELETE"),
      call("/projects/project", "DELETE"),
    ]);
    expect(deletions.map((response) => response.status).sort()).toEqual([
      200, 404,
    ]);
    const restorations = await Promise.all([
      call("/projects/project/restore", "POST"),
      call("/projects/project/restore", "POST"),
    ]);
    expect(restorations.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT action,COUNT(*) AS count FROM admin_audit_log WHERE target_type='project' GROUP BY action ORDER BY action",
        )
        .all(),
    ).toEqual([
      { action: "project.deleted", count: 1 },
      { action: "project.restored", count: 1 },
    ]);
  });

  it("aggregates local usage by owner and project and labels its incomplete source", async () => {
    const { call, env } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const event = {
      ownerEpicId: "owner",
      keyId: "key",
      projectId: "project",
      routeTemplate: "/v1/offers",
      method: "GET",
      statusCode: 200,
      cacheStatus: "HIT",
      limitOutcome: "ok",
      origin: "",
      clientIp: "",
      userAgent: "",
      country: "US",
      latencyMs: 10,
    };
    recordApiTelemetry(env, event);
    recordApiTelemetry(env, {
      ...event,
      statusCode: 429,
      limitOutcome: "rate_limited",
    });
    recordApiTelemetry(env, {
      ...event,
      ownerEpicId: "other",
      projectId: "other-project",
    });
    vi.setSystemTime(new Date("2026-11-12T12:00:02Z"));
    const users = (await (
      await call("/users?search=owner")
    ).json()) as AdminPage<AdminUser>;
    expect(users.usage.source).toBe("local_buffer");
    expect(users.usage.byId.owner).toMatchObject({
      requests: 2,
      rateLimited: 1,
      errors: 1,
    });
    const projects = (await (
      await call("/projects?owner=owner")
    ).json()) as AdminPage<AdminProject>;
    expect(projects.usage.byId.project).toMatchObject({
      requests: 2,
      rateLimited: 1,
    });
  });

  it("queries remote usage once per page and keeps management available on analytics failure", async () => {
    const { env, call } = setup();
    env.CF_ACCOUNT_ID = "account";
    env.CF_ANALYTICS_API_TOKEN = "token";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ id: "owner", requests: 123, rateLimited: 4, errors: 5 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = (await (
      await call("/users?search=owner")
    ).json()) as AdminPage<AdminUser>;
    expect(page.usage.byId.owner).toMatchObject({
      requests: 123,
      rateLimited: 4,
      errors: 5,
    });
    expect(page.usage.source).toBe("cloudflare_analytics_engine");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body).toContain("FROM egdata_api_usage");
    expect(fetchMock.mock.calls[0][1].body).toContain("index1 IN ('owner')");
    fetchMock.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = (await (
      await call("/projects")
    ).json()) as AdminPage<AdminProject>;
    expect(failed.rows).toHaveLength(2);
    expect(failed.usage).toMatchObject({ source: "unavailable", byId: {} });
  });

  it("reads the inspected user's monthly quota for active free projects, including mixed-tier accounts", async () => {
    const { env, call, sqlite } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    const namespace = env.API_KEY_RATE_LIMITER;
    const limiter = namespace.get(
      namespace.idFromName(accountLimiterObjectName(env, "owner")),
    );
    await limiter.admit({
      keyId: "key",
      projectId: "project",
      ownerEpicId: "owner",
      policies: [
        { name: "global", limit: 120, window: "minute" },
        { name: "monthly", limit: 100_000, window: "month" },
      ],
    });
    const detail = (await (
      await call("/users/owner")
    ).json()) as AdminUserDetail;
    expect(detail.monthlyQuota).toMatchObject({
      used: 1,
      allowance: 100_000,
      remaining: 99_999,
      resetAt: "2026-12-01T00:00:00.000Z",
      status: "ok",
    });
    const other = (await (
      await call("/users/other")
    ).json()) as AdminUserDetail;
    expect(other.monthlyQuota?.used).toBe(0);

    sqlite.exec("UPDATE projects SET tier='pro' WHERE id='project'");
    expect(
      ((await (await call("/users/owner")).json()) as AdminUserDetail)
        .monthlyQuota,
    ).toBeNull();
    sqlite.exec(
      "UPDATE users SET project_limit=2, last_project_created_at=0 WHERE epic_account_id='owner'; INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('free-project','owner','Free','free')",
    );
    expect(
      ((await (await call("/users/owner")).json()) as AdminUserDetail)
        .monthlyQuota?.used,
    ).toBe(1);
    sqlite.exec(
      "UPDATE projects SET deleted_at='2026-11-13' WHERE id='free-project'",
    );
    expect(
      ((await (await call("/users/owner")).json()) as AdminUserDetail)
        .monthlyQuota,
    ).toBeNull();
  });

  it("keeps user details available when the monthly quota service fails", async () => {
    const { env, call } = setup();
    vi.spyOn(env.API_KEY_RATE_LIMITER, "get").mockImplementation(() => {
      throw new Error("unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("/users/owner");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: "owner" },
      monthlyQuota: null,
    });
  });

  it("scopes analytics to the inspected owner across projects and uses the UTC calendar month", async () => {
    const { env, call, sqlite } = setup();
    sqlite.exec(
      "INSERT INTO users(epic_account_id,display_name) VALUES('analytics-owner','Analytics owner')",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    const event = {
      ownerEpicId: "analytics-owner",
      keyId: "key",
      projectId: "one",
      routeTemplate: "/v1/offers",
      method: "GET",
      statusCode: 200,
      cacheStatus: "HIT",
      limitOutcome: "ok",
      origin: "",
      clientIp: "",
      userAgent: "",
      country: "US",
      latencyMs: 10,
    };
    vi.setSystemTime(new Date("2026-10-31T23:59:59Z"));
    recordApiTelemetry(env, event);
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    recordApiTelemetry(env, event);
    recordApiTelemetry(env, {
      ...event,
      projectId: "two",
      cacheStatus: "MISS",
    });
    recordApiTelemetry(env, { ...event, ownerEpicId: "other" });
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    const response = await call(
      "/users/analytics-owner/analytics?ownerEpicId=other",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = (await response.json()) as AnalyticsDashboardSummary;
    expect(data.start).toBe("2026-11-01T00:00:00.000Z");
    expect(data.totals).toMatchObject({
      requests: 2,
      cacheHits: 1,
      cacheHitRate: 50,
    });
    expect(data.timeseries).toHaveLength(1);
    expect(data.timeseries[0]).toMatchObject({ requests: 2, cacheHits: 1 });
    const recent = (await (
      await call("/users/analytics-owner/analytics?range=24")
    ).json()) as AnalyticsDashboardSummary;
    expect(recent.totals.requests).toBe(0);
    expect((await call("/users/owner/analytics?range=invalid")).status).toBe(
      400,
    );
    expect((await call("/users/missing/analytics")).status).toBe(404);
  });

  it("scopes quotaTimeseries in monthly user analytics to admitted free-project requests", async () => {
    const { env, call, sqlite } = setup();
    sqlite.exec(`
      INSERT INTO users(epic_account_id,display_name,project_limit) VALUES('quota-owner','Quota owner',2);
      INSERT INTO projects(id,owner_epic_id,name,slug,tier) VALUES('free-proj','quota-owner','Free','free','free');
      UPDATE users SET last_project_created_at = 0 WHERE epic_account_id = 'quota-owner';
      INSERT INTO projects(id,owner_epic_id,name,slug,tier) VALUES('paid-proj','quota-owner','Paid','paid','pro');
    `);
    vi.useFakeTimers({ toFake: ["Date"] });
    const baseEvent = {
      ownerEpicId: "quota-owner",
      keyId: "key",
      routeTemplate: "/v1/offers",
      method: "GET",
      statusCode: 200,
      cacheStatus: "MISS",
      limitOutcome: "ok",
      origin: "(direct)",
      clientIp: "198.51.100.1",
      userAgent: "curl/8.0",
      country: "ES",
      latencyMs: 12,
    };
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    // Admitted free-project request -> counted in quotaTimeseries
    recordApiTelemetry(env, { ...baseEvent, projectId: "free-proj" });
    // Blocked / rate-limited free-project request -> excluded from quotaTimeseries
    recordApiTelemetry(env, {
      ...baseEvent,
      projectId: "free-proj",
      statusCode: 429,
      limitOutcome: "monthly_quota_exceeded",
    });
    // Admitted paid-project request -> excluded from quotaTimeseries
    recordApiTelemetry(env, { ...baseEvent, projectId: "paid-proj" });
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));

    const monthRes = await call("/users/quota-owner/analytics?range=month");
    expect(monthRes.status).toBe(200);
    const monthData = (await monthRes.json()) as AnalyticsDashboardSummary;
    expect(monthData.totals.requests).toBe(3);
    expect(monthData.quotaTimeseries).toEqual([
      { bucket: "2026-11-05T00:00:00.000Z", requests: 1 },
    ]);

    const rollingRes = await call("/users/quota-owner/analytics?range=24");
    expect(rollingRes.status).toBe(200);
    const rollingData = (await rollingRes.json()) as AnalyticsDashboardSummary;
    expect(rollingData.quotaTimeseries).toBeUndefined();
  });

  it("enforces owner filtering in remote analytics queries and reports service failures", async () => {
    const { env, call } = setup();
    env.CF_ACCOUNT_ID = "account";
    env.CF_ANALYTICS_API_TOKEN = "token";
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await call("/users/owner/analytics?range=24")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.body).toContain("index1 = 'owner'");
    }
    fetchMock.mockImplementation(
      async () => new Response("Unavailable", { status: 503 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("/users/owner/analytics");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ANALYTICS_UNAVAILABLE" },
    });
  });

  it("inspects a user with agreement acceptances, email verification, projects, and requests", async () => {
    const { sqlite, call } = setup();
    expect((await call("/users/missing-user")).status).toBe(404);

    sqlite.exec(`
      INSERT INTO legal_documents(kind,version,edition,sha256,body,published_at) VALUES
        ('terms','2026-11-01','2026-11','terms-sha-1','Terms v1',1700000000000),
        ('terms','2026-11-10','2026-11','terms-sha-2','Terms v2',1700050000000),
        ('privacy','2026-11-01','2026-11','privacy-sha-1','Privacy v1',1700000000000);
      INSERT INTO legal_rollout(id,revision,terms_version,privacy_version)
        VALUES(1,'rev-2','2026-11-10','2026-11-01');
      INSERT INTO developer_profiles(owner_id,contact_email,verified_at,pending_email) VALUES
        ('admin','admin@example.com',1700100000000,NULL),
        ('owner','dev@example.com',1700100000000,'next@example.com');
      INSERT INTO legal_acceptances(owner_id,version,edition,sha256,accepted_at,requirement_revision,retain_until,receipt_id,privacy_version,privacy_sha256) VALUES
        ('admin','2026-11-10','2026-11','terms-sha-2',1700090000000,'rev-2',NULL,'rcpt_admin','2026-11-01','privacy-sha-1'),
        ('owner','2026-11-01','2026-11','terms-sha-1',1700010000000,'rev-1',1700200000000,'rcpt_old','2026-11-01','privacy-sha-1'),
        ('owner','2026-11-10','2026-11','terms-sha-2',1700090000000,'rev-2',NULL,'rcpt_current','2026-11-01','privacy-sha-1');
      INSERT INTO limit_requests(id,owner_epic_id,project_id,contact_email,requested_tier,requested_rpm,expected_monthly_requests,use_case,status)
        VALUES('lr-1','owner','project','dev@example.com','pro',1000,500000,'Testing','pending');
      INSERT INTO privacy_requests(id,owner_id,case_reference,kind,received_at,due_at,created_by)
        VALUES('pr-1','owner','CASE-42','access',1700100000000,1702692000000,'admin');
    `);

    const ownerRes = await call("/users/owner");
    expect(ownerRes.status).toBe(200);
    const ownerDetail = (await ownerRes.json()) as AdminUserDetail;
    expect(ownerDetail.user).toMatchObject({
      id: "owner",
      displayName: "Owner",
      email: "owner@example.com",
      projectCount: 1,
      keyCount: 3,
      activeKeyCount: 1,
      closedAt: null,
    });
    expect(ownerDetail.onboarding).toEqual({
      rolloutEnabled: true,
      eligible: true,
      revision: "rev-2",
      requiredTermsVersion: "2026-11-10",
      requiredTermsEdition: "2026-11",
      requiredPrivacyVersion: "2026-11-01",
      contactEmail: "dev@example.com",
      pendingEmail: "next@example.com",
      verifiedAt: 1700100000000,
      acceptedCurrent: true,
      acceptedAt: 1700090000000,
    });
    expect(ownerDetail.agreements).toHaveLength(2);
    expect(ownerDetail.agreements[0]).toMatchObject({
      receiptId: "rcpt_current",
      version: "2026-11-10",
      retainUntil: null,
    });
    expect(ownerDetail.projects).toHaveLength(1);
    expect(ownerDetail.limitRequests).toHaveLength(1);
    expect(ownerDetail.privacyRequests).toHaveLength(1);

    const otherDetail = (await (
      await call("/users/other")
    ).json()) as AdminUserDetail;
    expect(otherDetail.onboarding).toMatchObject({
      rolloutEnabled: true,
      eligible: false,
      acceptedCurrent: false,
      acceptedAt: null,
      verifiedAt: null,
    });
    expect(otherDetail.agreements).toEqual([]);
  });

  it("inspects surviving agreement evidence for a closed account", async () => {
    const { sqlite, call } = setup();
    sqlite.exec(`
      INSERT INTO legal_acceptances(owner_id,version,edition,sha256,accepted_at,requirement_revision,retain_until,receipt_id)
        VALUES('closed-user','2026-11-01','2026-11','terms-sha-1',1700010000000,'rev-1',1700500000000,'rcpt_closed');
      INSERT INTO account_closures(owner_id,closed_at,purge_after)
        VALUES('closed-user',1700200000000,1702792000000);
    `);

    const res = await call("/users/closed-user");
    expect(res.status).toBe(200);
    const detail = (await res.json()) as AdminUserDetail;
    expect(detail.user).toMatchObject({
      id: "closed-user",
      displayName: "Closed account",
      closedAt: 1700200000000,
      purgeAfter: 1702792000000,
    });
    expect(detail.onboarding.eligible).toBe(false);
    expect(detail.agreements).toHaveLength(1);
    expect(detail.agreements[0].receiptId).toBe("rcpt_closed");
  });
});
