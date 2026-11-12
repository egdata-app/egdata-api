import { Hono } from "hono";
import { z } from "zod";
import { projectAudit } from "./admin-audit.js";
import { adminManagementRoutes } from "./admin-routes.js";
import { requireDashboardUser } from "./epic-auth.js";
import { invalidateLocalKeyCache } from "./key-cache.js";
import type {
  DashboardEnv,
  EpicSessionUser,
  LimitIncreaseRequestRecord,
} from "./types.js";

export async function isDashboardAdmin(
  env: DashboardEnv,
  user: EpicSessionUser | null,
): Promise<boolean> {
  if (!user) return false;
  const role = await env.DB.prepare(
    "SELECT role FROM user_roles WHERE user_id=? AND role='admin'",
  )
    .bind(user.epicAccountId)
    .first<{ role: string }>();
  return role !== null;
}

const selection = `SELECT lr.id, lr.owner_epic_id AS ownerEpicId, lr.project_id AS projectId,
  p.name AS projectName, u.display_name AS ownerDisplayName,
  lr.contact_email AS contactEmail, lr.requested_tier AS requestedTier,
  lr.requested_rpm AS requestedRpm, lr.expected_monthly_requests AS expectedMonthlyRequests,
  lr.use_case AS useCase, lr.website_url AS websiteUrl, lr.status,
  lr.email_delivery_status AS emailDeliveryStatus, lr.created_at AS createdAt,
  lr.reviewed_by AS reviewedBy, lr.reviewed_at AS reviewedAt, lr.review_note AS reviewNote
  FROM limit_requests lr JOIN projects p ON p.id=lr.project_id AND p.deleted_at IS NULL
  JOIN users u ON u.epic_account_id=lr.owner_epic_id`;

export const limitReviewRoutes = new Hono<{
  Bindings: DashboardEnv;
  Variables: { user: EpicSessionUser };
}>();

limitReviewRoutes.use("*", requireDashboardUser);
limitReviewRoutes.use("*", async (c, next) => {
  if (!(await isDashboardAdmin(c.env, c.get("user")))) {
    return c.json(
      {
        error: { code: "FORBIDDEN", message: "Administrator access required." },
      },
      403,
    );
  }
  await next();
});

const listSchema = z.object({
  status: z.enum(["pending", "approved", "declined"]).default("pending"),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

limitReviewRoutes.route("/", adminManagementRoutes);

limitReviewRoutes.get("/limit-requests", async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid status or offset.",
        },
      },
      400,
    );
  const { results } = await c.env.DB.prepare(
    `${selection} WHERE lr.status=? ORDER BY lr.created_at ASC, lr.id ASC LIMIT 26 OFFSET ?`,
  )
    .bind(parsed.data.status, parsed.data.offset)
    .all<LimitIncreaseRequestRecord>();
  return c.json({
    requests: results.slice(0, 25),
    hasMore: results.length > 25,
  });
});

const reviewSchema = z
  .object({
    decision: z.enum(["approved", "declined"]),
    note: z.string().trim().max(2000).default(""),
  })
  .strict();

limitReviewRoutes.post("/limit-requests/:requestId/review", async (c) => {
  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Choose approve or decline and a note of at most 2,000 characters.",
        },
      },
      400,
    );
  const id = c.req.param("requestId");
  const request = await c.env.DB.prepare(`${selection} WHERE lr.id=?`)
    .bind(id)
    .first<LimitIncreaseRequestRecord>();
  if (!request)
    return c.json(
      { error: { code: "NOT_FOUND", message: "Request not found." } },
      404,
    );
  if (request.status !== "pending")
    return c.json(
      {
        error: {
          code: "ALREADY_REVIEWED",
          message: "This request has already been reviewed. Refresh the list.",
        },
      },
      409,
    );

  const { decision, note } = parsed.data;
  const now = new Date().toISOString();
  const reviewer = c.get("user").epicAccountId;
  const statements: D1PreparedStatement[] = [];
  if (decision === "approved") {
    const tier =
      request.requestedTier === "custom" ? "enterprise" : request.requestedTier;
    // D1 batches are transactions. Every write checks the still-pending request,
    // so a competing review cannot change limits after another decision wins.
    statements.push(
      projectAudit(
        c.env.DB,
        {
          actor: reviewer,
          action: "project.limits_changed",
          reason: note || `Approved limit request ${id}`,
          now,
          after: { tier, customRpm: request.requestedRpm, requestId: id },
        },
        "id=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM limit_requests WHERE id=? AND status='pending')",
        [request.projectId, id],
      ),
      c.env.DB.prepare(`UPDATE projects SET tier=?, custom_rpm=?, updated_at=?
        WHERE id=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM limit_requests WHERE id=? AND status='pending')`).bind(
        tier,
        request.requestedRpm,
        now,
        request.projectId,
        id,
      ),
      c.env.DB.prepare(`UPDATE api_keys SET tier=?, custom_rpm=?, updated_at=?
        WHERE project_id=? AND revoked_at IS NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM limit_requests WHERE id=? AND status='pending')`).bind(
        tier,
        request.requestedRpm,
        now,
        request.projectId,
        id,
      ),
    );
  }
  statements.push(
    c.env.DB.prepare(`UPDATE limit_requests SET status=?, reviewed_by=?, reviewed_at=?, review_note=?
    WHERE id=? AND status='pending' AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`).bind(
      decision,
      reviewer,
      now,
      note,
      id,
    ),
  );
  const result = await c.env.DB.batch(statements);
  if (result[result.length - 1].meta.changes !== 1) {
    return c.json(
      {
        error: {
          code: "ALREADY_REVIEWED",
          message: "This request has already been reviewed. Refresh the list.",
        },
      },
      409,
    );
  }

  if (decision === "approved") {
    // Invalidate instead of publishing a metadata snapshot that could race a
    // key revocation or permission edit. Existing cache deadlines bound staleness.
    try {
      const { results: keys } = await c.env.DB.prepare(
        "SELECT key_hash FROM api_keys WHERE project_id=?",
      )
        .bind(request.projectId)
        .all<{ key_hash: string }>();
      const invalidations = await Promise.allSettled(
        keys.map(async (key) => {
          invalidateLocalKeyCache(key.key_hash);
          await c.env.API_KEYS_KV.delete(`apikey:${key.key_hash}`);
        }),
      );
      if (invalidations.some((entry) => entry.status === "rejected")) {
        console.error(
          "Limit review saved; some key caches will refresh at expiration",
          { requestId: id },
        );
      }
    } catch (error) {
      console.error(
        "Limit review saved; key caches will refresh at expiration",
        { requestId: id, error },
      );
    }
  }
  return c.json({
    request: {
      ...request,
      status: decision,
      reviewedBy: reviewer,
      reviewedAt: now,
      reviewNote: note,
    },
    quotaPropagationSeconds: decision === "approved" ? 300 : 0,
  });
});
