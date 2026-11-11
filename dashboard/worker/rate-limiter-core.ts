export const QUOTA_WINDOW_MS = 60_000;
export const MAX_POLICIES = 4;

export type QuotaPolicy = {
  name: string;
  limit: number;
};

export type QuotaPolicyResult = {
  name: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
};

export type QuotaState = {
  windowStart: number;
  globalCount: number;
  policyCounts: Record<string, number>;
};

export type AdmissionResult = {
  allowed: boolean;
  windowStart: number;
  resetAt: number;
  retryAfter: number;
  exhaustedPolicy: string | null;
  policies: QuotaPolicyResult[];
};

export type AdmissionDecision = {
  result: AdmissionResult;
  nextState: QuotaState;
};

const POLICY_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function validatePolicies(policies: readonly QuotaPolicy[]): void {
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new Error("At least one quota policy is required");
  }
  if (policies.length > MAX_POLICIES) {
    throw new Error(`At most ${MAX_POLICIES} quota policies are supported`);
  }
  const names = new Set<string>();
  for (const policy of policies) {
    if (!policy || !POLICY_NAME.test(policy.name)) {
      throw new Error("Invalid quota policy name");
    }
    if (names.has(policy.name)) {
      throw new Error("Duplicate quota policy name");
    }
    names.add(policy.name);
    if (
      !Number.isInteger(policy.limit) ||
      policy.limit < 1 ||
      policy.limit > 1_000_000
    ) {
      throw new Error(
        "Quota policy limit must be an integer between 1 and 1000000",
      );
    }
  }
  if (policies[0]?.name !== "global") {
    throw new Error("The first quota policy must be the global policy");
  }
}

export function utcWindowStart(
  nowMs: number,
  windowMs = QUOTA_WINDOW_MS,
): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * Pure admission decision used by the Durable Object. A denied request never
 * produces a new state, so exhausted counters are read without being rewritten.
 */
export function decideAdmission(options: {
  now: number;
  policies: readonly QuotaPolicy[];
  state: QuotaState | null;
  windowMs?: number;
}): AdmissionDecision {
  const windowMs = options.windowMs ?? QUOTA_WINDOW_MS;
  const { policies } = options;
  validatePolicies(policies);

  const now = options.now;
  const windowStart = utcWindowStart(now, windowMs);
  const resetAt = windowStart + windowMs;
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));

  const state =
    options.state && options.state.windowStart === windowStart
      ? options.state
      : { windowStart, globalCount: 0, policyCounts: {} };

  const used = (policy: QuotaPolicy) =>
    policy.name === "global"
      ? state.globalCount
      : (state.policyCounts[policy.name] ?? 0);

  const exhausted = policies.find((policy) => used(policy) >= policy.limit);
  if (exhausted) {
    return {
      result: {
        allowed: false,
        windowStart,
        resetAt,
        retryAfter,
        exhaustedPolicy: exhausted.name,
        policies: policies.map((policy) => ({
          name: policy.name,
          limit: policy.limit,
          used: used(policy),
          remaining: Math.max(0, policy.limit - used(policy)),
          resetAt,
        })),
      },
      nextState: state,
    };
  }

  const policyCounts: Record<string, number> = {};
  const results: QuotaPolicyResult[] = policies.map((policy) => {
    const nextUsed = used(policy) + 1;
    if (policy.name !== "global") {
      policyCounts[policy.name] = nextUsed;
    }
    return {
      name: policy.name,
      limit: policy.limit,
      used: nextUsed,
      remaining: policy.limit - nextUsed,
      resetAt,
    };
  });

  return {
    result: {
      allowed: true,
      windowStart,
      resetAt,
      retryAfter,
      exhaustedPolicy: null,
      policies: results,
    },
    nextState: {
      windowStart,
      globalCount: state.globalCount + 1,
      policyCounts,
    },
  };
}
