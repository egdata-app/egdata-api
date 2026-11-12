import {
  type AdmissionResult,
  FREE_MONTHLY_ALLOWANCE,
  MONTHLY_POLICY_NAME,
  type MonthlyQuotaSummary,
  type QuotaPolicy,
  utcMonthBounds,
} from "./rate-limiter-core.js";
import type {
  AccountMonthlyQuotaStatus,
  CachedKeyMetadata,
  DashboardEnv,
} from "./types.js";

const QUOTA_TIMEOUT_MS = 3_000;

export { FREE_MONTHLY_ALLOWANCE, MONTHLY_POLICY_NAME };

export const tierQuotas: Record<string, number> = {
  free: 120,
  pro: 1_200,
  enterprise: 6_000,
};

export function quotaForProject(project: {
  tier: string;
  customRpm: number | null;
}): number {
  const limit = project.customRpm;
  if (
    typeof limit === "number" &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= 1_000_000
  ) {
    return limit;
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

/** Both gateways share one account-scoped object for free monthly and per-project minute policies. */
export async function admitProjectRequest(
  env: DashboardEnv,
  meta: CachedKeyMetadata,
  additionalPolicies: QuotaPolicy[] = [],
  operationId?: string,
): Promise<AdmissionResult> {
  if (!env.API_KEY_RATE_LIMITER || !meta.projectId || !meta.ownerEpicId) {
    throw new Error("quota_binding_or_identity_missing");
  }
  const policies: QuotaPolicy[] = [
    { name: "global", limit: quotaForProject(meta), window: "minute" },
    ...(isFreeTierProject(meta)
      ? [
          {
            name: MONTHLY_POLICY_NAME,
            limit: FREE_MONTHLY_ALLOWANCE,
            window: "month" as const,
          },
        ]
      : []),
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
      !result.policies.every((entry, index) => {
        const expectedWindow = policies[index].window ?? "minute";
        const actualWindow = entry?.window ?? "minute";
        return (
          entry?.name === policies[index].name &&
          entry.limit === policies[index].limit &&
          actualWindow === expectedWindow &&
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
          (policy.window === "month" ? utcMonthBounds(now).windowSeconds : 60);
        return `${policy.name};q=${policy.limit};w=${windowSeconds}`;
      })
      .join(", "),
  };
}
