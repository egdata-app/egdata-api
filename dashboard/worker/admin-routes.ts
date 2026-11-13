import { Hono } from "hono";
import { z } from "zod";
import { keyAudit, projectAudit, userAudit } from "./admin-audit.js";
import type {
  AdminAuditEntry,
  AdminProject,
  AdminUser,
  AdminUserAgreement,
  AdminUserDetail,
  AdminUserLimitRequest,
  AdminUserPrivacyRequest,
} from "./admin-types.js";
import {
  getAdminUsage,
  queryDashboardAnalytics,
} from "./analytics-reporting.js";
import { mapApiKeyRow } from "./db.js";
import { invalidateLocalKeyCache } from "./key-cache.js";
import { quotaForProject, readAccountMonthlyQuota } from "./project-quota.js";
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
  .strict()
  .refine((data) => !(data.tier === "free" && data.customRpm !== null), {
    message:
      "Custom RPM overrides require pro or enterprise tier; free tier projects remain subject to the 100,000/month cap.",
  });
const invalid = {
  error: { code: "VALIDATION_ERROR", message: "Invalid fields or pagination." },
};
const missing = { error: { code: "NOT_FOUND", message: "Record not found." } };

async function adminMonthlyQuota(
  env: DashboardEnv,
  ownerId: string,
): Promise<AdminUserDetail["monthlyQuota"]> {
  try {
    return await readAccountMonthlyQuota(env, ownerId);
  } catch {
    console.error("Admin monthly quota unavailable", { ownerId });
    return null;
  }
}

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

adminManagementRoutes.get("/users/:userId", async (c) => {
  const userId = c.req.param("userId");
  const [
    userRow,
    closure,
    profile,
    rollout,
    agreementsResult,
    projectsResult,
    limitRequestsResult,
    privacyRequestsResult,
  ] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
        u.epic_account_id AS id, u.display_name AS displayName, u.email,
        u.preferred_language AS preferredLanguage,
        u.created_at AS createdAt, u.updated_at AS updatedAt,
        u.project_limit AS projectLimit,
        u.last_project_created_at AS lastProjectCreatedAt,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_epic_id=u.epic_account_id AND p.deleted_at IS NULL) AS projectCount,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_epic_id=u.epic_account_id AND p.deleted_at IS NOT NULL) AS deletedProjectCount,
        (SELECT COUNT(*) FROM api_keys k WHERE k.owner_epic_id=u.epic_account_id AND k.revoked_at IS NULL) AS keyCount,
        (SELECT COUNT(*) FROM api_keys k WHERE k.owner_epic_id=u.epic_account_id AND k.revoked_at IS NULL
          AND k.active=1 AND (k.expires_at IS NULL OR julianday(k.expires_at)>julianday('now'))) AS activeKeyCount,
        (SELECT MAX(last_used_at) FROM api_keys k WHERE k.owner_epic_id=u.epic_account_id) AS lastUsedAt,
        EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.epic_account_id AND r.role='admin') AS isAdmin
      FROM users u WHERE u.epic_account_id=?`,
    )
      .bind(userId)
      .first<AdminUserDetail["user"]>(),
    c.env.DB.prepare(
      "SELECT closed_at AS closedAt, purge_after AS purgeAfter FROM account_closures WHERE owner_id=?",
    )
      .bind(userId)
      .first<{ closedAt: number; purgeAfter: number }>(),
    c.env.DB.prepare(
      "SELECT contact_email, pending_email, verified_at FROM developer_profiles WHERE owner_id=?",
    )
      .bind(userId)
      .first<{
        contact_email: string | null;
        pending_email: string | null;
        verified_at: number | null;
      }>(),
    c.env.DB.prepare(
      "SELECT revision, terms_version, privacy_version FROM legal_rollout WHERE id=1",
    ).first<{
      revision: string;
      terms_version: string;
      privacy_version: string;
    }>(),
    c.env.DB.prepare(
      `SELECT receipt_id AS receiptId, version, edition, sha256,
        accepted_at AS acceptedAt, requirement_revision AS requirementRevision,
        privacy_version AS privacyVersion, privacy_sha256 AS privacySha256,
        retain_until AS retainUntil
      FROM legal_acceptances WHERE owner_id=?
      ORDER BY accepted_at DESC, version ASC`,
    )
      .bind(userId)
      .all<AdminUserAgreement>(),
    c.env.DB.prepare(
      `SELECT p.id, p.owner_epic_id AS ownerEpicId,
        p.name, p.slug, p.description, p.website_url AS websiteUrl, p.tier,
        p.custom_rpm AS customRpm, p.created_at AS createdAt, p.updated_at AS updatedAt,
        p.deleted_at AS deletedAt, p.deleted_by AS deletedBy, p.deletion_reason AS deletionReason, p.purge_after AS purgeAfter,
        COALESCE(u.display_name, '') AS ownerDisplayName,
        (SELECT COUNT(*) FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL) AS keyCount,
        (SELECT COUNT(*) FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL
          AND k.active=1 AND (k.expires_at IS NULL OR julianday(k.expires_at)>julianday('now'))) AS activeKeyCount,
        (SELECT MAX(last_used_at) FROM api_keys k WHERE k.project_id=p.id) AS lastUsedAt
      FROM projects p LEFT JOIN users u ON u.epic_account_id=p.owner_epic_id
      WHERE p.owner_epic_id=?
      ORDER BY p.deleted_at IS NOT NULL ASC, p.created_at DESC, p.id ASC`,
    )
      .bind(userId)
      .all<AdminProject>(),
    c.env.DB.prepare(
      `SELECT id, project_id AS projectId, requested_tier AS requestedTier,
        requested_rpm AS requestedRpm, expected_monthly_requests AS expectedMonthlyRequests,
        status, created_at AS createdAt, reviewed_at AS reviewedAt,
        reviewed_by AS reviewedBy, review_note AS reviewNote
      FROM limit_requests WHERE owner_epic_id=?
      ORDER BY created_at DESC LIMIT 25`,
    )
      .bind(userId)
      .all<AdminUserLimitRequest>(),
    c.env.DB.prepare(
      `SELECT id, case_reference AS caseReference, kind, received_at AS receivedAt,
        due_at AS dueAt, extended_due_at AS extendedDueAt,
        resolved_at AS resolvedAt, resolution
      FROM privacy_requests WHERE owner_id=?
      ORDER BY received_at DESC LIMIT 25`,
    )
      .bind(userId)
      .all<AdminUserPrivacyRequest>(),
  ]);

  const agreements = agreementsResult.results;
  if (!userRow && !closure && agreements.length === 0) {
    return c.json(missing, 404);
  }

  let requiredTermsEdition: string | null = null;
  if (rollout) {
    const termsDoc = await c.env.DB.prepare(
      "SELECT edition FROM legal_documents WHERE kind='terms' AND version=?",
    )
      .bind(rollout.terms_version)
      .first<{ edition: string }>();
    requiredTermsEdition = termsDoc?.edition ?? null;
  }

  const currentAcceptances = requiredTermsEdition
    ? agreements
        .filter(
          (item) =>
            item.retainUntil === null && item.edition === requiredTermsEdition,
        )
        .sort((a, b) => a.acceptedAt - b.acceptedAt)
    : [];
  const acceptedAt = currentAcceptances[0]?.acceptedAt ?? null;
  const acceptedCurrent = acceptedAt !== null;
  const verifiedAt = profile?.verified_at ?? null;
  const rolloutEnabled = Boolean(rollout);
  const eligible = closure
    ? false
    : rolloutEnabled
      ? Boolean(acceptedCurrent && verifiedAt)
      : true;

  const projects = projectsResult.results.map((row) => ({
    ...row,
    effectiveRpm: quotaForProject(row),
  }));

  const user: AdminUserDetail["user"] = userRow
    ? {
        ...userRow,
        closedAt: closure?.closedAt ?? null,
        purgeAfter: closure?.purgeAfter ?? null,
      }
    : {
        id: userId,
        displayName: "Closed account",
        email: null,
        preferredLanguage: null,
        createdAt: closure
          ? new Date(closure.closedAt).toISOString()
          : new Date(
              agreements[agreements.length - 1].acceptedAt,
            ).toISOString(),
        updatedAt: closure
          ? new Date(closure.closedAt).toISOString()
          : new Date(agreements[0].acceptedAt).toISOString(),
        projectLimit: 0,
        lastProjectCreatedAt: null,
        projectCount: 0,
        deletedProjectCount: 0,
        keyCount: 0,
        activeKeyCount: 0,
        lastUsedAt: null,
        isAdmin: 0,
        closedAt: closure?.closedAt ?? null,
        purgeAfter: closure?.purgeAfter ?? null,
      };

  const [monthlyQuota, usage] = await Promise.all([
    !user.closedAt &&
    projects.some((project) => !project.deletedAt && project.tier === "free")
      ? adminMonthlyQuota(c.env, userId)
      : null,
    getAdminUsage(c.env, "users", [userId]),
  ]);

  const detail: AdminUserDetail = {
    monthlyQuota,
    user,
    onboarding: {
      rolloutEnabled,
      eligible,
      revision: rollout?.revision ?? null,
      requiredTermsVersion: rollout?.terms_version ?? null,
      requiredTermsEdition,
      requiredPrivacyVersion: rollout?.privacy_version ?? null,
      contactEmail: profile?.contact_email ?? null,
      pendingEmail: profile?.pending_email ?? null,
      verifiedAt,
      acceptedCurrent,
      acceptedAt,
    },
    agreements,
    projects,
    limitRequests: limitRequestsResult.results,
    privacyRequests: privacyRequestsResult.results,
    usage,
  };

  return c.json(detail);
});

adminManagementRoutes.get("/users/:userId/analytics", async (c) => {
  const parsed = z
    .enum(["month", "6", "24", "168", "720"])
    .default("month")
    .safeParse(c.req.query("range"));
  if (!parsed.success) return c.json(invalid, 400);
  const ownerEpicId = c.req.param("userId");
  const user = await c.env.DB.prepare(
    "SELECT epic_account_id FROM users WHERE epic_account_id=?",
  )
    .bind(ownerEpicId)
    .first();
  if (!user) return c.json(missing, 404);

  const end = new Date(Math.floor(Date.now() / 1000) * 1000);
  const monthStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
  const hours =
    parsed.data === "month"
      ? (end.getTime() - monthStart) / 3600_000
      : Number(parsed.data);
  try {
    return c.json(
      await queryDashboardAnalytics(c.env, {
        ownerEpicId,
        hours,
        end: end.toISOString(),
      }),
    );
  } catch (error) {
    console.error("Admin user analytics unavailable", {
      ownerId: ownerEpicId,
      error,
    });
    return c.json(
      {
        error: {
          code: "ANALYTICS_UNAVAILABLE",
          message: "User analytics are temporarily unavailable. Please retry.",
        },
      },
      503,
    );
  }
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
  if (!parsed.success) {
    const customMessage = parsed.error.issues.find(
      (issue) => issue.code === "custom",
    )?.message;
    if (customMessage) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: customMessage } },
        400,
      );
    }
    return c.json(invalid, 400);
  }
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
