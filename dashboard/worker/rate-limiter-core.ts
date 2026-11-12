export const QUOTA_WINDOW_MS = 60_000;
export const MAX_POLICIES = 5;
export const FREE_MONTHLY_ALLOWANCE = 100_000;
export const MONTHLY_POLICY_NAME = "monthly";

export type QuotaWindow = "minute" | "month";

export type QuotaPolicy = {
  name: string;
  limit: number;
  window?: QuotaWindow;
};

export type QuotaPolicyResult = {
  name: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  window: QuotaWindow;
  windowSeconds: number;
};

export type QuotaState = {
  windowStart: number;
  globalCount: number;
  policyCounts: Record<string, number>;
};

export type MonthlyQuotaState = {
  monthStart: number;
  used: number;
};

export type MonthlyQuotaSummary = {
  monthStart: number;
  resetAt: number;
  used: number;
  allowance: number;
  remaining: number;
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
  nextMonthlyState: MonthlyQuotaState | null;
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
  let monthlyCount = 0;
  for (const policy of policies) {
    if (!policy || !POLICY_NAME.test(policy.name)) {
      throw new Error("Invalid quota policy name");
    }
    if (names.has(policy.name)) {
      throw new Error("Duplicate quota policy name");
    }
    names.add(policy.name);
    const window = policy.window ?? "minute";
    if (window !== "minute" && window !== "month") {
      throw new Error("Invalid quota policy window");
    }
    if (window === "month") {
      monthlyCount++;
      if (policy.name !== MONTHLY_POLICY_NAME) {
        throw new Error("Calendar-month policy must be named monthly");
      }
    } else if (policy.name === MONTHLY_POLICY_NAME) {
      throw new Error("Policy named monthly must use the month window");
    }
    const maxLimit = window === "month" ? 1_000_000_000 : 1_000_000;
    if (
      !Number.isInteger(policy.limit) ||
      policy.limit < 1 ||
      policy.limit > maxLimit
    ) {
      throw new Error(
        `Quota policy limit must be an integer between 1 and ${maxLimit}`,
      );
    }
  }
  if (monthlyCount > 1) {
    throw new Error("At most one calendar-month quota policy is supported");
  }
  if (
    policies[0]?.name !== "global" ||
    (policies[0]?.window ?? "minute") !== "minute"
  ) {
    throw new Error("The first quota policy must be the minute global policy");
  }
}

export function utcWindowStart(
  nowMs: number,
  windowMs = QUOTA_WINDOW_MS,
): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export function utcMonthBounds(nowMs: number): {
  monthStart: number;
  resetAt: number;
  windowSeconds: number;
} {
  const date = new Date(nowMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1, 0, 0, 0, 0);
  const resetAt = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  return {
    monthStart,
    resetAt,
    windowSeconds: Math.round((resetAt - monthStart) / 1000),
  };
}

export function summarizeMonthlyQuota(
  nowMs: number,
  state: MonthlyQuotaState | null,
  allowance = FREE_MONTHLY_ALLOWANCE,
): MonthlyQuotaSummary {
  const { monthStart, resetAt } = utcMonthBounds(nowMs);
  const used = state && state.monthStart === monthStart ? state.used : 0;
  return {
    monthStart,
    resetAt,
    used,
    allowance,
    remaining: Math.max(0, allowance - used),
  };
}

/**
 * Pure admission decision used by the Durable Object. A denied request never
 * produces a new state, so exhausted counters are read without being rewritten.
 */
export function decideAdmission(options: {
  now: number;
  policies: readonly QuotaPolicy[];
  state: QuotaState | null;
  monthlyState?: MonthlyQuotaState | null;
  windowMs?: number;
}): AdmissionDecision {
  const windowMs = options.windowMs ?? QUOTA_WINDOW_MS;
  const { policies } = options;
  validatePolicies(policies);

  const now = options.now;
  const windowStart = utcWindowStart(now, windowMs);
  const minuteResetAt = windowStart + windowMs;
  const minuteWindowSeconds = Math.round(windowMs / 1000);
  const monthBounds = utcMonthBounds(now);

  const state =
    options.state && options.state.windowStart === windowStart
      ? options.state
      : { windowStart, globalCount: 0, policyCounts: {} };

  const monthlyPolicy = policies.find(
    (policy) => (policy.window ?? "minute") === "month",
  );
  const monthlyState = monthlyPolicy
    ? options.monthlyState &&
      options.monthlyState.monthStart === monthBounds.monthStart
      ? options.monthlyState
      : { monthStart: monthBounds.monthStart, used: 0 }
    : null;

  const used = (policy: QuotaPolicy) => {
    if ((policy.window ?? "minute") === "month") {
      return monthlyState?.used ?? 0;
    }
    return policy.name === "global"
      ? state.globalCount
      : (state.policyCounts[policy.name] ?? 0);
  };

  const resetFor = (policy: QuotaPolicy) =>
    (policy.window ?? "minute") === "month"
      ? monthBounds.resetAt
      : minuteResetAt;

  const windowSecondsFor = (policy: QuotaPolicy) =>
    (policy.window ?? "minute") === "month"
      ? monthBounds.windowSeconds
      : minuteWindowSeconds;

  const exhausted =
    (monthlyPolicy && used(monthlyPolicy) >= monthlyPolicy.limit
      ? monthlyPolicy
      : undefined) ?? policies.find((policy) => used(policy) >= policy.limit);

  if (exhausted) {
    const resetAt = resetFor(exhausted);
    const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return {
      result: {
        allowed: false,
        windowStart:
          (exhausted.window ?? "minute") === "month"
            ? monthBounds.monthStart
            : windowStart,
        resetAt,
        retryAfter,
        exhaustedPolicy: exhausted.name,
        policies: policies.map((policy) => ({
          name: policy.name,
          limit: policy.limit,
          used: used(policy),
          remaining: Math.max(0, policy.limit - used(policy)),
          resetAt: resetFor(policy),
          window: policy.window ?? "minute",
          windowSeconds: windowSecondsFor(policy),
        })),
      },
      nextState: state,
      nextMonthlyState: monthlyState,
    };
  }

  const policyCounts: Record<string, number> = {};
  const results: QuotaPolicyResult[] = policies.map((policy) => {
    const policyWindow = policy.window ?? "minute";
    const nextUsed = used(policy) + 1;
    if (policyWindow === "minute" && policy.name !== "global") {
      policyCounts[policy.name] = nextUsed;
    }
    return {
      name: policy.name,
      limit: policy.limit,
      used: nextUsed,
      remaining: policy.limit - nextUsed,
      resetAt: resetFor(policy),
      window: policyWindow,
      windowSeconds: windowSecondsFor(policy),
    };
  });

  const retryAfter = Math.max(1, Math.ceil((minuteResetAt - now) / 1000));

  return {
    result: {
      allowed: true,
      windowStart,
      resetAt: minuteResetAt,
      retryAfter,
      exhaustedPolicy: null,
      policies: results,
    },
    nextState: {
      windowStart,
      globalCount: state.globalCount + 1,
      policyCounts,
    },
    nextMonthlyState: monthlyState
      ? {
          monthStart: monthBounds.monthStart,
          used: monthlyState.used + 1,
        }
      : null,
  };
}
