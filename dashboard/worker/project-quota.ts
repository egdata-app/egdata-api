import type { AdmissionResult, QuotaPolicy } from "./rate-limiter-core.js";
import type { CachedKeyMetadata, DashboardEnv } from "./types.js";

const QUOTA_TIMEOUT_MS = 3_000;

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

/** Both gateways use the same project object and global policy. */
export async function admitProjectRequest(
  env: DashboardEnv,
  meta: CachedKeyMetadata,
  additionalPolicies: QuotaPolicy[] = [],
  operationId?: string,
): Promise<AdmissionResult> {
  if (!env.API_KEY_RATE_LIMITER || !meta.projectId) {
    throw new Error("quota_binding_or_project_missing");
  }
  const policies = [
    { name: "global", limit: quotaForProject(meta) },
    ...additionalPolicies,
  ];
  const environment = env.RATE_LIMIT_ENVIRONMENT || "production";
  const objectId = env.API_KEY_RATE_LIMITER.idFromName(
    `project:${environment}:${meta.projectId}`,
  );
  const stub = env.API_KEY_RATE_LIMITER.get(objectId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      stub.admit({
        keyId: meta.keyId,
        projectId: meta.projectId,
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
      !result.policies.every(
        (entry, index) =>
          entry?.name === policies[index].name &&
          entry.limit === policies[index].limit &&
          Number.isInteger(entry.remaining) &&
          entry.remaining >= 0 &&
          Number.isFinite(entry.resetAt),
      )
    ) {
      throw new Error("quota_invalid_decision");
    }
    return result;
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
      .map((policy) => `${policy.name};q=${policy.limit};w=60`)
      .join(", "),
  };
}
