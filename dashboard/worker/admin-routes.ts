import { Hono } from "hono";
import { z } from "zod";
import { keyAudit, projectAudit, userAudit } from "./admin-audit.js";
import type {
  AdminAuditEntry,
  AdminProject,
  AdminUser,
} from "./admin-types.js";
import { getAdminUsage } from "./analytics-reporting.js";
import { mapApiKeyRow } from "./db.js";
import { invalidateLocalKeyCache } from "./key-cache.js";
import { quotaForProject } from "./project-quota.js";
import { PROJECT_RECOVERY_DAYS } from "./project-retention.js";
import type { DashboardEnv, EpicSessionUser } from "./types.js";

// Mounted inside limitReviewRoutes, after its session and DB admin-role guards.
export const adminManagementRoutes = new Hono<{
  Bindings: DashboardEnv;
  Variables: { user: EpicSessionUser };
}>();

const listSchema = z.object({
  search: z.string().trim().max(200).default(""),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  owner: z.string().max(128).default(""),
  status: z.enum(["active", "deleted"]).default("active"),
});
const reasonSchema = z.string().trim().min(3).max(2000);
const reasonBody = z.object({ reason: reasonSchema }).strict();
const userLimitsSchema = z
  .object({
    projectLimit: z.number().int().min(1).max(100),
    reason: reasonSchema,
  })
  .strict();
const projectLimitsSchema = z
  .object({
    tier: z.enum(["free", "pro", "enterprise"]),
    // Match projects.custom_rpm in migration 0004_limit_request_reviews.sql.
    customRpm: z.number().int().min(150).max(500_000).nullable(),
    reason: reasonSchema,
  })
  .strict();
const invalid = {
  error: { code: "VALIDATION_ERROR", message: "Invalid fields or pagination." },
};
const missing = { error: { code: "NOT_FOUND", message: "Record not found." } };

// Never publish a metadata snapshot that could race a revocation or limit edit.
async function invalidateKeys(env: DashboardEnv, keys: { key_hash: string }[]) {
  const results = await Promise.allSettled(
    keys.map(async ({ key_hash }) => {
      invalidateLocalKeyCache(key_hash);
      await env.API_KEYS_KV.delete(`apikey:${key_hash}`);
    }),
  );
  if (results.some((result) => result.status === "rejected")) {
    console.error("Admin change saved; key caches will refresh at expiration");
  }
}

adminManagementRoutes.get("/users", async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json(invalid, 400);
  const { search, offset } = parsed.data;
  const { results } = await c.env.DB.prepare(`SELECT
    u.epic_account_id AS id, u.display_name AS displayName, u.email,
    u.created_at AS createdAt, u.project_limit AS projectLimit,
    (SELECT COUNT(*) FROM projects p WHERE p.owner_epic_id=u.epic_account_id AND p.deleted_at IS NULL) AS projectCount,
    (SELECT COUNT(*) FROM api_keys k WHERE k.owner_epic_id=u.epic_account_id AND k.revoked_at IS NULL) AS keyCount,
    (SELECT COUNT(*) FROM api_keys k WHERE k.owner_epic_id=u.epic_account_id AND k.revoked_at IS NULL
      AND k.active=1 AND (k.expires_at IS NULL OR julianday(k.expires_at)>julianday('now'))) AS activeKeyCount,
    (SELECT MAX(last_used_at) FROM api_keys k WHERE k.owner_epic_id=u.epic_account_id) AS lastUsedAt,
    EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.epic_account_id AND r.role='admin') AS isAdmin
    FROM users u WHERE instr(lower(u.display_name),lower(?))>0
      OR instr(lower(u.epic_account_id),lower(?))>0 OR instr(lower(u.email),lower(?))>0
    ORDER BY u.created_at DESC, u.epic_account_id ASC LIMIT 26 OFFSET ?`)
    .bind(search, search, search, offset)
    .all<AdminUser>();
  const rows = results.slice(0, 25);
  return c.json({
    rows,
    hasMore: results.length > 25,
    usage: await getAdminUsage(
      c.env,
      "users",
      rows.map((row) => row.id),
    ),
  });
});

adminManagementRoutes.patch("/users/:userId/limits", async (c) => {
  const parsed = userLimitsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json(invalid, 400);
  const id = c.req.param("userId");
  const result = await c.env.DB.batch([
    userAudit(
      c.env.DB,
      {
        actor: c.get("user").epicAccountId,
        action: "user.limits_changed",
        reason: parsed.data.reason,
        now: new Date().toISOString(),
        after: { projectLimit: parsed.data.projectLimit },
      },
      id,
    ),
    c.env.DB.prepare(
      "UPDATE users SET project_limit=? WHERE epic_account_id=?",
    ).bind(parsed.data.projectLimit, id),
  ]);
  if (!result[1].meta.changes) return c.json(missing, 404);
  return c.json({ ok: true });
});

adminManagementRoutes.get("/projects", async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json(invalid, 400);
  const { search, owner, offset, status } = parsed.data;
  const { results } =
    await c.env.DB.prepare(`SELECT p.id, p.owner_epic_id AS ownerEpicId,
    p.name, p.slug, p.description, p.website_url AS websiteUrl, p.tier,
    p.custom_rpm AS customRpm, p.created_at AS createdAt, p.updated_at AS updatedAt,
    p.deleted_at AS deletedAt, p.deleted_by AS deletedBy, p.deletion_reason AS deletionReason, p.purge_after AS purgeAfter,
    u.display_name AS ownerDisplayName,
    (SELECT COUNT(*) FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL) AS keyCount,
    (SELECT COUNT(*) FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL
      AND k.active=1 AND (k.expires_at IS NULL OR julianday(k.expires_at)>julianday('now'))) AS activeKeyCount,
    (SELECT MAX(last_used_at) FROM api_keys k WHERE k.project_id=p.id) AS lastUsedAt
    FROM projects p JOIN users u ON u.epic_account_id=p.owner_epic_id
    WHERE ${status === "deleted" ? "p.deleted_at IS NOT NULL" : "p.deleted_at IS NULL"}
      AND (?='' OR p.owner_epic_id=?) AND (instr(lower(p.name),lower(?))>0
      OR instr(lower(p.id),lower(?))>0 OR instr(lower(u.display_name),lower(?))>0
      OR instr(lower(p.owner_epic_id),lower(?))>0)
    ORDER BY p.created_at DESC, p.id ASC LIMIT 26 OFFSET ?`)
      .bind(owner, owner, search, search, search, search, offset)
      .all<AdminProject>();
  const rows = results
    .slice(0, 25)
    .map((row) => ({ ...row, effectiveRpm: quotaForProject(row) }));
  return c.json({
    rows,
    hasMore: results.length > 25,
    usage: await getAdminUsage(
      c.env,
      "projects",
      rows.map((row) => row.id),
    ),
  });
});

adminManagementRoutes.patch("/projects/:projectId/limits", async (c) => {
  const parsed = projectLimitsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json(invalid, 400);
  const id = c.req.param("projectId");
  const { tier, customRpm } = parsed.data;
  const now = new Date().toISOString();
  const result = await c.env.DB.batch([
    projectAudit(
      c.env.DB,
      {
        actor: c.get("user").epicAccountId,
        action: "project.limits_changed",
        reason: parsed.data.reason,
        now,
        after: { tier, customRpm },
      },
      "id=? AND deleted_at IS NULL",
      [id],
    ),
    c.env.DB.prepare(
      "UPDATE projects SET tier=?, custom_rpm=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
    ).bind(tier, customRpm, now, id),
    c.env.DB.prepare(
      "UPDATE api_keys SET tier=?, custom_rpm=?, updated_at=? WHERE project_id=? AND revoked_at IS NULL AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)",
    ).bind(tier, customRpm, now, id),
  ]);
  if (!result[1].meta.changes) return c.json(missing, 404);
  const { results: keys } = await c.env.DB.prepare(
    "SELECT key_hash FROM api_keys WHERE project_id=?",
  )
    .bind(id)
    .all<{ key_hash: string }>();
  await invalidateKeys(c.env, keys);
  return c.json({ ok: true, quotaPropagationSeconds: 300 });
});

adminManagementRoutes.get("/projects/:projectId/keys", async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json(invalid, 400);
  const id = c.req.param("projectId");
  const project = await c.env.DB.prepare(
    "SELECT owner_epic_id FROM projects WHERE id=?",
  )
    .bind(id)
    .first<{ owner_epic_id: string }>();
  if (!project) return c.json(missing, 404);
  const { results } = await c.env.DB.prepare(`SELECT k.*, p.tier, p.custom_rpm
    FROM api_keys k JOIN projects p ON p.id=k.project_id WHERE k.project_id=? ORDER BY k.created_at DESC,k.id LIMIT 26 OFFSET ?`)
    .bind(id, parsed.data.offset)
    .all<Parameters<typeof mapApiKeyRow>[0]>();
  return c.json({
    keys: results.slice(0, 25).map(mapApiKeyRow),
    hasMore: results.length > 25,
  });
});

adminManagementRoutes.delete("/keys/:keyId", async (c) => {
  const parsed = reasonBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid, 400);
  const id = c.req.param("keyId");
  const key = await c.env.DB.prepare(
    "SELECT key_hash FROM api_keys WHERE id=? AND revoked_at IS NULL",
  )
    .bind(id)
    .first<{ key_hash: string }>();
  if (!key) return c.json(missing, 404);
  const now = new Date().toISOString();
  const result = await c.env.DB.batch([
    keyAudit(
      c.env.DB,
      {
        actor: c.get("user").epicAccountId,
        action: "key.revoked",
        reason: parsed.data.reason,
        now,
        after: { active: false, revokedAt: now },
      },
      "id=? AND revoked_at IS NULL",
      [id],
    ),
    c.env.DB.prepare(
      "UPDATE api_keys SET active=0,revoked_at=?,updated_at=? WHERE id=? AND revoked_at IS NULL",
    ).bind(now, now, id),
  ]);
  if (!result[1].meta.changes) return c.json(missing, 404);
  await invalidateKeys(c.env, [key]);
  return c.json({ ok: true, quotaPropagationSeconds: 300 });
});

adminManagementRoutes.delete("/projects/:projectId", async (c) => {
  const parsed = reasonBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid, 400);
  const id = c.req.param("projectId");
  const { results: keys } = await c.env.DB.prepare(
    "SELECT key_hash FROM api_keys WHERE project_id=?",
  )
    .bind(id)
    .all<{ key_hash: string }>();
  const now = new Date().toISOString();
  const purgeAfter = new Date(
    Date.now() + PROJECT_RECOVERY_DAYS * 86400_000,
  ).toISOString();
  const actor = c.get("user").epicAccountId;
  const reason = parsed.data.reason;
  // Keep records for support, but permanently revoke credentials. Restoring a
  // project requires issuing new keys and console sessions.
  const result = await c.env.DB.batch([
    projectAudit(
      c.env.DB,
      {
        actor,
        action: "project.deleted",
        reason,
        now,
        after: { deletedAt: now, purgeAfter },
      },
      "id=? AND deleted_at IS NULL",
      [id],
    ),
    keyAudit(
      c.env.DB,
      {
        actor,
        action: "key.revoked",
        reason: `Project deletion: ${reason}`,
        now,
        after: { active: false, revokedAt: now },
      },
      "project_id=? AND revoked_at IS NULL AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)",
      [id],
    ),
    c.env.DB.prepare(`UPDATE api_keys SET active=0,revoked_at=?,updated_at=? WHERE project_id=? AND revoked_at IS NULL
      AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`).bind(
      now,
      now,
      id,
    ),
    c.env.DB.prepare("DELETE FROM console_sessions WHERE project_id=?").bind(
      id,
    ),
    c.env.DB.prepare(
      "UPDATE projects SET deleted_at=?,deleted_by=?,deletion_reason=?,purge_after=?,updated_at=? WHERE id=? AND deleted_at IS NULL",
    ).bind(now, actor, reason, purgeAfter, now, id),
  ]);
  if (!result[result.length - 1].meta.changes) return c.json(missing, 404);
  await invalidateKeys(c.env, keys);
  return c.json({ ok: true, quotaPropagationSeconds: 300 });
});

adminManagementRoutes.post("/projects/:projectId/restore", async (c) => {
  const parsed = reasonBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid, 400);
  const id = c.req.param("projectId");
  const now = new Date().toISOString();
  const condition = `id=? AND deleted_at IS NOT NULL AND purge_after>?
    AND (SELECT COUNT(*) FROM projects active WHERE active.owner_epic_id=projects.owner_epic_id AND active.deleted_at IS NULL)
      < (SELECT project_limit FROM users WHERE epic_account_id=projects.owner_epic_id)`;
  const result = await c.env.DB.batch([
    projectAudit(
      c.env.DB,
      {
        actor: c.get("user").epicAccountId,
        action: "project.restored",
        reason: parsed.data.reason,
        now,
        after: { deletedAt: null, keysRemainRevoked: true },
      },
      condition,
      [id, now],
    ),
    c.env.DB.prepare(
      `UPDATE projects SET deleted_at=NULL,deleted_by=NULL,deletion_reason=NULL,purge_after=NULL,updated_at=? WHERE ${condition}`,
    ).bind(now, id, now),
  ]);
  if (!result[1].meta.changes)
    return c.json(
      {
        error: {
          code: "RESTORE_UNAVAILABLE",
          message:
            "Project is not recoverable or the owner's project limit has been reached. Refresh the list or increase the owner's limit.",
        },
      },
      409,
    );
  return c.json({ ok: true });
});

adminManagementRoutes.get("/audit", async (c) => {
  const parsed = z
    .object({
      projectId: z.string().max(128).default(""),
      owner: z.string().max(128).default(""),
      offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    })
    .safeParse(c.req.query());
  if (!parsed.success) return c.json(invalid, 400);
  const { projectId, owner, offset } = parsed.data;
  const { results } =
    await c.env.DB.prepare(`SELECT sequence,actor_id AS actorId,action,target_type AS targetType,target_id AS targetId,
    project_id AS projectId,owner_id AS ownerId,reason,before_json,after_json,created_at AS createdAt
    FROM admin_audit_log WHERE (?='' OR project_id=?) AND (?='' OR owner_id=?) ORDER BY sequence DESC LIMIT 26 OFFSET ?`)
      .bind(projectId, projectId, owner, owner, offset)
      .all<
        Omit<AdminAuditEntry, "before" | "after"> & {
          before_json: string;
          after_json: string;
        }
      >();
  return c.json({
    rows: results.slice(0, 25).map(({ before_json, after_json, ...entry }) => ({
      ...entry,
      before: JSON.parse(before_json),
      after: JSON.parse(after_json),
    })),
    hasMore: results.length > 25,
  });
});
