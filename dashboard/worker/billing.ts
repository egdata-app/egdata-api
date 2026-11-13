import { invalidateLocalKeyCache, removeKeyFromKv } from "./key-cache.js";
import {
  BILLING_POLICY_DEFAULTS,
  COMMERCIAL_PUBLIC_PLANS,
  type CommercialPlanId,
  type EffectiveProjectEntitlement,
  getPlanVersion,
  type PlanVersionId,
} from "./plans.js";
import {
  readAccountMonthlyQuota,
  readProjectBillingQuota,
  resolveEffectiveProjectEntitlement,
  syncProjectEntitlementToLimiter,
} from "./project-quota.js";
import {
  cancelStripeSubscription,
  createStripeCheckoutSession,
  createStripeCustomer,
  createStripePortalSession,
  createStripeRefund,
  getStripeEnvironment,
  resolveAllowlistedStripePriceId,
  resolvePlanVersionFromStripePrice,
  retrieveStripeInvoice,
  retrieveStripeSubscription,
  type StripeEnvironment,
  type StripeSubscription,
  updateStripeSubscriptionPlan,
  verifyStripeWebhookSignature,
} from "./stripe.js";
import type { DashboardEnv } from "./types.js";

const DAY_MS = 86_400_000;
const PENDING_CHECKOUT_TTL_MS = 30 * 60_000;

export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

function nextRevision(current: number | null | undefined): number {
  const base = Number.isFinite(current) ? Math.floor(Number(current)) : 0;
  return Math.max(Date.now(), base + 1);
}

async function resolveOwnerContactEmail(
  db: D1Database,
  ownerEpicId: string,
): Promise<string | null> {
  try {
    const profile = await db
      .prepare(
        `SELECT contact_email FROM developer_profiles WHERE owner_id = ? AND verified_at IS NOT NULL LIMIT 1`,
      )
      .bind(ownerEpicId)
      .first<{ contact_email: string }>();
    if (profile?.contact_email) return profile.contact_email;
  } catch {
    // developer_profiles may not exist in minimal schemas
  }
  const user = await db
    .prepare(`SELECT email FROM users WHERE epic_account_id = ? LIMIT 1`)
    .bind(ownerEpicId)
    .first<{ email: string | null }>();
  return user?.email ?? null;
}

async function queueBillingNotification(
  env: DashboardEnv,
  ownerEpicId: string,
  subject: string,
  body: string,
): Promise<void> {
  try {
    const recipient = await resolveOwnerContactEmail(env.DB, ownerEpicId);
    if (!recipient) return;
    await env.DB.prepare(
      `INSERT INTO developer_mail (id, recipient, subject, body, next_attempt_at, leased_until)
       VALUES (?, ?, ?, ?, 0, 0)`,
    )
      .bind(crypto.randomUUID(), recipient, subject, body)
      .run();
  } catch {
    // Non-fatal if developer_mail table is absent in isolated unit tests
  }
}

async function recordBillingAction(
  db: D1Database,
  params: {
    ownerEpicId: string;
    projectId?: string | null;
    subscriptionId?: string | null;
    actorId: string;
    action: string;
    status: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO billing_actions (id, owner_epic_id, project_id, subscription_id, actor_id, action, status, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `bact_${crypto.randomUUID().replace(/-/g, "")}`,
      params.ownerEpicId,
      params.projectId ?? null,
      params.subscriptionId ?? null,
      params.actorId,
      params.action,
      params.status,
      JSON.stringify(params.details ?? {}),
    )
    .run();
}

export async function invalidateAndSyncProject(
  env: DashboardEnv,
  projectId: string,
  ownerEpicId: string,
  fallbackTier: "free" | "pro" | "scale" | "enterprise" = "free",
): Promise<EffectiveProjectEntitlement> {
  const entitlement = await resolveEffectiveProjectEntitlement(env, {
    projectId,
    ownerEpicId,
    tier: fallbackTier,
    customRpm: null,
  });

  await env.DB.prepare(
    `UPDATE projects SET tier = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  )
    .bind(entitlement.tier, projectId)
    .run();

  await env.DB.prepare(
    `UPDATE api_keys SET tier = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE project_id = ? AND revoked_at IS NULL`,
  )
    .bind(entitlement.tier, projectId)
    .run();

  const keys = await env.DB.prepare(
    `SELECT key_hash FROM api_keys WHERE project_id = ?`,
  )
    .bind(projectId)
    .all<{ key_hash: string }>();

  for (const row of keys.results) {
    invalidateLocalKeyCache(row.key_hash);
    if (env.API_KEYS_KV) {
      await removeKeyFromKv(env, row.key_hash).catch(() => {});
    }
  }

  try {
    await syncProjectEntitlementToLimiter(env, entitlement);
  } catch (err) {
    if (entitlement.subscriptionId) {
      await env.DB.prepare(
        `UPDATE billing_subscriptions SET needs_reconcile = 1, reconcile_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
      )
        .bind(
          err instanceof Error ? err.message.slice(0, 500) : "do_sync_failed",
          entitlement.subscriptionId,
        )
        .run()
        .catch(() => {});
    }
    throw err;
  }

  return entitlement;
}

export function getPublicBillingPlans() {
  return {
    currency: BILLING_POLICY_DEFAULTS.currency,
    vatIncludedInConsumerPrices:
      BILLING_POLICY_DEFAULTS.vatIncludedInConsumerPrices,
    defaultVatRatePercent: BILLING_POLICY_DEFAULTS.defaultVatRatePercent,
    gracePeriodDays: BILLING_POLICY_DEFAULTS.gracePeriodDays,
    withdrawalWindowDays: BILLING_POLICY_DEFAULTS.withdrawalWindowDays,
    termsVersion: "2026-11-13",
    plans: COMMERCIAL_PUBLIC_PLANS.map((plan) => ({
      versionId: plan.versionId,
      planId: plan.planId,
      tier: plan.tier,
      displayName: plan.displayName,
      priceEurCents: plan.priceEurCents,
      currency: plan.currency,
      vatIncluded: plan.vatIncluded,
      billingInterval: plan.billingInterval,
      periodType: plan.periodType,
      rpmLimit: plan.rpmLimit,
      periodAllowance: plan.periodAllowance,
      expensiveMinuteLimits: plan.expensiveMinuteLimits,
      expensivePeriodBudgets: plan.expensivePeriodBudgets,
      supportLevel: plan.supportLevel,
      exhaustionBehavior: plan.exhaustionBehavior,
      selfServePurchasable: plan.selfServePurchasable,
    })),
  };
}

export async function getOrCreateStripeCustomer(
  env: DashboardEnv,
  ownerEpicId: string,
  displayName?: string | null,
): Promise<{ stripeCustomerId: string; environment: StripeEnvironment }> {
  const environment = getStripeEnvironment(env);
  const existing = await env.DB.prepare(
    `SELECT stripe_customer_id FROM billing_customers WHERE owner_epic_id = ? AND environment = ? LIMIT 1`,
  )
    .bind(ownerEpicId, environment)
    .first<{ stripe_customer_id: string }>();

  if (existing?.stripe_customer_id) {
    return { stripeCustomerId: existing.stripe_customer_id, environment };
  }

  const email = await resolveOwnerContactEmail(env.DB, ownerEpicId);
  const customer = await createStripeCustomer(
    env,
    { ownerEpicId, email, name: displayName },
    `cust:${environment}:${ownerEpicId}`,
  );

  await env.DB.prepare(
    `INSERT INTO billing_customers (owner_epic_id, stripe_customer_id, environment, email)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_epic_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       environment = excluded.environment,
       email = COALESCE(excluded.email, billing_customers.email),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  )
    .bind(ownerEpicId, customer.id, environment, email ?? null)
    .run();

  return { stripeCustomerId: customer.id, environment };
}

type SubscriptionRow = {
  id: string;
  owner_epic_id: string;
  project_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_price_id: string | null;
  plan_version_id: string;
  pending_plan_version_id: string | null;
  status: string;
  environment: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: number;
  canceled_at: number | null;
  grace_until: number | null;
  last_event_created: number;
  last_invoice_id: string | null;
  dispute_status: string;
  refund_status: string;
  refunded_eur_cents: number;
  needs_reconcile: number;
  reconcile_error: string | null;
  created_at: string;
  updated_at: string;
};

export async function initiateSubscriptionCheckout(
  env: DashboardEnv,
  params: {
    ownerEpicId: string;
    ownerDisplayName?: string;
    projectId: string;
    planId: "pro" | "scale";
    termsVersion: string;
    withdrawalAcknowledged: boolean;
    idempotencyKey?: string;
    successUrl?: string;
    cancelUrl?: string;
  },
) {
  if (!params.withdrawalAcknowledged || !params.termsVersion?.trim()) {
    throw new BillingError(
      "TERMS_AND_WITHDRAWAL_REQUIRED",
      "You must review the EUR VAT-inclusive price, recurring monthly terms, and 14-day statutory withdrawal notice before starting checkout.",
      400,
    );
  }

  const project = await env.DB.prepare(
    `SELECT id, owner_epic_id, name, tier, deleted_at FROM projects WHERE id = ? LIMIT 1`,
  )
    .bind(params.projectId)
    .first<{
      id: string;
      owner_epic_id: string;
      name: string;
      tier: string;
      deleted_at: string | null;
    }>();

  if (!project || project.owner_epic_id !== params.ownerEpicId) {
    throw new BillingError("NOT_FOUND", "Project not found.", 404);
  }
  if (project.deleted_at) {
    throw new BillingError(
      "PROJECT_DELETED",
      "Cannot start billing for a deleted project.",
      409,
    );
  }

  const manualGrant = await env.DB.prepare(
    `SELECT id, source, plan_id FROM entitlement_grants
      WHERE project_id = ? AND source IN ('manual', 'grandfathered')
        AND revoked_at IS NULL AND (effective_until IS NULL OR effective_until > ?)
      LIMIT 1`,
  )
    .bind(project.id, Date.now())
    .first<{ id: string; source: string; plan_id: string }>();

  if (manualGrant && manualGrant.source === "manual") {
    throw new BillingError(
      "MANUAL_GRANT_ACTIVE",
      "This project already has an explicit manual or custom capacity grant. Contact support before switching it to a self-service subscription.",
      409,
    );
  }

  const planVersionId =
    params.planId === "scale" ? "scale-v1" : "pro-v1";
  const spec = getPlanVersion(planVersionId);
  if (!spec || !spec.selfServePurchasable) {
    throw new BillingError("INVALID_PLAN", "Unsupported plan requested.", 400);
  }

  const priceId = resolveAllowlistedStripePriceId(env, params.planId);
  const { stripeCustomerId, environment } = await getOrCreateStripeCustomer(
    env,
    params.ownerEpicId,
    params.ownerDisplayName,
  );

  // Expire stale abandoned checkout_pending rows (> 30 min old) so user can retry cleanly
  const cutoffIso = new Date(Date.now() - PENDING_CHECKOUT_TTL_MS).toISOString();
  await env.DB.prepare(
    `UPDATE billing_subscriptions
        SET status = 'incomplete_expired', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE project_id = ? AND status = 'checkout_pending' AND created_at < ?`,
  )
    .bind(project.id, cutoffIso)
    .run();

  const existingLive = await env.DB.prepare(
    `SELECT id, status, plan_version_id, stripe_checkout_session_id
       FROM billing_subscriptions
      WHERE project_id = ?
        AND status IN ('checkout_pending', 'incomplete', 'trialing', 'active', 'past_due')
      LIMIT 1`,
  )
    .bind(project.id)
    .first<SubscriptionRow>();

  if (existingLive) {
    if (
      existingLive.status === "checkout_pending" &&
      existingLive.stripe_checkout_session_id &&
      existingLive.plan_version_id === spec.versionId
    ) {
      return {
        subscriptionId: existingLive.id,
        checkoutSessionId: existingLive.stripe_checkout_session_id,
        checkoutUrl: null,
        alreadyPending: true,
        planVersionId: spec.versionId,
      };
    }
    throw new BillingError(
      "SUBSCRIPTION_ALREADY_ACTIVE",
      "This project already has an active subscription or pending checkout. Use the Billing Portal or Plan Change controls instead.",
      409,
    );
  }

  const localSubscriptionId = `bsub_${crypto.randomUUID().replace(/-/g, "")}`;
  const nowMs = Date.now();
  const dashboardOrigin = (
    env.DASHBOARD_ORIGIN || "https://devs.egdata.app"
  ).replace(/\/$/, "");
  const successUrl =
    params.successUrl ||
    `${dashboardOrigin}/limits?project=${encodeURIComponent(project.id)}&checkout=success`;
  const cancelUrl =
    params.cancelUrl ||
    `${dashboardOrigin}/limits?project=${encodeURIComponent(project.id)}&checkout=canceled`;

  try {
    await env.DB.prepare(
      `INSERT INTO billing_subscriptions (
         id, owner_epic_id, project_id, stripe_customer_id, stripe_price_id,
         plan_version_id, status, environment, current_period_start, current_period_end
       ) VALUES (?, ?, ?, ?, ?, ?, 'checkout_pending', ?, ?, ?)`,
    )
      .bind(
        localSubscriptionId,
        params.ownerEpicId,
        project.id,
        stripeCustomerId,
        priceId,
        spec.versionId,
        environment,
        nowMs,
        nowMs + 30 * DAY_MS,
      )
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("idx_billing_sub_live_project")) {
      throw new BillingError(
        "SUBSCRIPTION_ALREADY_ACTIVE",
        "A checkout or active subscription is already in progress for this project.",
        409,
      );
    }
    throw err;
  }

  const receiptId = `rcpt_${crypto.randomUUID().replace(/-/g, "")}`;
  const withdrawalExpiresAt =
    nowMs + BILLING_POLICY_DEFAULTS.withdrawalWindowDays * DAY_MS;

  await env.DB.prepare(
    `INSERT INTO purchase_receipts (
       id, owner_epic_id, project_id, subscription_id, plan_version_id,
       price_eur_cents, currency, vat_included, terms_version,
       withdrawal_acknowledged, withdrawal_expires_at, action_type, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, 'checkout', ?)`,
  )
    .bind(
      receiptId,
      params.ownerEpicId,
      project.id,
      localSubscriptionId,
      spec.versionId,
      spec.priceEurCents,
      spec.currency,
      params.termsVersion.trim(),
      withdrawalExpiresAt,
      nowMs,
    )
    .run();

  try {
    const session = await createStripeCheckoutSession(
      env,
      {
        customerId: stripeCustomerId,
        priceId,
        successUrl,
        cancelUrl,
        clientReferenceId: project.id,
        metadata: {
          ownerEpicId: params.ownerEpicId,
          projectId: project.id,
          localSubscriptionId,
          planVersionId: spec.versionId,
          environment,
        },
      },
      params.idempotencyKey || `checkout:${project.id}:${localSubscriptionId}`,
    );

    await env.DB.prepare(
      `UPDATE billing_subscriptions SET stripe_checkout_session_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
    )
      .bind(session.id, localSubscriptionId)
      .run();

    await env.DB.prepare(
      `UPDATE purchase_receipts SET stripe_checkout_session_id = ? WHERE id = ?`,
    )
      .bind(session.id, receiptId)
      .run();

    await recordBillingAction(env.DB, {
      ownerEpicId: params.ownerEpicId,
      projectId: project.id,
      subscriptionId: localSubscriptionId,
      actorId: params.ownerEpicId,
      action: "checkout_initiated",
      status: "ok",
      details: { planVersionId: spec.versionId, receiptId, sessionId: session.id },
    });

    return {
      subscriptionId: localSubscriptionId,
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      alreadyPending: false,
      planVersionId: spec.versionId,
      receiptId,
    };
  } catch (err) {
    await env.DB.prepare(
      `UPDATE billing_subscriptions SET status = 'incomplete_expired', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
    )
      .bind(localSubscriptionId)
      .run()
      .catch(() => {});
    throw err;
  }
}

export async function createCustomerBillingPortalSession(
  env: DashboardEnv,
  params: {
    ownerEpicId: string;
    ownerDisplayName?: string;
    returnUrl?: string;
  },
) {
  const { stripeCustomerId } = await getOrCreateStripeCustomer(
    env,
    params.ownerEpicId,
    params.ownerDisplayName,
  );
  const dashboardOrigin = (
    env.DASHBOARD_ORIGIN || "https://devs.egdata.app"
  ).replace(/\/$/, "");
  const returnUrl = params.returnUrl || `${dashboardOrigin}/limits`;
  const session = await createStripePortalSession(env, {
    customerId: stripeCustomerId,
    returnUrl,
    configurationId: env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() || undefined,
  });
  await recordBillingAction(env.DB, {
    ownerEpicId: params.ownerEpicId,
    actorId: params.ownerEpicId,
    action: "portal_session_created",
    status: "ok",
  });
  return { url: session.url, sessionId: session.id };
}

async function upsertSubscriptionEntitlementGrant(
  env: DashboardEnv,
  params: {
    projectId: string;
    ownerEpicId: string;
    subscriptionId: string;
    planVersionId: PlanVersionId;
    status: string;
    periodStartMs: number;
    periodEndMs: number;
    graceUntilMs: number | null;
    reason: string;
  },
) {
  const spec = getPlanVersion(params.planVersionId);
  if (!spec) {
    throw new Error(`Unknown plan version '${params.planVersionId}'`);
  }

  const nowMs = Date.now();
  const isSuspended =
    params.status === "canceled" ||
    params.status === "incomplete_expired" ||
    params.status === "unpaid" ||
    (params.status === "past_due" &&
      params.graceUntilMs !== null &&
      nowMs >= params.graceUntilMs);

  const latest = await env.DB.prepare(
    `SELECT MAX(revision) AS max_rev FROM entitlement_grants WHERE project_id = ?`,
  )
    .bind(params.projectId)
    .first<{ max_rev: number | null }>();
  const revision = nextRevision(latest?.max_rev);

  await env.DB.prepare(
    `UPDATE entitlement_grants SET revoked_at = ?, revoked_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE project_id = ? AND source = 'subscription' AND revoked_at IS NULL`,
  )
    .bind(nowMs, "billing_lifecycle", params.projectId)
    .run();

  if (!isSuspended) {
    await env.DB.prepare(
      `INSERT INTO entitlement_grants (
         id, project_id, owner_epic_id, source, plan_id, plan_version_id,
         tier, rpm_limit, period_allowance, expensive_limits_json,
         effective_from, effective_until, revision, subscription_id, granted_by, reason
       ) VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stripe_billing', ?)`,
    )
      .bind(
        `grant_${crypto.randomUUID().replace(/-/g, "")}`,
        params.projectId,
        params.ownerEpicId,
        spec.planId,
        spec.versionId,
        spec.tier,
        spec.rpmLimit,
        spec.periodAllowance,
        JSON.stringify({
          minute: spec.expensiveMinuteLimits,
          period: spec.expensivePeriodBudgets,
          entitlements: spec.entitlements,
        }),
        Math.min(nowMs, params.periodStartMs),
        params.periodEndMs,
        revision,
        params.subscriptionId,
        params.reason,
      )
      .run();

    await env.DB.prepare(
      `INSERT INTO usage_periods (
         id, project_id, owner_epic_id, subscription_id, plan_version_id,
         period_start, period_end, included_allowance
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, period_start, period_end) DO UPDATE SET
         plan_version_id = excluded.plan_version_id,
         included_allowance = excluded.included_allowance,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    )
      .bind(
        `up_${crypto.randomUUID().replace(/-/g, "")}`,
        params.projectId,
        params.ownerEpicId,
        params.subscriptionId,
        spec.versionId,
        params.periodStartMs,
        params.periodEndMs,
        spec.periodAllowance,
      )
      .run();
  } else {
    // Reset project/key tier to Free before resolving fallback so invalidateAndSyncProject
    // cannot read a stale paid tier from projects once the subscription grant is revoked.
    await env.DB.prepare(
      `UPDATE projects SET tier = 'free', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(params.projectId)
      .run();
  }

  return invalidateAndSyncProject(env, params.projectId, params.ownerEpicId, "free");
}

export async function changeSubscriptionPlan(
  env: DashboardEnv,
  params: {
    ownerEpicId: string;
    projectId: string;
    targetPlanId: CommercialPlanId;
    idempotencyKey?: string;
  },
) {
  const sub = await env.DB.prepare(
    `SELECT * FROM billing_subscriptions
      WHERE project_id = ? AND owner_epic_id = ?
        AND status IN ('active', 'trialing', 'past_due')
      ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(params.projectId, params.ownerEpicId)
    .first<SubscriptionRow>();

  if (!sub || !sub.stripe_subscription_id) {
    throw new BillingError(
      "NO_ACTIVE_SUBSCRIPTION",
      "No active paid subscription was found for this project.",
      404,
    );
  }

  if (params.targetPlanId === "free") {
    const canceled = await cancelStripeSubscription(
      env,
      sub.stripe_subscription_id,
      { atPeriodEnd: true, cancelNote: "Developer self-service cancel at period end" },
      params.idempotencyKey || `cancel:${sub.id}:${sub.current_period_end}`,
    );
    await env.DB.prepare(
      `UPDATE billing_subscriptions
          SET cancel_at_period_end = 1, pending_plan_version_id = 'free-v1',
              canceled_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(Date.now(), sub.id)
      .run();

    const entitlement = await invalidateAndSyncProject(
      env,
      sub.project_id,
      sub.owner_epic_id,
      "free",
    );
    await recordBillingAction(env.DB, {
      ownerEpicId: params.ownerEpicId,
      projectId: params.projectId,
      subscriptionId: sub.id,
      actorId: params.ownerEpicId,
      action: "subscription_cancel_scheduled",
      status: canceled.cancel_at_period_end ? "scheduled" : canceled.status,
      details: { periodEnd: sub.current_period_end },
    });
    return { entitlement, scheduledForPeriodEnd: true };
  }

  const targetVersionId: PlanVersionId =
    params.targetPlanId === "scale" ? "scale-v1" : "pro-v1";
  const targetSpec = getPlanVersion(targetVersionId)!;
  const currentSpec = getPlanVersion(sub.plan_version_id);

  if (sub.plan_version_id === targetVersionId && !sub.cancel_at_period_end) {
    throw new BillingError(
      "ALREADY_ON_PLAN",
      `This project is already subscribed to ${targetSpec.displayName}.`,
      409,
    );
  }

  const isUpgrade =
    !currentSpec || targetSpec.priceEurCents > currentSpec.priceEurCents;

  if (!isUpgrade && sub.plan_version_id !== targetVersionId) {
    // Scheduled downgrade: retain current plan capacity until period end.
    await env.DB.prepare(
      `UPDATE billing_subscriptions
          SET pending_plan_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(targetVersionId, sub.id)
      .run();

    await recordBillingAction(env.DB, {
      ownerEpicId: params.ownerEpicId,
      projectId: params.projectId,
      subscriptionId: sub.id,
      actorId: params.ownerEpicId,
      action: "subscription_downgrade_scheduled",
      status: "scheduled",
      details: { from: sub.plan_version_id, to: targetVersionId, effectiveAt: sub.current_period_end },
    });

    const entitlement = await invalidateAndSyncProject(
      env,
      sub.project_id,
      sub.owner_epic_id,
      "free",
    );
    return { entitlement, scheduledForPeriodEnd: true, pendingPlanVersionId: targetVersionId };
  }

  // Immediate upgrade (or un-canceling same plan) — consumed usage in DO period state is preserved!
  const priceId = resolveAllowlistedStripePriceId(env, params.targetPlanId);
  let itemId = sub.stripe_subscription_item_id;
  if (!itemId) {
    const live = await retrieveStripeSubscription(env, sub.stripe_subscription_id);
    itemId = live.items?.data[0]?.id ?? null;
  }
  if (!itemId) {
    throw new BillingError(
      "STRIPE_ITEM_MISSING",
      "Subscription item could not be resolved for upgrade. Please manage your subscription via the Billing Portal.",
      502,
    );
  }

  const updated = await updateStripeSubscriptionPlan(
    env,
    {
      subscriptionId: sub.stripe_subscription_id,
      itemId,
      priceId,
      prorationBehavior: "always_invoice",
      metadata: {
        ownerEpicId: params.ownerEpicId,
        projectId: params.projectId,
        localSubscriptionId: sub.id,
        planVersionId: targetVersionId,
        environment: sub.environment,
      },
    },
    params.idempotencyKey || `upgrade:${sub.id}:${targetVersionId}:${sub.current_period_end}`,
  );

  // Preserve current period bounds (or Stripe returned bounds) without resetting DO usage.
  const periodStartMs = updated.current_period_start
    ? updated.current_period_start * 1000
    : sub.current_period_start;
  const periodEndMs = updated.current_period_end
    ? updated.current_period_end * 1000
    : sub.current_period_end;

  await env.DB.prepare(
    `UPDATE billing_subscriptions
        SET stripe_price_id = ?, stripe_subscription_item_id = ?,
            plan_version_id = ?, pending_plan_version_id = NULL,
            status = ?, cancel_at_period_end = 0, canceled_at = NULL,
            current_period_start = ?, current_period_end = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?`,
  )
    .bind(
      priceId,
      updated.items?.data[0]?.id ?? itemId,
      targetVersionId,
      updated.status || "active",
      periodStartMs,
      periodEndMs,
      sub.id,
    )
    .run();

  const entitlement = await upsertSubscriptionEntitlementGrant(env, {
    projectId: sub.project_id,
    ownerEpicId: sub.owner_epic_id,
    subscriptionId: sub.id,
    planVersionId: targetVersionId,
    status: updated.status || "active",
    periodStartMs,
    periodEndMs,
    graceUntilMs: sub.grace_until,
    reason: `Upgraded to ${targetVersionId} (within-period usage preserved)`,
  });

  await recordBillingAction(env.DB, {
    ownerEpicId: params.ownerEpicId,
    projectId: params.projectId,
    subscriptionId: sub.id,
    actorId: params.ownerEpicId,
    action: "subscription_upgraded",
    status: "ok",
    details: { from: sub.plan_version_id, to: targetVersionId },
  });

  await queueBillingNotification(
    env,
    params.ownerEpicId,
    `egdata plan updated to ${targetSpec.displayName}`,
    `Your project subscription is now ${targetSpec.displayName} (${targetSpec.rpmLimit} RPM, ${targetSpec.periodAllowance.toLocaleString()} requests/period). Requests already used during the current period continue counting against the new limit.`,
  );

  return { entitlement, scheduledForPeriodEnd: false };
}

async function applyStripeSubscriptionSnapshot(
  env: DashboardEnv,
  stripeSub: StripeSubscription,
  environment: StripeEnvironment,
  eventCreated: number,
  options?: {
    overrideGraceUntilMs?: number | null;
    lastInvoiceId?: string | null;
    reason?: string;
  },
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT * FROM billing_subscriptions
      WHERE (environment = ? AND stripe_subscription_id = ?)
         OR id = ?
      LIMIT 1`,
  )
    .bind(
      environment,
      stripeSub.id,
      stripeSub.metadata?.localSubscriptionId ?? "",
    )
    .first<SubscriptionRow>();

  const ownerEpicId =
    existing?.owner_epic_id ?? stripeSub.metadata?.ownerEpicId ?? null;
  const projectId =
    existing?.project_id ?? stripeSub.metadata?.projectId ?? null;
  if (!ownerEpicId || !projectId) {
    throw new Error(`Subscription ${stripeSub.id} missing project/owner attribution`);
  }

  const item = stripeSub.items?.data?.[0];
  const priceId = item?.price?.id ?? existing?.stripe_price_id ?? null;
  const mappedPlanVersion =
    resolvePlanVersionFromStripePrice(env, priceId) ??
    ((stripeSub.metadata?.planVersionId as PlanVersionId | undefined) ??
      (existing?.plan_version_id as PlanVersionId | undefined));
  if (!mappedPlanVersion) {
    throw new Error(`Unrecognized Stripe price '${priceId}' on subscription ${stripeSub.id}`);
  }

  // Guard out-of-order events if Stripe event timestamp is older than already applied state
  if (existing && eventCreated > 0 && eventCreated < existing.last_event_created) {
    if (env.STRIPE_SECRET_KEY?.trim()) {
      const authoritative = await retrieveStripeSubscription(env, stripeSub.id);
      if (authoritative.id === stripeSub.id && authoritative !== stripeSub) {
        await applyStripeSubscriptionSnapshot(
          env,
          authoritative,
          environment,
          Math.max(eventCreated, existing.last_event_created),
          { reason: "Out-of-order reconciliation from live Stripe subscription" },
        );
      }
    }
    return;
  }

  const periodStartMs = stripeSub.current_period_start * 1000;
  const periodEndMs = stripeSub.current_period_end * 1000;
  const localId =
    existing?.id ?? `bsub_${crypto.randomUUID().replace(/-/g, "")}`;

  let graceUntilMs = existing?.grace_until ?? null;
  if (options?.overrideGraceUntilMs !== undefined) {
    graceUntilMs = options.overrideGraceUntilMs;
  } else if (stripeSub.status === "past_due") {
    if (graceUntilMs === null) {
      graceUntilMs =
        Date.now() + BILLING_POLICY_DEFAULTS.gracePeriodDays * DAY_MS;
    }
  } else if (stripeSub.status === "active" || stripeSub.status === "trialing") {
    graceUntilMs = null;
  }

  const effectivePlanVersion =
    existing?.pending_plan_version_id &&
    existing.current_period_end > 0 &&
    periodStartMs >= existing.current_period_end
      ? (existing.pending_plan_version_id as PlanVersionId)
      : mappedPlanVersion;

  if (existing) {
    await env.DB.prepare(
      `UPDATE billing_subscriptions
          SET stripe_subscription_id = ?, stripe_subscription_item_id = ?,
              stripe_price_id = ?, plan_version_id = ?,
              pending_plan_version_id = CASE WHEN ? != plan_version_id THEN NULL ELSE pending_plan_version_id END,
              status = ?, current_period_start = ?, current_period_end = ?,
              cancel_at_period_end = ?, canceled_at = ?, grace_until = ?,
              last_event_created = MAX(last_event_created, ?),
              last_invoice_id = COALESCE(?, last_invoice_id),
              needs_reconcile = 0, reconcile_error = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(
        stripeSub.id,
        item?.id ?? existing.stripe_subscription_item_id,
        priceId,
        effectivePlanVersion,
        effectivePlanVersion,
        stripeSub.status,
        periodStartMs,
        periodEndMs,
        stripeSub.cancel_at_period_end ? 1 : 0,
        stripeSub.canceled_at ? stripeSub.canceled_at * 1000 : existing.canceled_at,
        graceUntilMs,
        eventCreated,
        options?.lastInvoiceId ?? null,
        localId,
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO billing_subscriptions (
         id, owner_epic_id, project_id, stripe_customer_id, stripe_subscription_id,
         stripe_subscription_item_id, stripe_price_id, plan_version_id, status,
         environment, current_period_start, current_period_end, cancel_at_period_end,
         canceled_at, grace_until, last_event_created, last_invoice_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        localId,
        ownerEpicId,
        projectId,
        stripeSub.customer,
        stripeSub.id,
        item?.id ?? null,
        priceId,
        effectivePlanVersion,
        stripeSub.status,
        environment,
        periodStartMs,
        periodEndMs,
        stripeSub.cancel_at_period_end ? 1 : 0,
        stripeSub.canceled_at ? stripeSub.canceled_at * 1000 : null,
        graceUntilMs,
        eventCreated,
        options?.lastInvoiceId ?? null,
      )
      .run();
  }

  await upsertSubscriptionEntitlementGrant(env, {
    projectId,
    ownerEpicId,
    subscriptionId: localId,
    planVersionId: effectivePlanVersion,
    status: stripeSub.status,
    periodStartMs,
    periodEndMs,
    graceUntilMs,
    reason: options?.reason || `Stripe subscription state: ${stripeSub.status}`,
  });
}

type StripeWebhookEvent = {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data: {
    object: Record<string, unknown>;
  };
};

export async function handleStripeWebhook(
  env: DashboardEnv,
  rawBody: string,
  signatureHeader: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const validSig = await verifyStripeWebhookSignature(
    rawBody,
    signatureHeader,
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!validSig) {
    return {
      status: 400,
      body: { error: { code: "INVALID_STRIPE_SIGNATURE", message: "Webhook signature verification failed." } },
    };
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(rawBody) as StripeWebhookEvent;
  } catch {
    return {
      status: 400,
      body: { error: { code: "INVALID_JSON", message: "Invalid webhook payload." } },
    };
  }

  if (!event?.id || !event?.type || !event?.data?.object) {
    return {
      status: 400,
      body: { error: { code: "INVALID_EVENT", message: "Malformed Stripe event envelope." } },
    };
  }

  const environment = getStripeEnvironment(env);
  if (typeof event.livemode === "boolean") {
    const expectedLivemode = environment === "live";
    if (event.livemode !== expectedLivemode) {
      return {
        status: 400,
        body: {
          error: {
            code: "STRIPE_MODE_MISMATCH",
            message: `Received livemode=${String(event.livemode)} event on ${environment} gateway.`,
          },
        },
      };
    }
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO stripe_event_inbox (
       environment, event_id, event_type, stripe_created, status, payload_summary_json
     ) VALUES (?, ?, ?, ?, 'received', ?)`,
  )
    .bind(
      environment,
      event.id,
      event.type,
      Number(event.created) || 0,
      JSON.stringify({
        objectId: event.data.object.id ?? null,
        objectType: event.data.object.object ?? null,
      }),
    )
    .run();

  const inboxRow = await env.DB.prepare(
    `SELECT status, attempts FROM stripe_event_inbox WHERE environment = ? AND event_id = ? LIMIT 1`,
  )
    .bind(environment, event.id)
    .first<{ status: string; attempts: number }>();

  if (inboxRow?.status === "processed") {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  try {
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const subId =
          typeof obj.subscription === "string"
            ? obj.subscription
            : typeof (obj.subscription as { id?: string } | undefined)?.id === "string"
              ? (obj.subscription as { id: string }).id
              : null;
        if (subId) {
          const liveSub = await retrieveStripeSubscription(env, subId);
          const sessionMeta = (obj.metadata ?? {}) as Record<string, string>;
          const mergedSub: StripeSubscription = {
            ...liveSub,
            metadata: { ...sessionMeta, ...(liveSub.metadata ?? {}) },
          };
          await applyStripeSubscriptionSnapshot(
            env,
            mergedSub,
            environment,
            Number(event.created) || 0,
            { reason: "Checkout session completed" },
          );
          if (mergedSub.metadata?.ownerEpicId) {
            await queueBillingNotification(
              env,
              mergedSub.metadata.ownerEpicId,
              "egdata subscription activated",
              "Your paid plan subscription is now active. Check your project quota and billing details in the egdata Developer Portal.",
            );
          }
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const stripeSub = obj as unknown as StripeSubscription;
        await applyStripeSubscriptionSnapshot(
          env,
          stripeSub,
          environment,
          Number(event.created) || 0,
          { reason: `Stripe event ${event.type}` },
        );
        if (
          event.type === "customer.subscription.deleted" &&
          stripeSub.metadata?.ownerEpicId
        ) {
          await queueBillingNotification(
            env,
            stripeSub.metadata.ownerEpicId,
            "egdata subscription ended",
            "Your paid subscription has ended and your project has returned to Free plan capacity.",
          );
        }
        break;
      }

      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const subId =
          typeof obj.subscription === "string" ? obj.subscription : null;
        const invoiceId = typeof obj.id === "string" ? obj.id : null;
        if (subId) {
          const subRow = await env.DB.prepare(
            `SELECT * FROM billing_subscriptions WHERE environment = ? AND stripe_subscription_id = ? LIMIT 1`,
          )
            .bind(environment, subId)
            .first<SubscriptionRow>();
          if (env.STRIPE_SECRET_KEY?.trim()) {
            const liveSub = await retrieveStripeSubscription(env, subId);
            await applyStripeSubscriptionSnapshot(
              env,
              liveSub,
              environment,
              Number(event.created) || 0,
              {
                overrideGraceUntilMs: null,
                lastInvoiceId: invoiceId,
                reason: "Invoice paid",
              },
            );
          } else if (subRow) {
            const periodStartMs =
              typeof obj.period_start === "number"
                ? obj.period_start * 1000
                : subRow.current_period_start;
            const periodEndMs =
              typeof obj.period_end === "number"
                ? obj.period_end * 1000
                : subRow.current_period_end;
            await env.DB.prepare(
              `UPDATE billing_subscriptions
                  SET status = 'active', grace_until = NULL, last_invoice_id = COALESCE(?, last_invoice_id),
                      current_period_start = ?, current_period_end = ?,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?`,
            )
              .bind(invoiceId, periodStartMs, periodEndMs, subRow.id)
              .run();
            await upsertSubscriptionEntitlementGrant(env, {
              projectId: subRow.project_id,
              ownerEpicId: subRow.owner_epic_id,
              subscriptionId: subRow.id,
              planVersionId: subRow.plan_version_id as PlanVersionId,
              status: "active",
              periodStartMs,
              periodEndMs,
              graceUntilMs: null,
              reason: "Invoice paid",
            });
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const subId =
          typeof obj.subscription === "string" ? obj.subscription : null;
        const invoiceId = typeof obj.id === "string" ? obj.id : null;
        if (subId) {
          const subRow = await env.DB.prepare(
            `SELECT * FROM billing_subscriptions WHERE environment = ? AND stripe_subscription_id = ? LIMIT 1`,
          )
            .bind(environment, subId)
            .first<SubscriptionRow>();
          if (subRow) {
            const graceUntilMs =
              subRow.grace_until ??
              Date.now() + BILLING_POLICY_DEFAULTS.gracePeriodDays * DAY_MS;
            await env.DB.prepare(
              `UPDATE billing_subscriptions
                  SET status = 'past_due', grace_until = ?, last_invoice_id = COALESCE(?, last_invoice_id),
                      last_event_created = MAX(last_event_created, ?),
                      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?`,
            )
              .bind(graceUntilMs, invoiceId, Number(event.created) || 0, subRow.id)
              .run();
            await upsertSubscriptionEntitlementGrant(env, {
              projectId: subRow.project_id,
              ownerEpicId: subRow.owner_epic_id,
              subscriptionId: subRow.id,
              planVersionId: subRow.plan_version_id as PlanVersionId,
              status: "past_due",
              periodStartMs: subRow.current_period_start,
              periodEndMs: subRow.current_period_end,
              graceUntilMs,
              reason: `Payment failed; grace active until ${new Date(graceUntilMs).toISOString()}`,
            });
            await queueBillingNotification(
              env,
              subRow.owner_epic_id,
              "Action required: payment failed for your egdata subscription",
              `Your latest subscription payment failed. Paid capacity remains available during the ${BILLING_POLICY_DEFAULTS.gracePeriodDays}-day grace period until ${new Date(graceUntilMs).toUTCString()}. Please update your payment method in the Billing Portal.`,
            );
          }
        }
        break;
      }

      case "charge.refunded": {
        const invoiceId =
          typeof obj.invoice === "string" ? obj.invoice : null;
        const refunded = Number(obj.amount_refunded ?? 0);
        const total = Number(obj.amount ?? 0);
        const fullRefund = total > 0 && refunded >= total;
        if (invoiceId) {
          const subRow = await env.DB.prepare(
            `SELECT * FROM billing_subscriptions WHERE environment = ? AND last_invoice_id = ? LIMIT 1`,
          )
            .bind(environment, invoiceId)
            .first<SubscriptionRow>();
          if (subRow) {
            await env.DB.prepare(
              `UPDATE billing_subscriptions
                  SET refund_status = ?, refunded_eur_cents = ?,
                      status = CASE WHEN ? = 1 THEN 'canceled' ELSE status END,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?`,
            )
              .bind(
                fullRefund ? "full" : "partial",
                refunded,
                fullRefund ? 1 : 0,
                subRow.id,
              )
              .run();
            if (fullRefund) {
              await upsertSubscriptionEntitlementGrant(env, {
                projectId: subRow.project_id,
                ownerEpicId: subRow.owner_epic_id,
                subscriptionId: subRow.id,
                planVersionId: subRow.plan_version_id as PlanVersionId,
                status: "canceled",
                periodStartMs: subRow.current_period_start,
                periodEndMs: subRow.current_period_end,
                graceUntilMs: null,
                reason: "Full charge refunded",
              });
            }
          }
        }
        break;
      }

      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed": {
        const disputeStatus = String(obj.status || "needs_response");
        const mappedDispute =
          disputeStatus === "won"
            ? "won"
            : disputeStatus === "lost"
              ? "lost"
              : disputeStatus === "under_review"
                ? "under_review"
                : "needs_response";
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const localSubId = metadata.localSubscriptionId ?? null;
        if (localSubId) {
          const subRow = await env.DB.prepare(
            `SELECT * FROM billing_subscriptions WHERE id = ? LIMIT 1`,
          )
            .bind(localSubId)
            .first<SubscriptionRow>();
          if (subRow) {
            await env.DB.prepare(
              `UPDATE billing_subscriptions
                  SET dispute_status = ?,
                      status = CASE WHEN ? = 'lost' THEN 'canceled' ELSE status END,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?`,
            )
              .bind(mappedDispute, mappedDispute, subRow.id)
              .run();
            await recordBillingAction(env.DB, {
              ownerEpicId: subRow.owner_epic_id,
              projectId: subRow.project_id,
              subscriptionId: subRow.id,
              actorId: "stripe_webhook",
              action: event.type,
              status: mappedDispute,
              details: { disputeId: obj.id ?? null },
            });
            if (mappedDispute === "lost") {
              await upsertSubscriptionEntitlementGrant(env, {
                projectId: subRow.project_id,
                ownerEpicId: subRow.owner_epic_id,
                subscriptionId: subRow.id,
                planVersionId: subRow.plan_version_id as PlanVersionId,
                status: "canceled",
                periodStartMs: subRow.current_period_start,
                periodEndMs: subRow.current_period_end,
                graceUntilMs: null,
                reason: "Dispute lost",
              });
            }
          }
        }
        break;
      }

      default:
        await env.DB.prepare(
          `UPDATE stripe_event_inbox
              SET status = 'ignored', attempts = attempts + 1, processed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE environment = ? AND event_id = ?`,
        )
          .bind(environment, event.id)
          .run();
        return { status: 200, body: { received: true, ignored: true } };
    }

    await env.DB.prepare(
      `UPDATE stripe_event_inbox
          SET status = 'processed', attempts = attempts + 1,
              last_error = NULL, processed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE environment = ? AND event_id = ?`,
    )
      .bind(environment, event.id)
      .run();

    return { status: 200, body: { received: true } };
  } catch (err) {
    const attempts = (inboxRow?.attempts ?? 0) + 1;
    const nextAttempt =
      Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts, 6));
    await env.DB.prepare(
      `UPDATE stripe_event_inbox
          SET status = 'failed', attempts = attempts + 1,
              next_attempt_at = ?, last_error = ?
        WHERE environment = ? AND event_id = ?`,
    )
      .bind(
        nextAttempt,
        err instanceof Error ? err.message.slice(0, 500) : "webhook_processing_error",
        environment,
        event.id,
      )
      .run();
    return {
      status: 500,
      body: { error: { code: "WEBHOOK_PROCESSING_FAILED", message: "Webhook processing failed and will be retried." } },
    };
  }
}

export async function requestSubscriptionWithdrawal(
  env: DashboardEnv,
  params: {
    ownerEpicId: string;
    projectId: string;
    reason?: string;
    idempotencyKey?: string;
  },
) {
  const idem =
    params.idempotencyKey?.trim() ||
    `withdraw:${params.ownerEpicId}:${params.projectId}:${Math.floor(Date.now() / 60_000)}`;

  const existingReq = await env.DB.prepare(
    `SELECT * FROM withdrawal_requests WHERE idempotency_key = ? LIMIT 1`,
  )
    .bind(idem)
    .first<{
      id: string;
      status: string;
      refunded_amount_cents: number;
      stripe_refund_id: string | null;
      request_kind: string;
    }>();

  if (existingReq) {
    return {
      withdrawalId: existingReq.id,
      status: existingReq.status,
      refundedAmountCents: existingReq.refunded_amount_cents,
      stripeRefundId: existingReq.stripe_refund_id,
      requestKind: existingReq.request_kind,
      idempotentReplay: true,
    };
  }

  const sub = await env.DB.prepare(
    `SELECT * FROM billing_subscriptions
      WHERE project_id = ? AND owner_epic_id = ?
        AND status IN ('active', 'trialing', 'past_due', 'canceled')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(params.projectId, params.ownerEpicId)
    .first<SubscriptionRow>();

  if (!sub || !sub.stripe_subscription_id) {
    throw new BillingError(
      "NO_REFUNDABLE_SUBSCRIPTION",
      "No eligible paid subscription was found for this project.",
      404,
    );
  }

  const receipt = await env.DB.prepare(
    `SELECT withdrawal_expires_at, price_eur_cents FROM purchase_receipts
      WHERE subscription_id = ? ORDER BY accepted_at DESC LIMIT 1`,
  )
    .bind(sub.id)
    .first<{ withdrawal_expires_at: number; price_eur_cents: number }>();

  const nowMs = Date.now();
  const withinStatutoryWindow = receipt
    ? nowMs <= receipt.withdrawal_expires_at
    : true;
  const requestKind = withinStatutoryWindow
    ? "statutory_withdrawal"
    : "goodwill_refund";
  const withdrawalId = `wdr_${crypto.randomUUID().replace(/-/g, "")}`;

  await env.DB.prepare(
    `INSERT INTO withdrawal_requests (
       id, owner_epic_id, project_id, subscription_id, request_kind,
       status, requested_amount_cents, reason, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, 'refund_pending', ?, ?, ?)`,
  )
    .bind(
      withdrawalId,
      params.ownerEpicId,
      params.projectId,
      sub.id,
      requestKind,
      receipt?.price_eur_cents ?? null,
      params.reason?.trim() || "",
      idem,
    )
    .run();

  try {
    let paymentIntentId: string | null = null;
    let chargeId: string | null = null;
    if (sub.last_invoice_id) {
      const inv = await retrieveStripeInvoice(env, sub.last_invoice_id);
      paymentIntentId =
        typeof inv.payment_intent === "string"
          ? inv.payment_intent
          : inv.payment_intent?.id ?? null;
      chargeId = inv.charge ?? null;
    } else {
      const live = await retrieveStripeSubscription(
        env,
        sub.stripe_subscription_id,
      );
      const latest = live.latest_invoice;
      if (latest && typeof latest === "object") {
        paymentIntentId =
          typeof latest.payment_intent === "string"
            ? latest.payment_intent
            : latest.payment_intent?.id ?? null;
        chargeId = latest.charge ?? null;
      } else if (typeof latest === "string") {
        const inv = await retrieveStripeInvoice(env, latest);
        paymentIntentId =
          typeof inv.payment_intent === "string"
            ? inv.payment_intent
            : inv.payment_intent?.id ?? null;
        chargeId = inv.charge ?? null;
      }
    }

    if (!paymentIntentId && !chargeId) {
      throw new BillingError(
        "NO_REFUNDABLE_CHARGE",
        "No settled Stripe payment was found to refund yet.",
        409,
      );
    }

    const refund = await createStripeRefund(
      env,
      {
        paymentIntentId,
        chargeId,
        reason: "requested_by_customer",
        metadata: {
          withdrawalId,
          projectId: params.projectId,
          ownerEpicId: params.ownerEpicId,
        },
      },
      `refund:${withdrawalId}`,
    );

    await cancelStripeSubscription(
      env,
      sub.stripe_subscription_id,
      { atPeriodEnd: false },
      `cancel_withdraw:${withdrawalId}`,
    );

    const isFull =
      !receipt?.price_eur_cents || refund.amount >= receipt.price_eur_cents;
    const reqStatus = isFull ? "refunded_full" : "refunded_partial";

    await env.DB.prepare(
      `UPDATE withdrawal_requests
          SET status = ?, refunded_amount_cents = ?, stripe_refund_id = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(reqStatus, refund.amount, refund.id, withdrawalId)
      .run();

    await env.DB.prepare(
      `UPDATE billing_subscriptions
          SET status = 'canceled', canceled_at = ?, cancel_at_period_end = 0,
              refund_status = ?, refunded_eur_cents = refunded_eur_cents + ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(nowMs, isFull ? "full" : "partial", refund.amount, sub.id)
      .run();

    await upsertSubscriptionEntitlementGrant(env, {
      projectId: sub.project_id,
      ownerEpicId: sub.owner_epic_id,
      subscriptionId: sub.id,
      planVersionId: sub.plan_version_id as PlanVersionId,
      status: "canceled",
      periodStartMs: sub.current_period_start,
      periodEndMs: sub.current_period_end,
      graceUntilMs: null,
      reason: `Refund processed (${requestKind})`,
    });

    await recordBillingAction(env.DB, {
      ownerEpicId: params.ownerEpicId,
      projectId: params.projectId,
      subscriptionId: sub.id,
      actorId: params.ownerEpicId,
      action: requestKind,
      status: reqStatus,
      details: { withdrawalId, stripeRefundId: refund.id, amountCents: refund.amount },
    });

    await queueBillingNotification(
      env,
      params.ownerEpicId,
      "egdata refund and cancellation confirmation",
      `Your ${requestKind === "statutory_withdrawal" ? "14-day withdrawal" : "refund"} request (${withdrawalId}) has been processed for EUR ${(refund.amount / 100).toFixed(2)}. Your subscription has been canceled and paid capacity has returned to Free.`,
    );

    return {
      withdrawalId,
      status: reqStatus,
      refundedAmountCents: refund.amount,
      stripeRefundId: refund.id,
      requestKind,
      idempotentReplay: false,
    };
  } catch (err) {
    await env.DB.prepare(
      `UPDATE withdrawal_requests
          SET status = 'failed', resolution_note = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(err instanceof Error ? err.message.slice(0, 500) : "refund_failed", withdrawalId)
      .run();
    if (err instanceof BillingError) throw err;
    throw new BillingError(
      "REFUND_FAILED",
      "Refund could not be completed with Stripe right now. Your request has been recorded for operator follow-up.",
      502,
      { withdrawalId },
    );
  }
}

export async function cancelSubscriptionsForProjectDeletion(
  env: DashboardEnv,
  projectId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const subs = await env.DB.prepare(
    `SELECT * FROM billing_subscriptions
      WHERE project_id = ?
        AND status IN ('checkout_pending', 'incomplete', 'trialing', 'active', 'past_due')`,
  )
    .bind(projectId)
    .all<SubscriptionRow>();

  for (const sub of subs.results) {
    let cancelFailed = false;
    if (sub.stripe_subscription_id && env.STRIPE_SECRET_KEY?.trim()) {
      try {
        await cancelStripeSubscription(
          env,
          sub.stripe_subscription_id,
          { atPeriodEnd: false },
          `delproj:${sub.id}`,
        );
      } catch (err) {
        cancelFailed = true;
        await env.DB.prepare(
          `UPDATE billing_subscriptions
              SET needs_reconcile = 1, reconcile_error = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?`,
        )
          .bind(
            err instanceof Error ? err.message.slice(0, 500) : "delete_cancel_failed",
            sub.id,
          )
          .run();
      }
    }

    await env.DB.prepare(
      `UPDATE billing_subscriptions
          SET status = 'canceled', canceled_at = ?, cancel_at_period_end = 0,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(Date.now(), sub.id)
      .run();

    await env.DB.prepare(
      `UPDATE entitlement_grants
          SET revoked_at = ?, revoked_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE project_id = ? AND source = 'subscription' AND revoked_at IS NULL`,
    )
      .bind(Date.now(), actorId, projectId)
      .run();

    await recordBillingAction(env.DB, {
      ownerEpicId: sub.owner_epic_id,
      projectId,
      subscriptionId: sub.id,
      actorId,
      action: "project_deleted_subscription_canceled",
      status: cancelFailed ? "reconcile_queued" : "ok",
      details: { reason },
    });
  }
}

export async function cancelSubscriptionsForAccountClose(
  env: DashboardEnv,
  ownerEpicId: string,
): Promise<void> {
  const projects = await env.DB.prepare(
    `SELECT id FROM projects WHERE owner_epic_id = ?`,
  )
    .bind(ownerEpicId)
    .all<{ id: string }>();
  for (const project of projects.results) {
    await cancelSubscriptionsForProjectDeletion(
      env,
      project.id,
      ownerEpicId,
      "developer_account_closed",
    );
  }
}

export async function getProjectBillingSummary(
  env: DashboardEnv,
  projectId: string,
  ownerEpicId: string,
) {
  const project = await env.DB.prepare(
    `SELECT id, owner_epic_id, name, tier, custom_rpm, deleted_at
       FROM projects WHERE id = ? LIMIT 1`,
  )
    .bind(projectId)
    .first<{
      id: string;
      owner_epic_id: string;
      name: string;
      tier: "free" | "pro" | "scale" | "enterprise";
      custom_rpm: number | null;
      deleted_at: string | null;
    }>();

  if (!project || project.owner_epic_id !== ownerEpicId) {
    throw new BillingError("NOT_FOUND", "Project not found.", 404);
  }

  const entitlement = await resolveEffectiveProjectEntitlement(env, {
    projectId: project.id,
    ownerEpicId: project.owner_epic_id,
    tier: project.tier,
    customRpm: project.custom_rpm,
  });

  const sub = await env.DB.prepare(
    `SELECT * FROM billing_subscriptions
      WHERE project_id = ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(project.id)
    .first<SubscriptionRow>();

  const grants = await env.DB.prepare(
    `SELECT id, source, plan_id, plan_version_id, tier, rpm_limit, period_allowance,
            effective_from, effective_until, revision, reason, revoked_at, created_at
       FROM entitlement_grants
      WHERE project_id = ?
      ORDER BY revision DESC, created_at DESC LIMIT 10`,
  )
    .bind(project.id)
    .all<Record<string, unknown>>();

  const receipts = await env.DB.prepare(
    `SELECT id, plan_version_id, price_eur_cents, currency, vat_included,
            terms_version, withdrawal_acknowledged, withdrawal_expires_at,
            action_type, accepted_at, created_at
       FROM purchase_receipts
      WHERE project_id = ?
      ORDER BY accepted_at DESC LIMIT 10`,
  )
    .bind(project.id)
    .all<Record<string, unknown>>();

  const withdrawals = await env.DB.prepare(
    `SELECT id, request_kind, status, requested_amount_cents, refunded_amount_cents,
            stripe_refund_id, reason, resolution_note, created_at
       FROM withdrawal_requests
      WHERE project_id = ?
      ORDER BY created_at DESC LIMIT 10`,
  )
    .bind(project.id)
    .all<Record<string, unknown>>();

  let usage: unknown = null;
  if (
    entitlement.periodType === "billing_period" &&
    entitlement.periodAllowance &&
    entitlement.periodStart !== null &&
    entitlement.periodEnd !== null
  ) {
    usage = await readProjectBillingQuota(
      env,
      ownerEpicId,
      project.id,
      entitlement.periodAllowance,
      entitlement.periodStart,
      entitlement.periodEnd,
    );
  } else if (entitlement.tier === "free") {
    usage = await readAccountMonthlyQuota(env, ownerEpicId);
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      tier: project.tier,
      deletedAt: project.deleted_at,
    },
    entitlement,
    subscription: sub
      ? {
          id: sub.id,
          planVersionId: sub.plan_version_id,
          pendingPlanVersionId: sub.pending_plan_version_id,
          status: sub.status,
          currentPeriodStart: new Date(sub.current_period_start).toISOString(),
          currentPeriodEnd: new Date(sub.current_period_end).toISOString(),
          cancelAtPeriodEnd: sub.cancel_at_period_end === 1,
          graceUntil: sub.grace_until
            ? new Date(sub.grace_until).toISOString()
            : null,
          disputeStatus: sub.dispute_status,
          refundStatus: sub.refund_status,
          refundedEurCents: sub.refunded_eur_cents,
        }
      : null,
    usage,
    grants: grants.results,
    receipts: receipts.results,
    withdrawals: withdrawals.results,
  };
}

export async function reconcileBillingState(env: DashboardEnv): Promise<{
  expiredGraceCount: number;
  reconciledCount: number;
}> {
  const now = Date.now();
  let expiredGraceCount = 0;
  let reconciledCount = 0;

  // 1. Suspend past_due subscriptions whose configurable grace window has expired
  const expiredGrace = await env.DB.prepare(
    `SELECT * FROM billing_subscriptions
      WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until <= ?
      LIMIT 25`,
  )
    .bind(now)
    .all<SubscriptionRow>();

  for (const sub of expiredGrace.results) {
    await env.DB.prepare(
      `UPDATE billing_subscriptions
          SET status = 'unpaid', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
      .bind(sub.id)
      .run();

    await upsertSubscriptionEntitlementGrant(env, {
      projectId: sub.project_id,
      ownerEpicId: sub.owner_epic_id,
      subscriptionId: sub.id,
      planVersionId: sub.plan_version_id as PlanVersionId,
      status: "unpaid",
      periodStartMs: sub.current_period_start,
      periodEndMs: sub.current_period_end,
      graceUntilMs: sub.grace_until,
      reason: "Grace period expired",
    }).catch(() => {});

    await queueBillingNotification(
      env,
      sub.owner_epic_id,
      "egdata paid plan suspended after grace period",
      "Your grace period ended with an unpaid invoice. Your project has returned to Free capacity. You can update payment details anytime in the Billing Portal.",
    );
    expiredGraceCount++;
  }

  // 2. Reconcile failed DO syncs or deletion-triggered Stripe cancellations
  const pendingReconcile = await env.DB.prepare(
    `SELECT * FROM billing_subscriptions WHERE needs_reconcile = 1 LIMIT 25`,
  ).all<SubscriptionRow>();

  for (const sub of pendingReconcile.results) {
    try {
      if (
        sub.status === "canceled" &&
        sub.stripe_subscription_id &&
        env.STRIPE_SECRET_KEY?.trim()
      ) {
        await cancelStripeSubscription(
          env,
          sub.stripe_subscription_id,
          { atPeriodEnd: false },
          `reconcile_cancel:${sub.id}`,
        ).catch(() => {});
      }
      await invalidateAndSyncProject(env, sub.project_id, sub.owner_epic_id, "free");
      await env.DB.prepare(
        `UPDATE billing_subscriptions
            SET needs_reconcile = 0, reconcile_error = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?`,
      )
        .bind(sub.id)
        .run();
      reconciledCount++;
    } catch {
      // leave needs_reconcile = 1 for next cron tick
    }
  }

  return { expiredGraceCount, reconciledCount };
}
