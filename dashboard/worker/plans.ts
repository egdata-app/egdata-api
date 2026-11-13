import type { V1ExpensivePolicy } from "./v1-routes.js";

export type ApiKeyTier = "free" | "pro" | "scale" | "enterprise";
export type CommercialPlanId = "free" | "pro" | "scale";
export type PlanVersionId = "free-v1" | "pro-v1" | "scale-v1" | "legacy-free" | "manual-custom";
export type GrantSource = "free" | "subscription" | "manual" | "grandfathered" | "legacy";
export type ExpensivePeriodBudgetKey = "nl-search" | "bulk" | "image";

/**
 * Section 14 operator sign-off defaults.
 * All policy durations and per-tier budgets are centralized here and can be
 * overridden cleanly before launch without changing enforcement code.
 */
export const BILLING_POLICY_DEFAULTS = {
  currency: "eur",
  vatIncludedInConsumerPrices: true,
  defaultVatRatePercent: 21,
  billingInterval: "month" as const,
  /** Calendar days after payment failure before a past_due subscription loses paid capacity. */
  gracePeriodDays: 3,
  /** Statutory EU/Spain consumer withdrawal period from checkout completion. */
  withdrawalWindowDays: 14,
  /** Short-window automatic goodwill review threshold. */
  goodwillRefundWindowDays: 7,
  /** Usage warning percentages shown in dashboard notices. */
  usageWarningThresholds: [80, 95, 100] as const,
  /** Pinned Stripe API version for Worker REST calls. */
  stripeApiVersion: "2024-06-20",
  /** Active published plan versions mapped by commercial plan ID. */
  activeVersions: {
    free: "free-v1",
    pro: "pro-v1",
    scale: "scale-v1",
  } as const,
} as const;

export interface PlanVersionSpec {
  versionId: "free-v1" | "pro-v1" | "scale-v1";
  planId: CommercialPlanId;
  tier: ApiKeyTier;
  displayName: string;
  priceEurCents: number;
  currency: "eur";
  vatIncluded: boolean;
  billingInterval: "month";
  periodType: "calendar_month" | "billing_period";
  rpmLimit: number;
  periodAllowance: number;
  expensiveMinuteLimits: Record<V1ExpensivePolicy, number>;
  expensivePeriodBudgets: Record<ExpensivePeriodBudgetKey, number>;
  entitlements: readonly string[];
  supportLevel: string;
  exhaustionBehavior: "hard_cap";
  selfServePurchasable: boolean;
}

export const PLAN_VERSIONS: Record<"free-v1" | "pro-v1" | "scale-v1", PlanVersionSpec> = {
  "free-v1": {
    versionId: "free-v1",
    planId: "free",
    tier: "free",
    displayName: "Free",
    priceEurCents: 0,
    currency: "eur",
    vatIncluded: true,
    billingInterval: "month",
    periodType: "calendar_month",
    rpmLimit: 60,
    periodAllowance: 100_000,
    expensiveMinuteLimits: {
      "offers-list": 5,
      search: 60,
      heavy: 20,
      bulk: 5,
    },
    expensivePeriodBudgets: {
      "nl-search": 500,
      bulk: 1_000,
      image: 2_000,
    },
    entitlements: [
      "catalog:ordinary",
      "search:basic",
      "search:nl",
      "image:og",
      "bulk:resolve",
      "graphql:read",
    ],
    supportLevel: "Community, best effort",
    exhaustionBehavior: "hard_cap",
    selfServePurchasable: false,
  },
  "pro-v1": {
    versionId: "pro-v1",
    planId: "pro",
    tier: "pro",
    displayName: "Pro",
    priceEurCents: 900,
    currency: "eur",
    vatIncluded: true,
    billingInterval: "month",
    periodType: "billing_period",
    rpmLimit: 200,
    periodAllowance: 300_000,
    expensiveMinuteLimits: {
      "offers-list": 20,
      search: 200,
      heavy: 60,
      bulk: 15,
    },
    expensivePeriodBudgets: {
      "nl-search": 2_500,
      bulk: 10_000,
      image: 15_000,
    },
    entitlements: [
      "catalog:ordinary",
      "search:basic",
      "search:nl",
      "image:og",
      "bulk:resolve",
      "graphql:read",
      "tier:pro",
    ],
    supportLevel: "Email, best effort",
    exhaustionBehavior: "hard_cap",
    selfServePurchasable: true,
  },
  "scale-v1": {
    versionId: "scale-v1",
    planId: "scale",
    tier: "scale",
    displayName: "Scale",
    priceEurCents: 1900,
    currency: "eur",
    vatIncluded: true,
    billingInterval: "month",
    periodType: "billing_period",
    rpmLimit: 600,
    periodAllowance: 1_000_000,
    expensiveMinuteLimits: {
      "offers-list": 60,
      search: 600,
      heavy: 180,
      bulk: 40,
    },
    expensivePeriodBudgets: {
      "nl-search": 10_000,
      bulk: 40_000,
      image: 50_000,
    },
    entitlements: [
      "catalog:ordinary",
      "search:basic",
      "search:nl",
      "image:og",
      "bulk:resolve",
      "graphql:read",
      "tier:pro",
      "tier:scale",
    ],
    supportLevel: "Email, best effort",
    exhaustionBehavior: "hard_cap",
    selfServePurchasable: true,
  },
};

export interface EffectiveProjectEntitlement {
  projectId: string;
  ownerEpicId: string;
  planId: CommercialPlanId | "enterprise" | "custom";
  planVersionId: PlanVersionId;
  tier: ApiKeyTier;
  grantSource: GrantSource;
  revision: number;
  rpmLimit: number;
  periodAllowance: number | null;
  periodType: "calendar_month" | "billing_period" | "unlimited";
  periodStart: number | null;
  periodEnd: number | null;
  expensiveMinuteLimits: Record<V1ExpensivePolicy, number>;
  expensivePeriodBudgets: Record<ExpensivePeriodBudgetKey, number> | null;
  entitlements: string[];
  status: "active" | "grace" | "canceled_active" | "expired" | "revoked";
  graceUntil: number | null;
  cancelAtPeriodEnd: boolean;
  subscriptionId: string | null;
  reason: string | null;
}

export const COMMERCIAL_PUBLIC_PLANS = [
  PLAN_VERSIONS["free-v1"],
  PLAN_VERSIONS["pro-v1"],
  PLAN_VERSIONS["scale-v1"],
] as const;

export function getPlanVersion(
  planIdOrVersion: string,
): PlanVersionSpec | null {
  if (planIdOrVersion in PLAN_VERSIONS) {
    return PLAN_VERSIONS[planIdOrVersion as keyof typeof PLAN_VERSIONS];
  }
  if (planIdOrVersion === "free") return PLAN_VERSIONS["free-v1"];
  if (planIdOrVersion === "pro") return PLAN_VERSIONS["pro-v1"];
  if (planIdOrVersion === "scale") return PLAN_VERSIONS["scale-v1"];
  return null;
}

export function isCommercialLimitsEnabled(env?: {
  COMMERCIAL_PLAN_LIMITS_ENABLED?: string;
}): boolean {
  return env?.COMMERCIAL_PLAN_LIMITS_ENABLED?.trim().toLowerCase() === "true";
}

export function legacyExpensiveLimitsForProject(
  tier: ApiKeyTier,
  effectiveRpm: number,
): Record<V1ExpensivePolicy, number> {
  if (tier === "scale") {
    return { ...PLAN_VERSIONS["scale-v1"].expensiveMinuteLimits };
  }
  const base: Record<V1ExpensivePolicy, number> = {
    "offers-list": 5,
    search: 300,
    heavy: 60,
    bulk: 10,
  };
  const legacyFreeRpm = 120;
  return {
    "offers-list": Math.min(
      effectiveRpm,
      Math.max(1, Math.floor((base["offers-list"] * effectiveRpm) / legacyFreeRpm)),
    ),
    search: Math.min(
      effectiveRpm,
      Math.max(1, Math.floor((base.search * effectiveRpm) / legacyFreeRpm)),
    ),
    heavy: Math.min(
      effectiveRpm,
      Math.max(1, Math.floor((base.heavy * effectiveRpm) / legacyFreeRpm)),
    ),
    bulk: Math.min(
      effectiveRpm,
      Math.max(1, Math.floor((base.bulk * effectiveRpm) / legacyFreeRpm)),
    ),
  };
}

export function fallbackProjectEntitlement(options: {
  projectId: string;
  ownerEpicId: string;
  tier: ApiKeyTier;
  customRpm: number | null;
  commercialLimitsEnabled?: boolean;
  grantSource?: GrantSource;
  revision?: number;
}): EffectiveProjectEntitlement {
  const commercial = Boolean(options.commercialLimitsEnabled);
  const { tier, customRpm } = options;

  if (tier === "scale") {
    const spec = PLAN_VERSIONS["scale-v1"];
    return {
      projectId: options.projectId,
      ownerEpicId: options.ownerEpicId,
      planId: "scale",
      planVersionId: "scale-v1",
      tier: "scale",
      grantSource: options.grantSource ?? "free",
      revision: options.revision ?? 0,
      rpmLimit: customRpm && customRpm > 0 ? customRpm : spec.rpmLimit,
      periodAllowance: spec.periodAllowance,
      periodType: "billing_period",
      periodStart: null,
      periodEnd: null,
      expensiveMinuteLimits: { ...spec.expensiveMinuteLimits },
      expensivePeriodBudgets: { ...spec.expensivePeriodBudgets },
      entitlements: [...spec.entitlements],
      status: "active",
      graceUntil: null,
      cancelAtPeriodEnd: false,
      subscriptionId: null,
      reason: null,
    };
  }

  if (tier === "enterprise" || (tier === "pro" && options.grantSource === "manual")) {
    const baseRpm = tier === "enterprise" ? 6_000 : 1_200;
    const rpmLimit =
      typeof customRpm === "number" && customRpm >= 1 && customRpm <= 60_000
        ? Math.floor(customRpm)
        : baseRpm;
    return {
      projectId: options.projectId,
      ownerEpicId: options.ownerEpicId,
      planId: tier === "enterprise" ? "enterprise" : "pro",
      planVersionId: "manual-custom",
      tier,
      grantSource: options.grantSource ?? "manual",
      revision: options.revision ?? 0,
      rpmLimit,
      periodAllowance: null,
      periodType: "unlimited",
      periodStart: null,
      periodEnd: null,
      expensiveMinuteLimits: legacyExpensiveLimitsForProject(tier, rpmLimit),
      expensivePeriodBudgets: null,
      entitlements: [
        ...PLAN_VERSIONS["scale-v1"].entitlements,
        tier === "enterprise" ? "tier:enterprise" : "tier:pro",
      ],
      status: "active",
      graceUntil: null,
      cancelAtPeriodEnd: false,
      subscriptionId: null,
      reason: null,
    };
  }

  if (tier === "pro") {
    // Legacy non-commercial manual pro vs commercial pro without active grant
    if (!commercial && options.grantSource !== "subscription") {
      const rpmLimit =
        typeof customRpm === "number" && customRpm >= 1 && customRpm <= 60_000
          ? Math.floor(customRpm)
          : 1_200;
      return {
        projectId: options.projectId,
        ownerEpicId: options.ownerEpicId,
        planId: "pro",
        planVersionId: "manual-custom",
        tier: "pro",
        grantSource: options.grantSource ?? "legacy",
        revision: options.revision ?? 0,
        rpmLimit,
        periodAllowance: null,
        periodType: "unlimited",
        periodStart: null,
        periodEnd: null,
        expensiveMinuteLimits: legacyExpensiveLimitsForProject("pro", rpmLimit),
        expensivePeriodBudgets: null,
        entitlements: [...PLAN_VERSIONS["pro-v1"].entitlements],
        status: "active",
        graceUntil: null,
        cancelAtPeriodEnd: false,
        subscriptionId: null,
        reason: null,
      };
    }

    const spec = PLAN_VERSIONS["pro-v1"];
    return {
      projectId: options.projectId,
      ownerEpicId: options.ownerEpicId,
      planId: "pro",
      planVersionId: "pro-v1",
      tier: "pro",
      grantSource: options.grantSource ?? "free",
      revision: options.revision ?? 0,
      rpmLimit: customRpm && customRpm > 0 ? customRpm : spec.rpmLimit,
      periodAllowance: spec.periodAllowance,
      periodType: "billing_period",
      periodStart: null,
      periodEnd: null,
      expensiveMinuteLimits: { ...spec.expensiveMinuteLimits },
      expensivePeriodBudgets: { ...spec.expensivePeriodBudgets },
      entitlements: [...spec.entitlements],
      status: "active",
      graceUntil: null,
      cancelAtPeriodEnd: false,
      subscriptionId: null,
      reason: null,
    };
  }

  // Free tier (commercial 60 RPM when enabled, or legacy 120 RPM before operator switch)
  const freeSpec = PLAN_VERSIONS["free-v1"];
  const rpmLimit =
    typeof customRpm === "number" && customRpm >= 1 && customRpm <= 60_000
      ? Math.floor(customRpm)
      : commercial
        ? freeSpec.rpmLimit
        : 120;

  return {
    projectId: options.projectId,
    ownerEpicId: options.ownerEpicId,
    planId: "free",
    planVersionId: commercial ? "free-v1" : "legacy-free",
    tier: "free",
    grantSource: options.grantSource ?? (commercial ? "free" : "legacy"),
    revision: options.revision ?? 0,
    rpmLimit,
    periodAllowance: freeSpec.periodAllowance,
    periodType: "calendar_month",
    periodStart: null,
    periodEnd: null,
    expensiveMinuteLimits: commercial
      ? { ...freeSpec.expensiveMinuteLimits }
      : legacyExpensiveLimitsForProject("free", rpmLimit),
    expensivePeriodBudgets: commercial
      ? { ...freeSpec.expensivePeriodBudgets }
      : null,
    entitlements: [...freeSpec.entitlements],
    status: "active",
    graceUntil: null,
    cancelAtPeriodEnd: false,
    subscriptionId: null,
    reason: null,
  };
}

export function resolveExpensivePeriodBudgetKey(
  pathname: string,
  method: string,
  operationId?: string,
): ExpensivePeriodBudgetKey | null {
  const upper = method.toUpperCase();
  if (
    operationId === "naturalLanguageSearch" ||
    (pathname === "/search/natural-language" && upper === "POST") ||
    pathname === "/v1/search/natural-language"
  ) {
    return "nl-search";
  }

  if (
    operationId === "resolveLauncherRecords" ||
    pathname === "/builds/resolve-launcher-records" ||
    pathname === "/v1/builds/resolve-launcher-records" ||
    pathname === "/catalog" ||
    pathname.startsWith("/catalog/") ||
    pathname === "/v1/catalog" ||
    pathname.startsWith("/v1/catalog/")
  ) {
    return "bulk";
  }

  if (
    operationId?.endsWith("Og") ||
    operationId === "getSellerCover" ||
    /\/og(?:\.webp)?$/.test(pathname) ||
    /\/cover$/.test(pathname)
  ) {
    return "image";
  }

  return null;
}

export function requiredEntitlementForRequest(
  pathname: string,
  method: string,
  operationId?: string,
): string {
  const budgetKey = resolveExpensivePeriodBudgetKey(pathname, method, operationId);
  if (budgetKey === "nl-search") return "search:nl";
  if (budgetKey === "bulk") return "bulk:resolve";
  if (budgetKey === "image") return "image:og";

  if (
    pathname === "/export" ||
    pathname.startsWith("/export/") ||
    pathname === "/v1/export" ||
    pathname.startsWith("/v1/export/")
  ) {
    return "replication:export";
  }

  if (pathname === "/graphql" || pathname.startsWith("/graphql/")) {
    return "graphql:read";
  }

  return "catalog:ordinary";
}

export function evaluatePlanEntitlement(
  entitlement: EffectiveProjectEntitlement,
  request: { pathname: string; method: string; operationId?: string },
): { allowed: boolean; requiredEntitlement: string; message?: string } {
  const required = requiredEntitlementForRequest(
    request.pathname,
    request.method,
    request.operationId,
  );
  if (!entitlement.entitlements.includes(required)) {
    return {
      allowed: false,
      requiredEntitlement: required,
      message: `Current plan '${entitlement.planId}' does not include the '${required}' entitlement.`,
    };
  }
  return { allowed: true, requiredEntitlement: required };
}
