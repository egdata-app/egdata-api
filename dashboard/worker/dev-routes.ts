import { Hono } from "hono";
import { z } from "zod";
import { invalidateAndSyncProject } from "./billing.js";
import { requireDashboardUser } from "./epic-auth.js";
import { invalidateLocalKeyCache } from "./key-cache.js";
import { isDashboardAdmin } from "./limit-reviews.js";
import { getPlanVersion, PLAN_VERSIONS } from "./plans.js";
import {
  quotaForProject,
  resolveEffectiveProjectEntitlement,
} from "./project-quota.js";
import type { ApiKeyTier, DashboardEnv, EpicSessionUser } from "./types.js";

export function isLocalDevToolsAvailable(
  env: DashboardEnv,
  requestUrl: string,
): boolean {
  const isLocal = ["localhost", "127.0.0.1"].includes(
    new URL(requestUrl).hostname,
  );
  const hasEpicCredentials = Boolean(
    env.EPIC_CLIENT_ID && env.EPIC_CLIENT_SECRET,
  );
  return isLocal && env.ENABLE_DEV_AUTH === "true" && !hasEpicCredentials;
}

const patchStateSchema = z.object({
  isAdmin: z.boolean().optional(),
  projectLimit: z.number().int().min(1).max(100).optional(),
  onboardingVerified: z.boolean().optional(),
  clearWithdrawalBlock: z.boolean().optional(),
  project: z
    .object({
      id: z.string().min(1),
      tier: z.enum(["free", "pro", "scale", "enterprise"]),
      customRpm: z.number().int().min(150).max(500_000).nullable(),
      dailyCapMode: z.enum(["tier", "none", "custom"]).default("tier"),
      dailyCapCustom: z.number().int().min(1).max(1_000_000).nullable().optional(),
    })
    .optional(),
});

export const devRoutes = new Hono<{
  Bindings: DashboardEnv;
  Variables: { user: EpicSessionUser };
}>();

devRoutes.use("*", async (c, next) => {
  if (!isLocalDevToolsAvailable(c.env, c.req.url)) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Not available outside local dev." } },
      404,
    );
  }
  await next();
});

devRoutes.use("*", requireDashboardUser);

async function ensureVerifiedOnboarding(
  db: D1Database,
  epicAccountId: string,
  nowMs: number,
) {
  await db
    .prepare(
      `INSERT INTO developer_profiles (owner_id, contact_email, verified_at)
       VALUES (?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         contact_email = COALESCE(contact_email, excluded.contact_email),
         verified_at = COALESCE(verified_at, excluded.verified_at)`,
    )
    .bind(epicAccountId, `${epicAccountId}@local.dev`, nowMs)
    .run();

  const rollout = await db
    .prepare("SELECT revision, terms_version, privacy_version FROM legal_rollout WHERE id=1")
    .first<{ revision: string; terms_version: string; privacy_version: string }>()
    .catch(() => null);
  if (!rollout) return;

  const [terms, privacy] = await Promise.all([
    db
      .prepare("SELECT edition, sha256 FROM legal_documents WHERE kind='terms' AND version=?")
      .bind(rollout.terms_version)
      .first<{ edition: string; sha256: string }>(),
    db
      .prepare("SELECT sha256 FROM legal_documents WHERE kind='privacy' AND version=?")
      .bind(rollout.privacy_version)
      .first<{ sha256: string }>(),
  ]);
  if (!terms || !privacy) return;

  await db
    .prepare(
      `INSERT OR IGNORE INTO legal_acceptances (
         owner_id, version, edition, sha256, accepted_at,
         requirement_revision, retain_until, receipt_id, privacy_version, privacy_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .bind(
      epicAccountId,
      rollout.terms_version,
      terms.edition,
      terms.sha256,
      nowMs,
      rollout.revision,
      `rcpt_dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      rollout.privacy_version,
      privacy.sha256,
    )
    .run();
}

devRoutes.get("/state", async (c) => {
  const user = c.get("user");
  const projectId = c.req.query("projectId")?.trim() || null;

  const [isAdmin, userRow, profileRow, blockedRow, seedCountRow, projectRow] =
    await Promise.all([
      isDashboardAdmin(c.env, user),
      c.env.DB.prepare(
        "SELECT project_limit AS projectLimit FROM users WHERE epic_account_id=?",
      )
        .bind(user.epicAccountId)
        .first<{ projectLimit: number }>(),
      c.env.DB.prepare(
        "SELECT verified_at AS verifiedAt FROM developer_profiles WHERE owner_id=?",
      )
        .bind(user.epicAccountId)
        .first<{ verifiedAt: number | null }>()
        .catch(() => null),
      c.env.DB.prepare(
        `SELECT 1 AS blocked FROM withdrawal_requests
          WHERE owner_epic_id=? AND request_kind='statutory_withdrawal'
            AND status IN ('refunded_full', 'refunded_partial')
          LIMIT 1`,
      )
        .bind(user.epicAccountId)
        .first<{ blocked: number }>()
        .catch(() => null),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE epic_account_id LIKE 'seed_user_%'",
      )
        .first<{ count: number }>()
        .catch(() => null),
      projectId
        ? c.env.DB.prepare(
            "SELECT id, name, tier, custom_rpm AS customRpm FROM projects WHERE id=? AND owner_epic_id=? AND deleted_at IS NULL",
          )
            .bind(projectId, user.epicAccountId)
            .first<{
              id: string;
              name: string;
              tier: string;
              customRpm: number | null;
            }>()
        : Promise.resolve(null),
    ]);

  const entitlement = projectRow
    ? await resolveEffectiveProjectEntitlement(c.env, {
        projectId: projectRow.id,
        ownerEpicId: user.epicAccountId,
        tier: projectRow.tier as ApiKeyTier,
        customRpm: projectRow.customRpm,
      })
    : null;

  return c.json({
    isAdmin,
    projectLimit: userRow?.projectLimit ?? 1,
    onboardingVerified: Boolean(profileRow?.verifiedAt),
    selfServeCheckoutBlocked: Boolean(blockedRow),
    seededUserCount: seedCountRow?.count ?? 0,
    project: projectRow
      ? {
          id: projectRow.id,
          name: projectRow.name,
          tier: projectRow.tier,
          customRpm: projectRow.customRpm,
          entitlement,
        }
      : null,
  });
});

devRoutes.patch("/state", async (c) => {
  const parsed = patchStateSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      { error: { code: "INVALID_REQUEST", message: "Invalid dev payload." } },
      400,
    );
  }

  const user = c.get("user");
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const {
    isAdmin,
    projectLimit,
    onboardingVerified,
    clearWithdrawalBlock,
    project,
  } = parsed.data;

  if (typeof isAdmin === "boolean") {
    if (isAdmin) {
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO user_roles(user_id, role) VALUES(?, 'admin')",
      )
        .bind(user.epicAccountId)
        .run();
    } else {
      await c.env.DB.prepare(
        "DELETE FROM user_roles WHERE user_id=? AND role='admin'",
      )
        .bind(user.epicAccountId)
        .run();
    }
  }

  if (typeof projectLimit === "number") {
    await c.env.DB.prepare(
      "UPDATE users SET project_limit=?, updated_at=? WHERE epic_account_id=?",
    )
      .bind(projectLimit, nowIso, user.epicAccountId)
      .run();
  }

  if (typeof onboardingVerified === "boolean") {
    if (onboardingVerified) {
      await ensureVerifiedOnboarding(c.env.DB, user.epicAccountId, nowMs);
    } else {
      await c.env.DB.prepare(
        "UPDATE developer_profiles SET verified_at=NULL WHERE owner_id=?",
      )
        .bind(user.epicAccountId)
        .run();
    }
  }

  if (clearWithdrawalBlock) {
    await c.env.DB.prepare(
      `DELETE FROM withdrawal_requests
        WHERE owner_epic_id=? AND request_kind='statutory_withdrawal'`,
    )
      .bind(user.epicAccountId)
      .run()
      .catch(() => {});
  }

  if (project) {
    const owned = await c.env.DB.prepare(
      "SELECT id FROM projects WHERE id=? AND owner_epic_id=? AND deleted_at IS NULL",
    )
      .bind(project.id, user.epicAccountId)
      .first<{ id: string }>();
    if (!owned) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Project not found." } },
        404,
      );
    }

    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE projects SET tier=?, custom_rpm=?, updated_at=? WHERE id=?",
      ).bind(project.tier, project.customRpm, nowIso, project.id),
      c.env.DB.prepare(
        "UPDATE api_keys SET tier=?, custom_rpm=?, updated_at=? WHERE project_id=? AND revoked_at IS NULL",
      ).bind(project.tier, project.customRpm, nowIso, project.id),
      c.env.DB.prepare(
        `UPDATE entitlement_grants SET revoked_at=?, revoked_by=?, updated_at=?
          WHERE project_id=? AND revoked_at IS NULL`,
      ).bind(nowMs, user.epicAccountId, nowIso, project.id),
    ]);

    const shouldCreateManualGrant =
      project.tier !== "free" ||
      project.customRpm !== null ||
      project.dailyCapMode === "custom";

    if (shouldCreateManualGrant) {
      const revRow = await c.env.DB.prepare(
        "SELECT MAX(revision) AS maxRev FROM entitlement_grants WHERE project_id=?",
      )
        .bind(project.id)
        .first<{ maxRev: number | null }>();
      const revision = Math.max(nowMs, (revRow?.maxRev ?? 0) + 1);
      const spec = getPlanVersion(project.tier);
      const rpmLimit =
        project.customRpm ??
        quotaForProject({ tier: project.tier, customRpm: null }, undefined, false);
      const dailyLimit =
        project.dailyCapMode === "none"
          ? null
          : project.dailyCapMode === "custom"
            ? (project.dailyCapCustom ?? 5_000)
            : (spec?.initialDailyLimit ?? null);
      const dailyUntil =
        dailyLimit !== null ? nowMs + 14 * 86_400_000 : null;
      const expensiveLimits = {
        minute: spec
          ? spec.expensiveMinuteLimits
          : PLAN_VERSIONS["scale-v1"].expensiveMinuteLimits,
        period: spec ? spec.expensivePeriodBudgets : undefined,
        entitlements:
          project.tier === "enterprise"
            ? [...PLAN_VERSIONS["scale-v1"].entitlements, "tier:enterprise"]
            : spec
              ? [...spec.entitlements]
              : [...PLAN_VERSIONS["pro-v1"].entitlements],
        initialDailyLimit: dailyLimit,
        initialDailyLimitUntil: dailyUntil,
      };
      const periodAllowance =
        project.tier === "free"
          ? PLAN_VERSIONS["free-v1"].periodAllowance
          : (spec?.periodAllowance ?? null);

      await c.env.DB.prepare(
        `INSERT INTO entitlement_grants (
           id, project_id, owner_epic_id, source, plan_id, plan_version_id,
           tier, rpm_limit, period_allowance, expensive_limits_json,
           effective_from, effective_until, revision, granted_by, reason
         ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
        .bind(
          `grant_dev_${crypto.randomUUID().replace(/-/g, "")}`,
          project.id,
          user.epicAccountId,
          project.tier === "enterprise" ? "enterprise" : project.tier,
          spec ? spec.versionId : "manual-custom",
          project.tier,
          rpmLimit,
          periodAllowance,
          JSON.stringify(expensiveLimits),
          nowMs,
          revision,
          user.epicAccountId,
          "Local dev controls update",
        )
        .run();
    }

    const { results: keys } = await c.env.DB.prepare(
      "SELECT key_hash FROM api_keys WHERE project_id=?",
    )
      .bind(project.id)
      .all<{ key_hash: string }>();
    await Promise.allSettled([
      ...keys.map(async ({ key_hash }) => {
        invalidateLocalKeyCache(key_hash);
        await c.env.API_KEYS_KV.delete(`apikey:${key_hash}`);
      }),
      invalidateAndSyncProject(c.env, project.id, user.epicAccountId, project.tier),
    ]);
  }

  return c.json({ ok: true });
});

devRoutes.post("/seed", async (c) => {
  const user = c.get("user");
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const periodStart = nowMs - 3 * 86_400_000;
  const periodEnd = nowMs + 27 * 86_400_000;
  const dailyUntil = periodStart + 14 * 86_400_000;

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO user_roles(user_id, role) VALUES(?, 'admin')",
    ).bind(user.epicAccountId),
    c.env.DB.prepare(
      `UPDATE users SET project_limit = MAX(project_limit, 5), updated_at=?
        WHERE epic_account_id=?`,
    ).bind(nowIso, user.epicAccountId),
  ]);
  await ensureVerifiedOnboarding(c.env.DB, user.epicAccountId, nowMs);

  const alreadySeeded = await c.env.DB.prepare(
    "SELECT 1 AS found FROM users WHERE epic_account_id='seed_user_pro' LIMIT 1",
  ).first<{ found: number }>();

  if (!alreadySeeded) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO users (epic_account_id, display_name, email, project_limit) VALUES
          ('seed_user_pro', 'Valerie Vance', 'valerie@indietracker.dev', 3),
          ('seed_user_custom', 'Kestrel Analytics', 'platform@kestrel.example', 5),
          ('seed_user_withdrawn', 'Maren Lind', 'maren@nordicgames.example', 2)`,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO developer_profiles (owner_id, contact_email, verified_at) VALUES
          ('seed_user_pro', 'valerie@indietracker.dev', ?),
          ('seed_user_custom', 'platform@kestrel.example', ?),
          ('seed_user_withdrawn', 'maren@nordicgames.example', ?)`,
      ).bind(
        nowMs - 10 * 86_400_000,
        nowMs - 25 * 86_400_000,
        nowMs - 5 * 86_400_000,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO projects (id, owner_epic_id, name, slug, description, website_url, tier, custom_rpm) VALUES
          ('seed_prj_pro', 'seed_user_pro', 'Indie Price Watcher', 'indie-price-watcher', 'Tracks regional store discounts.', 'https://indietracker.dev', 'pro', NULL),
          ('seed_prj_custom', 'seed_user_custom', 'Kestrel Market Index', 'kestrel-market-index', 'Custom enterprise catalog ingest.', 'https://kestrel.example', 'enterprise', 1500),
          ('seed_prj_withdrawn', 'seed_user_withdrawn', 'Nordic Launch Feed', 'nordic-launch-feed', 'Tested Scale plan and withdrew inside 14d.', 'https://nordicgames.example', 'free', NULL)`,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO api_keys (id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active, custom_rpm, last_used_at) VALUES
          ('seed_key_pro', 'seed_prj_pro', 'seed_user_pro', 'Production key', 'egk_seedpro', 'seed_hash_pro_1', 'pro', 1, NULL, ?),
          ('seed_key_custom', 'seed_prj_custom', 'seed_user_custom', 'Warehouse sync', 'egk_seedcust', 'seed_hash_custom_1', 'enterprise', 1, 1500, ?),
          ('seed_key_withdrawn', 'seed_prj_withdrawn', 'seed_user_withdrawn', 'Staging key', 'egk_seedwdr', 'seed_hash_withdrawn_1', 'free', 1, NULL, ?)`,
      ).bind(nowIso, nowIso, nowIso),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO billing_customers (owner_epic_id, stripe_customer_id, environment, email) VALUES
          ('seed_user_pro', 'cus_seed_pro', 'test', 'valerie@indietracker.dev'),
          ('seed_user_withdrawn', 'cus_seed_withdrawn', 'test', 'maren@nordicgames.example')`,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO billing_subscriptions (
           id, owner_epic_id, project_id, stripe_customer_id, stripe_subscription_id,
           stripe_price_id, plan_version_id, status, environment, current_period_start,
           current_period_end, cancel_at_period_end, last_invoice_id, dispute_status,
           refund_status, refunded_eur_cents
         ) VALUES (
           'seed_sub_pro', 'seed_user_pro', 'seed_prj_pro', 'cus_seed_pro', 'sub_seed_pro_1',
           'price_seed_pro', 'pro-v1', 'active', 'test', ?, ?, 0, 'in_seed_pro_1',
           'none', 'none', 0
         ), (
           'seed_sub_withdrawn', 'seed_user_withdrawn', 'seed_prj_withdrawn', 'cus_seed_withdrawn', 'sub_seed_wdr_1',
           'price_seed_scale', 'scale-v1', 'canceled', 'test', ?, ?, 0, 'in_seed_wdr_1',
           'none', 'partial', 1710
         )`,
      ).bind(periodStart, periodEnd, periodStart, periodEnd),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO entitlement_grants (
           id, project_id, owner_epic_id, source, plan_id, plan_version_id, tier,
           rpm_limit, period_allowance, expensive_limits_json, effective_from,
           effective_until, revision, subscription_id, granted_by, reason, revoked_at, revoked_by
         ) VALUES (
           'seed_grant_pro', 'seed_prj_pro', 'seed_user_pro', 'subscription', 'pro', 'pro-v1', 'pro',
           200, 300000, ?, ?, ?, 1, 'seed_sub_pro', 'stripe_webhook', 'Active Pro checkout subscription', NULL, NULL
         ), (
           'seed_grant_custom', 'seed_prj_custom', 'seed_user_custom', 'manual', 'enterprise', 'manual-custom', 'enterprise',
           1500, NULL, ?, ?, NULL, 1, NULL, ?, 'Approved custom enterprise throughput SLA', NULL, NULL
         ), (
           'seed_grant_wdr_revoked', 'seed_prj_withdrawn', 'seed_user_withdrawn', 'subscription', 'scale', 'scale-v1', 'scale',
           600, 1000000, ?, ?, ?, 1, 'seed_sub_withdrawn', 'stripe_webhook', 'Scale checkout subscription', ?, 'self_serve_withdrawal'
         ), (
           'seed_grant_wdr_free', 'seed_prj_withdrawn', 'seed_user_withdrawn', 'free', 'free', 'free-v1', 'free',
           60, 100000, ?, ?, NULL, 2, NULL, 'self_serve_withdrawal', 'Reverted to Free after 14-day statutory withdrawal', NULL, NULL
         )`,
      ).bind(
        JSON.stringify({
          minute: PLAN_VERSIONS["pro-v1"].expensiveMinuteLimits,
          period: PLAN_VERSIONS["pro-v1"].expensivePeriodBudgets,
          entitlements: PLAN_VERSIONS["pro-v1"].entitlements,
          initialDailyLimit: PLAN_VERSIONS["pro-v1"].initialDailyLimit,
          initialDailyLimitUntil: dailyUntil,
        }),
        periodStart,
        periodEnd,
        JSON.stringify({
          minute: PLAN_VERSIONS["scale-v1"].expensiveMinuteLimits,
          entitlements: [
            ...PLAN_VERSIONS["scale-v1"].entitlements,
            "tier:enterprise",
          ],
        }),
        nowMs - 20 * 86_400_000,
        user.epicAccountId,
        JSON.stringify({
          minute: PLAN_VERSIONS["scale-v1"].expensiveMinuteLimits,
          period: PLAN_VERSIONS["scale-v1"].expensivePeriodBudgets,
          entitlements: PLAN_VERSIONS["scale-v1"].entitlements,
          initialDailyLimit: PLAN_VERSIONS["scale-v1"].initialDailyLimit,
          initialDailyLimitUntil: dailyUntil,
        }),
        periodStart,
        periodEnd,
        nowMs - 86_400_000,
        JSON.stringify({
          minute: PLAN_VERSIONS["free-v1"].expensiveMinuteLimits,
          period: PLAN_VERSIONS["free-v1"].expensivePeriodBudgets,
          entitlements: PLAN_VERSIONS["free-v1"].entitlements,
        }),
        nowMs - 86_400_000,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO purchase_receipts (
           id, owner_epic_id, project_id, subscription_id, stripe_checkout_session_id,
           plan_version_id, price_eur_cents, currency, vat_included, terms_version,
           withdrawal_acknowledged, withdrawal_expires_at, action_type, accepted_at
         ) VALUES
           ('seed_rcpt_pro', 'seed_user_pro', 'seed_prj_pro', 'seed_sub_pro', 'cs_seed_pro_1', 'pro-v1', 900, 'eur', 1, '1.0', 1, ?, 'checkout', ?),
           ('seed_rcpt_wdr', 'seed_user_withdrawn', 'seed_prj_withdrawn', 'seed_sub_withdrawn', 'cs_seed_wdr_1', 'scale-v1', 1900, 'eur', 1, '1.0', 1, ?, 'checkout', ?)`,
      ).bind(dailyUntil, periodStart, dailyUntil, periodStart),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO withdrawal_requests (
           id, owner_epic_id, project_id, subscription_id, request_kind, status,
           requested_amount_cents, refunded_amount_cents, stripe_refund_id, reason,
           resolution_note, idempotency_key
         ) VALUES (
           'seed_wdr_1', 'seed_user_withdrawn', 'seed_prj_withdrawn', 'seed_sub_withdrawn',
           'statutory_withdrawal', 'refunded_partial', 1710, 1710, 're_seed_wdr_1',
           'Changed release timeline', 'Pro-rata refund issued inside 14-day withdrawal window; self-serve checkout blocked.', 'seed_idem_wdr_1'
         )`,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO usage_adjustments (
           adjustment_id, project_id, owner_epic_id, scope, window_start, amount, reason, actor_id
         ) VALUES (
           'seed_adj_1', 'seed_prj_pro', 'seed_user_pro', 'period', ?, 50000, 'Backfill migration credit', ?
         )`,
      ).bind(periodStart, user.epicAccountId),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO billing_actions (
           id, owner_epic_id, project_id, subscription_id, actor_id, action, status, details_json
         ) VALUES
           ('seed_bact_pro', 'seed_user_pro', 'seed_prj_pro', 'seed_sub_pro', 'stripe_webhook', 'checkout.session.completed', 'ok', '{"planVersionId":"pro-v1","amountEurCents":900}'),
           ('seed_bact_wdr', 'seed_user_withdrawn', 'seed_prj_withdrawn', 'seed_sub_withdrawn', 'seed_user_withdrawn', 'subscription.statutory_withdrawal', 'ok', '{"refundedEurCents":1710,"prorataRemainingDays":27}')`,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO limit_requests (
           id, owner_epic_id, project_id, contact_email, requested_tier, requested_rpm,
           expected_monthly_requests, use_case, website_url, status, reviewed_by, reviewed_at, review_note
         ) VALUES
           ('seed_lr_approved', 'seed_user_custom', 'seed_prj_custom', 'platform@kestrel.example', 'enterprise', 1500, 8000000, 'Nightly pricing sync across EU storefronts', 'https://kestrel.example', 'approved', ?, ?, 'Approved after capacity review'),
           ('seed_lr_pending', 'seed_user_pro', 'seed_prj_pro', 'valerie@indietracker.dev', 'custom', 800, 1500000, 'Need burst headroom during seasonal sale events', 'https://indietracker.dev', 'pending', NULL, NULL, '')`,
      ).bind(user.epicAccountId, nowIso),
    ]);

    await c.env.DB.prepare(
      `INSERT INTO admin_audit_log (
         actor_id, action, target_type, target_id, project_id, owner_id, reason, before_json, after_json, created_at
       ) VALUES (
         ?, 'project.limits_changed', 'project', 'seed_prj_custom', 'seed_prj_custom', 'seed_user_custom',
         'Approved custom enterprise SLA', '{"tier":"free","customRpm":null}', '{"tier":"enterprise","customRpm":1500}', ?
       )`,
    )
      .bind(user.epicAccountId, nowIso)
      .run()
      .catch(() => {});
  }

  return c.json({ ok: true, adminGranted: true, seededUsers: 3 });
});
