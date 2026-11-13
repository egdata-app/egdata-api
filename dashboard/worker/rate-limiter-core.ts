export const QUOTA_WINDOW_MS = 60_000;
export const MAX_POLICIES = 8;
export const FREE_MONTHLY_ALLOWANCE = 100_000;
export const MONTHLY_POLICY_NAME = "monthly";
export const PERIOD_POLICY_NAME = "period";

export type QuotaWindow = "minute" | "month" | "period";

export type QuotaPolicy = {
  name: string;
  limit: number;
  window?: QuotaWindow;
  periodStart?: number;
  periodEnd?: number;
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

export type PeriodQuotaState = {
  periodStart: number;
  periodEnd: number;
  used: number;
  policyCounts: Record<string, number>;
};

export type PeriodQuotaSummary = {
  periodStart: number;
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
  nextPeriodState: PeriodQuotaState | null;
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
  let periodBounds: { periodStart: number; periodEnd: number } | null = null;
  for (const policy of policies) {
    if (!policy || !POLICY_NAME.test(policy.name)) {
      throw new Error("Invalid quota policy name");
    }
    if (names.has(policy.name)) {
      throw new Error("Duplicate quota policy name");
    }
    names.add(policy.name);
    const window = policy.window ?? "minute";
    if (window !== "minute" && window !== "month" && window !== "period") {
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
    if (window === "period") {
      if (
        !Number.isInteger(policy.periodStart) ||
        !Number.isInteger(policy.periodEnd) ||
        (policy.periodStart ?? -1) < 0 ||
        (policy.periodEnd ?? 0) <= (policy.periodStart ?? 0)
      ) {
        throw new Error(
          "Billing-period quota policy requires valid integer periodStart and periodEnd",
        );
      }
      if (!periodBounds) {
        periodBounds = {
          periodStart: policy.periodStart!,
          periodEnd: policy.periodEnd!,
        };
      } else if (
        periodBounds.periodStart !== policy.periodStart ||
        periodBounds.periodEnd !== policy.periodEnd
      ) {
        throw new Error(
          "All billing-period policies in one admission must share period bounds",
        );
      }
    } else if (policy.name === PERIOD_POLICY_NAME) {
      throw new Error("Policy named period must use the period window");
    }
    const maxLimit =
      window === "month" || window === "period" ? 1_000_000_000 : 1_000_000;
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

export function summarizePeriodQuota(
  state: PeriodQuotaState | null,
  allowance: number,
  periodStart: number,
  periodEnd: number,
): PeriodQuotaSummary {
  const samePeriod =
    state !== null &&
    state.periodStart === periodStart &&
    state.periodEnd === periodEnd;
  const used = samePeriod ? state.used : 0;
  return {
    periodStart,
    resetAt: periodEnd,
    used,
    allowance,
    remaining: Math.max(0, allowance - used),
  };
}

export function applyUsageCredit(used: number, creditAmount: number): number {
  const safeCredit = Number.isFinite(creditAmount)
    ? Math.max(0, Math.floor(creditAmount))
    : 0;
  return Math.max(0, Math.max(0, Math.floor(used)) - safeCredit);
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
  periodState?: PeriodQuotaState | null;
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

  const periodPolicies = policies.filter(
    (policy) => (policy.window ?? "minute") === "period",
  );
  const periodPolicy = periodPolicies.find(
    (policy) => policy.name === PERIOD_POLICY_NAME,
  );
  const firstPeriodPolicy = periodPolicies[0];
  const periodStart = firstPeriodPolicy?.periodStart ?? 0;
  const periodEnd = firstPeriodPolicy?.periodEnd ?? 0;
  const periodWindowSeconds = firstPeriodPolicy
    ? Math.max(1, Math.round((periodEnd - periodStart) / 1000))
    : 0;
  const periodState: PeriodQuotaState | null = firstPeriodPolicy
    ? options.periodState &&
      options.periodState.periodStart === periodStart &&
      options.periodState.periodEnd === periodEnd
      ? options.periodState
      : { periodStart, periodEnd, used: 0, policyCounts: {} }
    : null;

  const used = (policy: QuotaPolicy) => {
    const policyWindow = policy.window ?? "minute";
    if (policyWindow === "month") {
      return monthlyState?.used ?? 0;
    }
    if (policyWindow === "period") {
      return policy.name === PERIOD_POLICY_NAME
        ? (periodState?.used ?? 0)
        : (periodState?.policyCounts[policy.name] ?? 0);
    }
    return policy.name === "global"
      ? state.globalCount
      : (state.policyCounts[policy.name] ?? 0);
  };

  const resetFor = (policy: QuotaPolicy) => {
    const policyWindow = policy.window ?? "minute";
    if (policyWindow === "month") return monthBounds.resetAt;
    if (policyWindow === "period") return periodEnd;
    return minuteResetAt;
  };

  const windowSecondsFor = (policy: QuotaPolicy) => {
    const policyWindow = policy.window ?? "minute";
    if (policyWindow === "month") return monthBounds.windowSeconds;
    if (policyWindow === "period") return periodWindowSeconds;
    return minuteWindowSeconds;
  };

  const windowStartFor = (policy: QuotaPolicy) => {
    const policyWindow = policy.window ?? "minute";
    if (policyWindow === "month") return monthBounds.monthStart;
    if (policyWindow === "period") return periodStart;
    return windowStart;
  };

  const exhausted =
    (monthlyPolicy && used(monthlyPolicy) >= monthlyPolicy.limit
      ? monthlyPolicy
      : undefined) ??
    (periodPolicy && used(periodPolicy) >= periodPolicy.limit
      ? periodPolicy
      : undefined) ??
    policies.find((policy) => used(policy) >= policy.limit);

  if (exhausted) {
    const resetAt = resetFor(exhausted);
    const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return {
      result: {
        allowed: false,
        windowStart: windowStartFor(exhausted),
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
      nextPeriodState: periodState,
    };
  }

  // Preserve unrelated minute policy counters within the active UTC minute window.
  const policyCounts: Record<string, number> = { ...state.policyCounts };
  const periodPolicyCounts: Record<string, number> = periodState
    ? { ...periodState.policyCounts }
    : {};
  const results: QuotaPolicyResult[] = policies.map((policy) => {
    const policyWindow = policy.window ?? "minute";
    const nextUsed = used(policy) + 1;
    if (policyWindow === "minute" && policy.name !== "global") {
      policyCounts[policy.name] = nextUsed;
    } else if (
      policyWindow === "period" &&
      policy.name !== PERIOD_POLICY_NAME
    ) {
      periodPolicyCounts[policy.name] = nextUsed;
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
    nextPeriodState: periodState
      ? {
          periodStart: periodState.periodStart,
          periodEnd: periodState.periodEnd,
          used: periodPolicy ? periodState.used + 1 : periodState.used,
          policyCounts: periodPolicyCounts,
        }
      : null,
  };
}
