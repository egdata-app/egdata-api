import type {
  AdminAuditEntry,
  AdminPage,
  AdminProject,
  AdminUser,
  AdminUserAnalyticsRange,
  AdminUserDetail,
} from "../../worker/admin-types";
import type { AnalyticsDashboardSummary } from "../../worker/analytics";
import type {
  UsageFilters,
  UsageTableFilters,
  UsageTableResult,
} from "../../worker/analytics-types";
import type { DeveloperReceipt } from "../../worker/developer-receipts";
import type { DeveloperStatus } from "../../worker/developer-status";

export type {
  UsageDimension,
  UsageFilters,
  UsageMetrics,
  UsageRow,
  UsageSort,
  UsageTableFilters,
  UsageTableResult,
} from "../../worker/analytics-types";
export type { DeveloperReceipt } from "../../worker/developer-receipts";
export type { DeveloperStatus } from "../../worker/developer-status";

import type {
  AccountMonthlyQuotaStatus,
  AllowedHttpMethod,
  ApiScope,
  DashboardApiKey,
  DashboardProject,
  EpicSessionUser,
  LimitIncreaseRequestRecord,
} from "../../worker/types";

export type {
  AccountMonthlyQuotaStatus,
  AllowedHttpMethod,
  AnalyticsDashboardSummary,
  ApiScope,
  DashboardApiKey,
  DashboardProject,
  EpicSessionUser,
  LimitIncreaseRequestRecord,
};

export interface PublicBillingPlan {
  versionId: "free-v1" | "pro-v1" | "scale-v1";
  planId: "free" | "pro" | "scale";
  tier: "free" | "pro" | "scale" | "enterprise";
  displayName: string;
  priceEurCents: number;
  currency: "eur";
  vatIncluded: boolean;
  billingInterval: "month";
  periodType: "calendar_month" | "billing_period";
  rpmLimit: number;
  periodAllowance: number;
  initialDailyLimit: number | null;
  expensiveMinuteLimits: Record<"offers-list" | "search" | "heavy" | "bulk", number>;
  expensivePeriodBudgets: Record<"nl-search" | "bulk" | "image", number>;
  supportLevel: string;
  exhaustionBehavior: "hard_cap";
  selfServePurchasable: boolean;
}

export interface BillingPlansResponse {
  currency: string;
  vatIncludedInConsumerPrices: boolean;
  defaultVatRatePercent: number;
  gracePeriodDays: number;
  withdrawalWindowDays: number;
  initialPeriodDailyLimitDays: number;
  termsVersion: string;
  plans: PublicBillingPlan[];
}

export interface ProjectBillingSummaryResponse {
  project: {
    id: string;
    name: string;
    tier: DashboardProject["tier"];
    deletedAt: string | null;
  };
  entitlement: {
    projectId: string;
    planId: string;
    planVersionId: string;
    tier: DashboardProject["tier"];
    grantSource: "free" | "subscription" | "manual" | "grandfathered" | "legacy";
    revision: number;
    rpmLimit: number;
    periodAllowance: number | null;
    periodType: "calendar_month" | "billing_period" | "unlimited";
    periodStart: number | null;
    periodEnd: number | null;
    initialDailyLimit?: number | null;
    initialDailyLimitUntil?: number | null;
    expensiveMinuteLimits: Record<string, number>;
    expensivePeriodBudgets: Record<string, number> | null;
    status: "active" | "grace" | "canceled_active" | "expired" | "revoked";
    graceUntil: number | null;
    cancelAtPeriodEnd: boolean;
    subscriptionId: string | null;
    reason: string | null;
  };
  subscription: {
    id: string;
    planVersionId: string;
    pendingPlanVersionId: string | null;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
    disputeStatus: string;
    refundStatus: string;
    refundedEurCents: number;
  } | null;
  usage: {
    used: number;
    remaining: number;
    allowance: number;
    resetAt: string | number;
    status: "ok" | "warning" | "critical" | "exhausted";
    policyCounts?: Record<string, number>;
  } | null;
  dailyUsage: {
    dayStart: number;
    resetAt: number;
    resetAtIso: string;
    used: number;
    remaining: number;
    allowance: number;
  } | null;
  withdrawalEligible: boolean;
  withdrawalExpiresAt: string | null;
  selfServeCheckoutBlocked: boolean;
  grants: Array<Record<string, unknown>>;
  receipts: Array<{
    id: string;
    plan_version_id: string;
    price_eur_cents: number;
    currency: string;
    terms_version: string;
    withdrawal_expires_at: number;
    action_type: string;
    accepted_at: number;
  }>;
  withdrawals: Array<{
    id: string;
    request_kind: string;
    status: string;
    requested_amount_cents: number | null;
    refunded_amount_cents: number;
    reason: string;
    created_at: string;
  }>;
}

export interface BillingPurchaseReceipt {
  id: string;
  project_id: string;
  project_name: string | null;
  subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  plan_version_id: string;
  price_eur_cents: number;
  currency: string;
  vat_included: number;
  terms_version: string;
  withdrawal_acknowledged: number;
  withdrawal_expires_at: number;
  action_type: string;
  accepted_at: number;
  created_at: string;
}

export interface BillingWithdrawalRecord {
  id: string;
  project_id: string;
  project_name: string | null;
  subscription_id: string;
  request_kind: string;
  status: string;
  requested_amount_cents: number | null;
  refunded_amount_cents: number;
  stripe_refund_id: string | null;
  reason: string;
  resolution_note: string;
  created_at: string;
}

export interface SessionResponse {
  authenticated: boolean;
  isAdmin: boolean;
  user: EpicSessionUser | null;
  projects: DashboardProject[];
  oauthConfigured: boolean;
  devAuthAvailable: boolean;
  account?: DeveloperStatus;
}

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function usageQuery(params: UsageTableFilters) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  return qs.toString();
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/_dashboard/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const data = (await res.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string };
  };

  if (!res.ok) {
    const code = data?.error?.code || "REQUEST_FAILED";
    if (["AGREEMENT_REQUIRED", "EMAIL_VERIFICATION_REQUIRED"].includes(code))
      window.dispatchEvent(new Event("egdata:account-changed"));
    throw new DashboardApiError(
      data?.error?.message || `Request failed (${res.status})`,
      code,
      res.status,
    );
  }

  return data;
}

export const dashboardClient = {
  getAgreementReceipts: (signal?: AbortSignal) =>
    apiFetch<{ acceptances: DeveloperReceipt[] }>("/account/receipt", {
      signal,
    }),
  requestEmailVerification: (email: string) =>
    apiFetch<{ ok: boolean; pendingEmail: string }>("/account/email", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  verifyEmail: (token: string) =>
    apiFetch<DeveloperStatus>("/account/email/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  acceptTerms: (revision: string, version: string, sha256: string) =>
    apiFetch<DeveloperStatus>("/account/agreements", {
      method: "POST",
      body: JSON.stringify({ revision, version, sha256, accepted: true }),
    }),
  deleteAccount: (confirmation: string) =>
    apiFetch<{ ok: boolean; message: string }>("/account", {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    }),
  getAdminUsers: (search: string, offset: number, signal?: AbortSignal) =>
    apiFetch<AdminPage<AdminUser>>(
      `/admin/users?${new URLSearchParams({ search, offset: String(offset) })}`,
      { signal },
    ),

  getAdminProjects: (
    search: string,
    offset: number,
    owner: string,
    status: "active" | "deleted",
    signal?: AbortSignal,
  ) =>
    apiFetch<AdminPage<AdminProject>>(
      `/admin/projects?${new URLSearchParams({ search, offset: String(offset), owner, status })}`,
      { signal },
    ),

  updateAdminUserLimits: (id: string, projectLimit: number, reason: string) =>
    apiFetch<{ ok: boolean }>(`/admin/users/${encodeURIComponent(id)}/limits`, {
      method: "PATCH",
      body: JSON.stringify({ projectLimit, reason }),
    }),

  getAdminUser: (id: string, signal?: AbortSignal) =>
    apiFetch<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`, {
      signal,
    }),

  getAdminUserAnalytics: (
    id: string,
    range: AdminUserAnalyticsRange,
    signal?: AbortSignal,
  ) =>
    apiFetch<AnalyticsDashboardSummary>(
      `/admin/users/${encodeURIComponent(id)}/analytics?${new URLSearchParams({ range })}`,
      { signal },
    ),

  updateAdminProjectLimits: (
    id: string,
    tier: DashboardProject["tier"],
    customRpm: number | null,
    reason: string,
  ) =>
    apiFetch<{ ok: boolean }>(
      `/admin/projects/${encodeURIComponent(id)}/limits`,
      {
        method: "PATCH",
        body: JSON.stringify({ tier, customRpm, reason }),
      },
    ),

  getAdminProjectKeys: (id: string, offset: number, signal?: AbortSignal) =>
    apiFetch<{ keys: DashboardApiKey[]; hasMore: boolean }>(
      `/admin/projects/${encodeURIComponent(id)}/keys?offset=${offset}`,
      { signal },
    ),

  deleteAdminProject: (id: string, reason: string) =>
    apiFetch<{ ok: boolean }>(`/admin/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),

  deleteAdminKey: (id: string, reason: string) =>
    apiFetch<{ ok: boolean }>(`/admin/keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),

  restoreAdminProject: (id: string, reason: string) =>
    apiFetch<{ ok: boolean }>(
      `/admin/projects/${encodeURIComponent(id)}/restore`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),

  reconcileAdminBilling: () =>
    apiFetch<{
      ok: boolean;
      expiredGraceCount: number;
      reconciledCount: number;
    }>("/admin/billing/reconcile", { method: "POST" }),

  creditAdminProjectUsage: (
    projectId: string,
    payload: {
      adjustmentId: string;
      scope: "period" | "month";
      amount: number;
      reason: string;
    },
  ) =>
    apiFetch<{ ok: boolean }>(
      `/admin/projects/${encodeURIComponent(projectId)}/usage-adjustments`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  getAdminAudit: (
    projectId: string,
    owner: string,
    offset: number,
    signal?: AbortSignal,
  ) =>
    apiFetch<{ rows: AdminAuditEntry[]; hasMore: boolean }>(
      `/admin/audit?${new URLSearchParams({ projectId, owner, offset: String(offset) })}`,
      { signal },
    ),

  getSession: () => apiFetch<SessionResponse>("/auth/session"),

  logout: () => apiFetch<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  createProject: (payload: {
    name: string;
    description?: string;
    websiteUrl?: string;
  }) =>
    apiFetch<{ project: DashboardProject }>("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getKeys: (projectId?: string) =>
    apiFetch<{ keys: DashboardApiKey[] }>(
      projectId ? `/keys?projectId=${encodeURIComponent(projectId)}` : "/keys",
    ),

  createKey: (payload: {
    projectId: string;
    name: string;
    scopes: ApiScope[];
    allowedIps: string[];
    allowedOrigins: string[];
    allowedPaths: string[];
    allowedMethods: AllowedHttpMethod[];
    expiresAt?: string | null;
  }) =>
    apiFetch<{ key: DashboardApiKey; secret: string }>("/keys", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateKey: (
    keyId: string,
    payload: {
      name?: string;
      active?: boolean;
      scopes?: ApiScope[];
      allowedIps?: string[];
      allowedOrigins?: string[];
      allowedPaths?: string[];
      allowedMethods?: AllowedHttpMethod[];
      expiresAt?: string | null;
    },
  ) =>
    apiFetch<{ key: DashboardApiKey }>(`/keys/${encodeURIComponent(keyId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  deleteKey: (keyId: string) =>
    apiFetch<{ ok: boolean; id: string }>(
      `/keys/${encodeURIComponent(keyId)}`,
      {
        method: "DELETE",
      },
    ),

  getAnalytics: (params: UsageFilters, signal?: AbortSignal) =>
    apiFetch<AnalyticsDashboardSummary>(`/analytics?${usageQuery(params)}`, {
      signal,
    }),

  getUsageTable: (params: UsageTableFilters, signal?: AbortSignal) =>
    apiFetch<UsageTableResult>(`/analytics/table?${usageQuery(params)}`, {
      signal,
    }),

  simulateTraffic: () =>
    apiFetch<{ ok: boolean; generated: number }>("/analytics/simulate", {
      method: "POST",
    }),

  getMonthlyQuota: (signal?: AbortSignal) =>
    apiFetch<{ monthly: AccountMonthlyQuotaStatus }>("/quota", { signal }),

  getLimitRequests: () =>
    apiFetch<{ requests: LimitIncreaseRequestRecord[] }>("/limit-requests"),

  getAdminLimitRequests: (
    status: LimitIncreaseRequestRecord["status"],
    offset = 0,
  ) =>
    apiFetch<{ requests: LimitIncreaseRequestRecord[]; hasMore: boolean }>(
      `/admin/limit-requests?status=${status}&offset=${offset}`,
    ),

  reviewLimitRequest: (
    id: string,
    decision: "approved" | "declined",
    note: string,
  ) =>
    apiFetch<{
      request: LimitIncreaseRequestRecord;
      quotaPropagationSeconds: number;
    }>(`/admin/limit-requests/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, note }),
    }),

  submitLimitRequest: (payload: {
    projectId: string;
    contactEmail: string;
    requestedTier: "pro" | "scale" | "enterprise" | "custom";
    requestedRpm: number;
    expectedMonthlyRequests: number;
    websiteUrl?: string;
    useCase: string;
  }) =>
    apiFetch<{
      request: LimitIncreaseRequestRecord;
      emailDelivery: { status: string; messageId?: string; error?: string };
    }>("/limit-requests", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getBillingPlans: () => apiFetch<BillingPlansResponse>("/billing/plans"),

  getProjectBilling: (projectId: string, signal?: AbortSignal) =>
    apiFetch<ProjectBillingSummaryResponse>(
      `/projects/${encodeURIComponent(projectId)}/billing`,
      { signal },
    ),

  startBillingCheckout: (payload: {
    projectId: string;
    planId: "pro" | "scale";
    termsVersion: string;
    withdrawalAcknowledged: boolean;
    idempotencyKey?: string;
  }) =>
    apiFetch<{
      subscriptionId: string;
      checkoutSessionId: string;
      checkoutUrl: string | null;
      alreadyPending: boolean;
      planVersionId: string;
    }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  cancelPendingBillingCheckout: (projectId: string) =>
    apiFetch<{ canceled: boolean; alreadyCompleted?: boolean }>(
      "/billing/checkout/cancel",
      {
        method: "POST",
        body: JSON.stringify({ projectId }),
      },
    ),

  createBillingPortal: (returnUrl?: string) =>
    apiFetch<{ url: string; sessionId: string }>("/billing/portal", {
      method: "POST",
      body: JSON.stringify(returnUrl ? { returnUrl } : {}),
    }),

  changeSubscriptionPlan: (payload: {
    projectId: string;
    targetPlanId: "free" | "pro" | "scale";
    idempotencyKey?: string;
  }) =>
    apiFetch<{ scheduledForPeriodEnd: boolean; pendingPlanVersionId?: string }>(
      "/billing/subscription/change",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  requestWithdrawal: (payload: {
    projectId: string;
    reason?: string;
    idempotencyKey?: string;
  }) =>
    apiFetch<{
      withdrawalId: string;
      status: string;
      refundedAmountCents: number;
      requestKind: string;
    }>("/billing/withdrawals", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getBillingReceipts: (signal?: AbortSignal) =>
    apiFetch<{
      receipts: BillingPurchaseReceipt[];
      withdrawals: BillingWithdrawalRecord[];
    }>("/billing/receipts", { signal }),
};
