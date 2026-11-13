import {
  BILLING_POLICY_DEFAULTS,
  type EffectiveProjectEntitlement,
  type ExpensivePeriodBudgetKey,
  fallbackProjectEntitlement,
  type GrantSource,
  getPlanVersion,
  isCommercialLimitsEnabled,
  legacyExpensiveLimitsForProject,
  PLAN_VERSIONS,
} from "./plans.js";
import {
  type AdmissionResult,
  DAILY_POLICY_NAME,
  type DailyQuotaSummary,
  FREE_MONTHLY_ALLOWANCE,
  MONTHLY_POLICY_NAME,
  type MonthlyQuotaSummary,
  PERIOD_POLICY_NAME,
  type PeriodQuotaSummary,
  type QuotaPolicy,
  utcMonthBounds,
} from "./rate-limiter-core.js";
import type {
  AccountMonthlyQuotaStatus,
  ApiKeyTier,
  CachedKeyMetadata,
  DashboardEnv,
} from "./types.js";

const QUOTA_TIMEOUT_MS = 3_000;

export {
  DAILY_POLICY_NAME,
  FREE_MONTHLY_ALLOWANCE,
  MONTHLY_POLICY_NAME,
  PERIOD_POLICY_NAME,
};

export const tierQuotas: Record<string, number> = {
  free: 120,
  pro: 1_200,
  scale: 600,
  enterprise: 6_000,
};

export function quotaForProject(
  project: {
    tier: string;
    customRpm: number | null;
  },
  entitlement?: EffectiveProjectEntitlement | null,
  commercialLimitsEnabled = false,
): number {
  if (entitlement) {
    return entitlement.rpmLimit;
  }
  const limit = project.customRpm;
  if (
    typeof limit === "number" &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= 1_000_000
  ) {
    return limit;
  }
  if (project.tier === "scale") {
    return PLAN_VERSIONS["scale-v1"].rpmLimit;
  }
  if (commercialLimitsEnabled) {
    if (project.tier === "pro") return PLAN_VERSIONS["pro-v1"].rpmLimit;
    if (project.tier === "free") return PLAN_VERSIONS["free-v1"].rpmLimit;
  }
  return tierQuotas[project.tier] ?? tierQuotas.free;
}

export function isFreeTierProject(project: { tier: string }): boolean {
  return project.tier === "free";
}

export function accountLimiterObjectName(
  env: Pick<DashboardEnv, "RATE_LIMIT_ENVIRONMENT">,
  ownerEpicId: string,
): string {
  const environment = env.RATE_LIMIT_ENVIRONMENT || "production";
  return `account:${environment}:${ownerEpicId}`;
}

type ProjectRowForEntitlement = {
  tier: string;
  custom_rpm: number | null;
  deleted_at?: string | null;
};

type EntitlementGrantRow = {
  id: string;
  source: string;
  plan_id: string;
  plan_version_id: string;
  tier: string;
  rpm_limit: number;
  period_allowance: number | null;
  expensive_limits_json: string;
  effective_from: number;
  effective_until: number | null;
  revision: number;
  subscription_id: string | null;
  reason: string | null;
};

type BillingSubscriptionRow = {
  id: string;
  plan_version_id: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: number;
  grace_until: number | null;
};

export async function resolveEffectiveProjectEntitlement(
  env: DashboardEnv,
  meta: Pick<
    CachedKeyMetadata,
    "projectId" | "ownerEpicId" | "tier" | "customRpm" | "grantSource"
  >,
  nowMs = Date.now(),
): Promise<EffectiveProjectEntitlement> {
  const commercial = isCommercialLimitsEnabled(env);
  if (!env.DB || !meta.projectId) {
    return fallbackProjectEntitlement({
      projectId: meta.projectId,
      ownerEpicId: meta.ownerEpicId,
      tier: meta.tier,
      customRpm: meta.customRpm,
      commercialLimitsEnabled: commercial,
      grantSource: meta.grantSource,
    });
  }

  let projectRow: ProjectRowForEntitlement | null = null;
  try {
    projectRow = await env.DB.prepare(
      `SELECT tier, custom_rpm, deleted_at FROM projects WHERE id = ? LIMIT 1`,
    )
      .bind(meta.projectId)
      .first<ProjectRowForEntitlement>();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such column")) {
      try {
        projectRow = await env.DB.prepare(
          `SELECT tier, custom_rpm FROM projects WHERE id = ? LIMIT 1`,
        )
          .bind(meta.projectId)
          .first<ProjectRowForEntitlement>();
      } catch (innerErr) {
        const innerMsg =
          innerErr instanceof Error ? innerErr.message : String(innerErr);
        if (!innerMsg.includes("no such table")) {
          throw innerErr;
        }
        projectRow = null;
      }
    } else if (!msg.includes("no such table")) {
      throw err;
    }
  }

  const effectiveTier = ((projectRow?.tier as ApiKeyTier | undefined) ??
    meta.tier) as ApiKeyTier;
  const effectiveCustomRpm =
    projectRow !== null ? projectRow.custom_rpm : meta.customRpm;

  if (projectRow?.deleted_at) {
    const fallback = fallbackProjectEntitlement({
      projectId: meta.projectId,
      ownerEpicId: meta.ownerEpicId,
      tier: "free",
      customRpm: null,
      commercialLimitsEnabled: true,
      grantSource: "free",
    });
    return {
      ...fallback,
      status: "revoked",
      reason: "project_deleted",
    };
  }

  let grant: EntitlementGrantRow | null = null;
  let subscription: BillingSubscriptionRow | null = null;
  try {
    grant = await env.DB.prepare(
      `SELECT id, source, plan_id, plan_version_id, tier, rpm_limit, period_allowance,
              expensive_limits_json, effective_from, effective_until, revision,
              subscription_id, reason
         FROM entitlement_grants
        WHERE project_id = ?
          AND revoked_at IS NULL
          AND effective_from <= ?
          AND (effective_until IS NULL OR effective_until > ?)
        ORDER BY revision DESC, created_at DESC
        LIMIT 1`,
    )
      .bind(meta.projectId, nowMs, nowMs)
      .first<EntitlementGrantRow>();

    if (grant?.subscription_id) {
      subscription = await env.DB.prepare(
        `SELECT id, plan_version_id, status, current_period_start, current_period_end,
                cancel_at_period_end, grace_until
           FROM billing_subscriptions
          WHERE id = ?
          LIMIT 1`,
      )
        .bind(grant.subscription_id)
        .first<BillingSubscriptionRow>();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      throw err;
    }
  }

  if (!grant) {
    return fallbackProjectEntitlement({
      projectId: meta.projectId,
      ownerEpicId: meta.ownerEpicId,
      tier: effectiveTier,
      customRpm: effectiveCustomRpm,
      commercialLimitsEnabled: commercial,
      grantSource: meta.grantSource,
    });
  }

  const spec = getPlanVersion(grant.plan_version_id) ?? getPlanVersion(grant.plan_id);
  const subStatus = subscription?.status ?? null;
  const graceUntil = subscription?.grace_until ?? null;

  if (grant.source === "subscription" && subscription) {
    const graceExpired =
      subStatus === "past_due" &&
      graceUntil !== null &&
      nowMs >= graceUntil;
    const periodExpired =
      (subStatus === "canceled" || subStatus === "incomplete_expired" || subStatus === "unpaid") &&
      nowMs >= subscription.current_period_end;

    if (graceExpired || periodExpired || subStatus === "incomplete_expired") {
      return {
        ...fallbackProjectEntitlement({
          projectId: meta.projectId,
          ownerEpicId: meta.ownerEpicId,
          tier: "free",
          customRpm: null,
          commercialLimitsEnabled: true,
          grantSource: "free",
          revision: grant.revision,
        }),
        status: "expired",
        subscriptionId: subscription.id,
        reason: graceExpired ? "grace_expired" : "subscription_expired",
      };
    }

    let expensiveMinuteLimits = spec
      ? { ...spec.expensiveMinuteLimits }
      : { ...PLAN_VERSIONS["pro-v1"].expensiveMinuteLimits };
    let expensivePeriodBudgets = spec
      ? { ...spec.expensivePeriodBudgets }
      : { ...PLAN_VERSIONS["pro-v1"].expensivePeriodBudgets };
    let entitlements = spec
      ? [...spec.entitlements]
      : [...PLAN_VERSIONS["pro-v1"].entitlements];

    let initialDailyLimit = spec?.initialDailyLimit ?? null;
    let initialDailyLimitUntil: number | null = null;
    try {
      const parsed = JSON.parse(grant.expensive_limits_json) as {
        minute?: Record<string, number>;
        period?: Record<string, number>;
        entitlements?: string[];
        initialDailyLimit?: number | null;
        initialDailyLimitUntil?: number | null;
      };
      if (parsed.minute) {
        expensiveMinuteLimits = {
          "offers-list": Number(parsed.minute["offers-list"]) || expensiveMinuteLimits["offers-list"],
          search: Number(parsed.minute.search) || expensiveMinuteLimits.search,
          heavy: Number(parsed.minute.heavy) || expensiveMinuteLimits.heavy,
          bulk: Number(parsed.minute.bulk) || expensiveMinuteLimits.bulk,
        };
      }
      if (parsed.period) {
        expensivePeriodBudgets = {
          "nl-search": Number(parsed.period["nl-search"]) || expensivePeriodBudgets["nl-search"],
          bulk: Number(parsed.period.bulk) || expensivePeriodBudgets.bulk,
          image: Number(parsed.period.image) || expensivePeriodBudgets.image,
        };
      }
      if (Array.isArray(parsed.entitlements)) {
        entitlements = parsed.entitlements;
      }
      if (typeof parsed.initialDailyLimit === "number" && parsed.initialDailyLimit > 0) {
        initialDailyLimit = parsed.initialDailyLimit;
      } else if (parsed.initialDailyLimit === null) {
        initialDailyLimit = null;
      }
      if (
        typeof parsed.initialDailyLimitUntil === "number" &&
        Number.isFinite(parsed.initialDailyLimitUntil)
      ) {
        initialDailyLimitUntil = parsed.initialDailyLimitUntil;
      }
    } catch {
      // use spec defaults
    }

    const dailyCapActive =
      initialDailyLimit !== null &&
      initialDailyLimit > 0 &&
      initialDailyLimitUntil !== null &&
      nowMs < initialDailyLimitUntil;

    const effectiveStatus: EffectiveProjectEntitlement["status"] =
      subStatus === "past_due"
        ? "grace"
        : subscription.cancel_at_period_end
          ? "canceled_active"
          : "active";

    return {
      projectId: meta.projectId,
      ownerEpicId: meta.ownerEpicId,
      planId: (grant.plan_id as EffectiveProjectEntitlement["planId"]) ?? "pro",
      planVersionId: (grant.plan_version_id as EffectiveProjectEntitlement["planVersionId"]) ?? "pro-v1",
      tier: (grant.tier as ApiKeyTier) ?? "pro",
      grantSource: "subscription",
      revision: grant.revision,
      rpmLimit: grant.rpm_limit,
      periodAllowance: grant.period_allowance,
      periodType: "billing_period",
      periodStart: subscription.current_period_start,
      periodEnd: subscription.current_period_end,
      initialDailyLimit: dailyCapActive ? initialDailyLimit : null,
      initialDailyLimitUntil: dailyCapActive ? initialDailyLimitUntil : null,
      expensiveMinuteLimits,
      expensivePeriodBudgets,
      entitlements,
      status: effectiveStatus,
      graceUntil,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
      subscriptionId: subscription.id,
      reason: grant.reason,
    };
  }

  // Manual or grandfathered explicit grant
  let parsedMinute = spec
    ? { ...spec.expensiveMinuteLimits }
    : legacyExpensiveLimitsForProject(grant.tier as ApiKeyTier, grant.rpm_limit);
  let parsedPeriod = spec ? { ...spec.expensivePeriodBudgets } : null;
  let parsedEntitlements = spec
    ? [...spec.entitlements]
    : [...PLAN_VERSIONS["scale-v1"].entitlements];
  if (grant.tier === "enterprise" && !parsedEntitlements.includes("tier:enterprise")) {
    parsedEntitlements.push("tier:enterprise");
  }

  let manualDailyLimit: number | null = null;
  let manualDailyUntil: number | null = null;

  try {
    const parsed = JSON.parse(grant.expensive_limits_json) as {
      minute?: Record<string, number>;
      period?: Record<string, number>;
      entitlements?: string[];
      initialDailyLimit?: number | null;
      initialDailyLimitUntil?: number | null;
    };
    if (parsed.minute) {
      parsedMinute = {
        "offers-list": Number(parsed.minute["offers-list"]) || parsedMinute["offers-list"],
        search: Number(parsed.minute.search) || parsedMinute.search,
        heavy: Number(parsed.minute.heavy) || parsedMinute.heavy,
        bulk: Number(parsed.minute.bulk) || parsedMinute.bulk,
      };
    }
    if (parsed.period) {
      parsedPeriod = {
        "nl-search": Number(parsed.period["nl-search"]) || 0,
        bulk: Number(parsed.period.bulk) || 0,
        image: Number(parsed.period.image) || 0,
      };
    }
    if (Array.isArray(parsed.entitlements)) {
      parsedEntitlements = parsed.entitlements;
    }
    if (
      typeof parsed.initialDailyLimit === "number" &&
      parsed.initialDailyLimit > 0
    ) {
      const until =
        typeof parsed.initialDailyLimitUntil === "number" &&
        Number.isFinite(parsed.initialDailyLimitUntil)
          ? parsed.initialDailyLimitUntil
          : null;
      if (until === null || until > nowMs) {
        manualDailyLimit = parsed.initialDailyLimit;
        manualDailyUntil = until;
      }
    }
  } catch {
    // ignore malformed json
  }

  return {
    projectId: meta.projectId,
    ownerEpicId: meta.ownerEpicId,
    planId: grant.plan_id as EffectiveProjectEntitlement["planId"],
    planVersionId: grant.plan_version_id as EffectiveProjectEntitlement["planVersionId"],
    tier: grant.tier as ApiKeyTier,
    grantSource: grant.source as GrantSource,
    revision: grant.revision,
    rpmLimit: grant.rpm_limit,
    periodAllowance:
      grant.tier === "free"
        ? (grant.period_allowance ?? FREE_MONTHLY_ALLOWANCE)
        : grant.period_allowance,
    periodType:
      grant.tier === "free"
        ? "calendar_month"
        : grant.period_allowance
          ? "billing_period"
          : "unlimited",
    periodStart: grant.effective_from,
    periodEnd: grant.effective_until,
    initialDailyLimit: manualDailyLimit,
    initialDailyLimitUntil: manualDailyUntil,
    expensiveMinuteLimits: parsedMinute,
    expensivePeriodBudgets: parsedPeriod,
    entitlements: parsedEntitlements,
    status: "active",
    graceUntil: null,
    cancelAtPeriodEnd: false,
    subscriptionId: grant.subscription_id,
    reason: grant.reason,
  };
}

export async function syncProjectEntitlementToLimiter(
  env: DashboardEnv,
  entitlement: EffectiveProjectEntitlement,
): Promise<void> {
  if (!env.API_KEY_RATE_LIMITER || !entitlement.ownerEpicId) return;
  const objectId = env.API_KEY_RATE_LIMITER.idFromName(
    accountLimiterObjectName(env, entitlement.ownerEpicId),
  );
  const stub = env.API_KEY_RATE_LIMITER.get(objectId);
  if (typeof stub.syncProjectEntitlement === "function") {
    await stub.syncProjectEntitlement(entitlement);
  }
}

export interface ProjectAdmissionOptions {
  entitlement?: EffectiveProjectEntitlement | null;
  periodBudget?: { key: ExpensivePeriodBudgetKey; policyName: string } | null;
}

/** Both gateways share one account-scoped object for free monthly, project billing-period, and minute policies. */
export async function admitProjectRequest(
  env: DashboardEnv,
  meta: CachedKeyMetadata,
  additionalPolicies: QuotaPolicy[] = [],
  operationId?: string,
  options?: ProjectAdmissionOptions,
): Promise<AdmissionResult> {
  if (!env.API_KEY_RATE_LIMITER || !meta.projectId || !meta.ownerEpicId) {
    throw new Error("quota_binding_or_identity_missing");
  }
  const now = Date.now();
  const commercial = isCommercialLimitsEnabled(env);
  const entitlement = options?.entitlement ?? null;
  const effectiveTier = entitlement?.tier ?? meta.tier;
  const rpmLimit = quotaForProject(meta, entitlement, commercial);

  const periodPolicies: QuotaPolicy[] = [];
  let activePeriodStart: number | null = null;
  let activePeriodEnd: number | null = null;

  if (
    entitlement &&
    entitlement.periodType === "billing_period" &&
    entitlement.periodAllowance &&
    entitlement.periodStart !== null &&
    entitlement.periodEnd !== null &&
    entitlement.periodEnd > entitlement.periodStart
  ) {
    activePeriodStart = entitlement.periodStart;
    activePeriodEnd = entitlement.periodEnd;
    periodPolicies.push({
      name: PERIOD_POLICY_NAME,
      limit: entitlement.periodAllowance,
      window: "period",
      periodStart: activePeriodStart,
      periodEnd: activePeriodEnd,
    });
  } else if (effectiveTier === "free") {
    const bounds = utcMonthBounds(now);
    activePeriodStart = bounds.monthStart;
    activePeriodEnd = bounds.resetAt;
    periodPolicies.push({
      name: MONTHLY_POLICY_NAME,
      limit: entitlement?.periodAllowance ?? FREE_MONTHLY_ALLOWANCE,
      window: "month",
    });
  }

  if (
    entitlement?.initialDailyLimit &&
    entitlement.initialDailyLimit > 0 &&
    typeof entitlement.initialDailyLimitUntil === "number" &&
    now < entitlement.initialDailyLimitUntil
  ) {
    periodPolicies.push({
      name: DAILY_POLICY_NAME,
      limit: entitlement.initialDailyLimit,
      window: "day",
    });
  }

  if (
    options?.periodBudget &&
    entitlement?.expensivePeriodBudgets &&
    activePeriodStart !== null &&
    activePeriodEnd !== null &&
    activePeriodEnd > activePeriodStart
  ) {
    const budgetLimit = entitlement.expensivePeriodBudgets[options.periodBudget.key];
    if (Number.isInteger(budgetLimit) && budgetLimit > 0) {
      periodPolicies.push({
        name: options.periodBudget.policyName,
        limit: budgetLimit,
        window: "period",
        periodStart: activePeriodStart,
        periodEnd: activePeriodEnd,
      });
    }
  }

  const policies: QuotaPolicy[] = [
    { name: "global", limit: rpmLimit, window: "minute" },
    ...periodPolicies,
    ...additionalPolicies,
  ];
  const objectId = env.API_KEY_RATE_LIMITER.idFromName(
    accountLimiterObjectName(env, meta.ownerEpicId),
  );
  const stub = env.API_KEY_RATE_LIMITER.get(objectId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      stub.admit({
        keyId: meta.keyId,
        projectId: meta.projectId,
        ownerEpicId: meta.ownerEpicId,
        policies,
        ...(operationId && env.USAGE_TRACKING_ENABLED === "true"
          ? { usage: { projectId: meta.projectId, operationId } }
          : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("quota_timeout")),
          QUOTA_TIMEOUT_MS,
        );
      }),
    ]);
    if (
      !result ||
      typeof result.allowed !== "boolean" ||
      !Array.isArray(result.policies) ||
      result.policies.length !== policies.length ||
      !Number.isInteger(result.retryAfter) ||
      result.retryAfter < 0 ||
      !result.policies.every((entry) => {
        const actualWindow = entry?.window ?? "minute";
        return (
          typeof entry?.name === "string" &&
          entry.name.length > 0 &&
          Number.isInteger(entry.limit) &&
          entry.limit >= 1 &&
          (actualWindow === "minute" ||
            actualWindow === "day" ||
            actualWindow === "month" ||
            actualWindow === "period") &&
          Number.isInteger(entry.remaining) &&
          entry.remaining >= 0 &&
          Number.isFinite(entry.resetAt) &&
          (entry.windowSeconds === undefined ||
            (Number.isInteger(entry.windowSeconds) && entry.windowSeconds > 0))
        );
      })
    ) {
      throw new Error("quota_invalid_decision");
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function creditAdmittedRequestUsage(
  env: DashboardEnv,
  params: {
    adjustmentId: string;
    ownerEpicId: string;
    projectId: string;
    entitlement?: EffectiveProjectEntitlement | null;
    reason: string;
  },
): Promise<void> {
  if (!env.API_KEY_RATE_LIMITER || !params.ownerEpicId || !params.projectId) {
    return;
  }
  const objectId = env.API_KEY_RATE_LIMITER.idFromName(
    accountLimiterObjectName(env, params.ownerEpicId),
  );
  const stub = env.API_KEY_RATE_LIMITER.get(objectId);
  if (typeof stub.creditUsage !== "function") return;

  const isPeriod =
    params.entitlement?.periodType === "billing_period" &&
    params.entitlement.periodStart !== null;
  const scope = isPeriod ? "period" : "month";
  const windowStart = isPeriod
    ? params.entitlement!.periodStart!
    : utcMonthBounds(Date.now()).monthStart;

  await stub.creditUsage({
    adjustmentId: params.adjustmentId,
    ownerEpicId: params.ownerEpicId,
    projectId: params.projectId,
    scope,
    windowStart,
    periodEnd: params.entitlement?.periodEnd ?? undefined,
    amount: 1,
    reason: params.reason,
  });
}

export async function readProjectDailyQuota(
  env: DashboardEnv,
  ownerEpicId: string,
  projectId: string,
  allowance: number,
): Promise<(DailyQuotaSummary & { resetAtIso: string }) | null> {
  if (!env.API_KEY_RATE_LIMITER || !ownerEpicId || !projectId) {
    return null;
  }
  const objectId = env.API_KEY_RATE_LIMITER.idFromName(
    accountLimiterObjectName(env, ownerEpicId),
  );
  const stub = env.API_KEY_RATE_LIMITER.get(objectId);
  if (typeof stub.readProjectDailyQuota !== "function") return null;

  const summary = await stub.readProjectDailyQuota(projectId, allowance);
  return {
    ...summary,
    resetAtIso: new Date(summary.resetAt).toISOString(),
  };
}

export async function readProjectBillingQuota(
  env: DashboardEnv,
  ownerEpicId: string,
  projectId: string,
  allowance: number,
  periodStart: number,
  periodEnd: number,
): Promise<
  (PeriodQuotaSummary & { policyCounts: Record<string, number>; status: "ok" | "warning" | "critical" | "exhausted" }) | null
> {
  if (!env.API_KEY_RATE_LIMITER || !ownerEpicId || !projectId) {
    return null;
  }
  const objectId = env.API_KEY_RATE_LIMITER.idFromName(
    accountLimiterObjectName(env, ownerEpicId),
  );
  const stub = env.API_KEY_RATE_LIMITER.get(objectId);
  if (typeof stub.readProjectQuota !== "function") return null;

  const summary = await stub.readProjectQuota(
    projectId,
    allowance,
    periodStart,
    periodEnd,
  );
  const criticalThreshold = Math.ceil(
    (summary.allowance * BILLING_POLICY_DEFAULTS.usageWarningThresholds[1]) / 100,
  );
  const warningThreshold = Math.ceil(
    (summary.allowance * BILLING_POLICY_DEFAULTS.usageWarningThresholds[0]) / 100,
  );
  const status =
    summary.used >= summary.allowance
      ? "exhausted"
      : summary.used >= criticalThreshold
        ? "critical"
        : summary.used >= warningThreshold
          ? "warning"
          : "ok";
  return { ...summary, status };
}

export async function readAccountMonthlyQuota(
  env: DashboardEnv,
  ownerEpicId: string,
): Promise<AccountMonthlyQuotaStatus> {
  if (!env.API_KEY_RATE_LIMITER || !ownerEpicId) {
    throw new Error("quota_binding_or_identity_missing");
  }
  const objectId = env.API_KEY_RATE_LIMITER.idFromName(
    accountLimiterObjectName(env, ownerEpicId),
  );
  const stub = env.API_KEY_RATE_LIMITER.get(objectId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const summary: MonthlyQuotaSummary = await Promise.race([
      stub.readMonthlyQuota(ownerEpicId, FREE_MONTHLY_ALLOWANCE),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("quota_timeout")),
          QUOTA_TIMEOUT_MS,
        );
      }),
    ]);
    if (
      !summary ||
      !Number.isInteger(summary.used) ||
      summary.used < 0 ||
      !Number.isInteger(summary.allowance) ||
      summary.allowance < 1 ||
      !Number.isInteger(summary.remaining) ||
      summary.remaining < 0 ||
      !Number.isFinite(summary.monthStart) ||
      !Number.isFinite(summary.resetAt)
    ) {
      throw new Error("quota_invalid_summary");
    }
    const status =
      summary.used >= summary.allowance
        ? "exhausted"
        : summary.used >= Math.ceil(summary.allowance * 0.95)
          ? "critical"
          : summary.used >= Math.ceil(summary.allowance * 0.8)
            ? "warning"
            : "ok";
    return {
      used: summary.used,
      remaining: summary.remaining,
      allowance: summary.allowance,
      monthStart: new Date(summary.monthStart).toISOString(),
      resetAt: new Date(summary.resetAt).toISOString(),
      status,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function rateLimitHeaders(
  result: AdmissionResult,
  now = Date.now(),
): Record<string, string> {
  return {
    RateLimit: result.policies
      .map((policy) => {
        const seconds = Math.max(0, Math.ceil((policy.resetAt - now) / 1000));
        return `${policy.name};q=${policy.limit};r=${policy.remaining};t=${seconds}`;
      })
      .join(", "),
    "RateLimit-Policy": result.policies
      .map((policy) => {
        const windowSeconds =
          policy.windowSeconds ??
          (policy.window === "month"
            ? utcMonthBounds(now).windowSeconds
            : policy.window === "day"
              ? 86_400
              : 60);
        return `${policy.name};q=${policy.limit};w=${windowSeconds}`;
      })
      .join(", "),
  };
}
