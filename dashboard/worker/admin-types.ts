import type { UsageMetrics, UsageTableResult } from "./analytics-types.js";
import type { AccountMonthlyQuotaStatus, DashboardProject } from "./types.js";

export type AdminUserAnalyticsRange = "month" | "6" | "24" | "168" | "720";

export interface AdminUser {
  id: string;
  displayName: string;
  email: string | null;
  createdAt: string;
  projectLimit: number;
  projectCount: number;
  keyCount: number;
  activeKeyCount: number;
  lastUsedAt: string | null;
  isAdmin: number;
}

export interface AdminProject extends DashboardProject {
  ownerDisplayName: string;
  keyCount: number;
  activeKeyCount: number;
  lastUsedAt: string | null;
  effectiveRpm: number;
  deletedAt: string | null;
  deletedBy: string | null;
  deletionReason: string | null;
  purgeAfter: string | null;
}

export interface AdminAuditEntry {
  sequence: number;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  projectId: string | null;
  ownerId: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}

export interface AdminUsage {
  byId: Record<string, UsageMetrics>;
  source: UsageTableResult["source"] | "unavailable";
  start: string;
  end: string;
}

export interface AdminPage<T> {
  rows: T[];
  hasMore: boolean;
  usage: AdminUsage;
}

export interface AdminUserAgreement {
  receiptId: string | null;
  version: string;
  edition: string;
  sha256: string;
  acceptedAt: number;
  requirementRevision: string;
  privacyVersion: string | null;
  privacySha256: string | null;
  retainUntil: number | null;
}

export interface AdminUserOnboarding {
  rolloutEnabled: boolean;
  eligible: boolean;
  revision: string | null;
  requiredTermsVersion: string | null;
  requiredTermsEdition: string | null;
  requiredPrivacyVersion: string | null;
  contactEmail: string | null;
  pendingEmail: string | null;
  verifiedAt: number | null;
  acceptedCurrent: boolean;
  acceptedAt: number | null;
}

export interface AdminUserLimitRequest {
  id: string;
  projectId: string;
  requestedTier: string;
  requestedRpm: number;
  expectedMonthlyRequests: number;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string;
}

export interface AdminUserPrivacyRequest {
  id: string;
  caseReference: string;
  kind: string;
  receivedAt: number;
  dueAt: number;
  extendedDueAt: number | null;
  resolvedAt: number | null;
  resolution: string | null;
}

export interface AdminBillingCustomer {
  stripeCustomerId: string;
  environment: "test" | "live";
  email: string | null;
  createdAt: string;
}

export interface AdminBillingSubscription {
  id: string;
  projectId: string;
  projectName: string | null;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  planVersionId: string;
  pendingPlanVersionId: string | null;
  status: string;
  environment: "test" | "live";
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  graceUntil: number | null;
  lastInvoiceId: string | null;
  disputeStatus: string;
  refundStatus: string;
  refundedEurCents: number;
  needsReconcile: boolean;
  reconcileError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPurchaseReceipt {
  id: string;
  projectId: string;
  projectName: string | null;
  subscriptionId: string | null;
  stripeCheckoutSessionId: string | null;
  planVersionId: string;
  priceEurCents: number;
  currency: string;
  vatIncluded: boolean;
  termsVersion: string;
  withdrawalAcknowledged: boolean;
  withdrawalExpiresAt: number;
  actionType: string;
  acceptedAt: number;
  createdAt: string;
}

export interface AdminWithdrawalRequest {
  id: string;
  projectId: string;
  projectName: string | null;
  subscriptionId: string;
  requestKind: string;
  status: string;
  requestedAmountCents: number | null;
  refundedAmountCents: number;
  stripeRefundId: string | null;
  reason: string;
  resolutionNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminBillingAction {
  id: string;
  projectId: string | null;
  subscriptionId: string | null;
  actorId: string;
  action: string;
  status: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AdminUsageAdjustment {
  adjustmentId: string;
  projectId: string | null;
  scope: string;
  windowStart: number;
  amount: number;
  reason: string;
  actorId: string | null;
  createdAt: string;
}

export interface AdminEntitlementGrant {
  id: string;
  projectId: string;
  projectName: string | null;
  source: string;
  planId: string;
  planVersionId: string;
  tier: string;
  rpmLimit: number;
  periodAllowance: number | null;
  initialDailyLimit: number | null;
  initialDailyLimitUntil: number | null;
  expensiveMinuteLimits: Record<string, number> | null;
  expensivePeriodBudgets: Record<string, number> | null;
  effectiveFrom: number;
  effectiveUntil: number | null;
  revision: number;
  subscriptionId: string | null;
  grantedBy: string | null;
  reason: string;
  revokedAt: number | null;
  revokedBy: string | null;
  createdAt: string;
}

export interface AdminProjectQuotaDetail {
  projectId: string;
  planId: string;
  planVersionId: string;
  grantSource: string;
  rpmLimit: number;
  periodAllowance: number | null;
  periodType: "calendar_month" | "billing_period" | "unlimited";
  periodStart: number | null;
  periodEnd: number | null;
  status: string;
  reason: string | null;
  initialDailyLimit: number | null;
  initialDailyLimitUntil: number | null;
  expensiveMinuteLimits: Record<string, number>;
  expensivePeriodBudgets: Record<string, number> | null;
  periodUsage: {
    used: number;
    allowance: number;
    remaining: number;
    bonus?: number;
    policyCounts: Record<string, number>;
    status: "ok" | "warning" | "critical" | "exhausted";
  } | null;
  dailyUsage: {
    dayStart: number;
    used: number;
    allowance: number;
    remaining: number;
    resetAtIso: string;
  } | null;
}

export interface AdminUserBilling {
  customer: AdminBillingCustomer | null;
  subscriptions: AdminBillingSubscription[];
  receipts: AdminPurchaseReceipt[];
  withdrawals: AdminWithdrawalRequest[];
  actions: AdminBillingAction[];
  usageAdjustments: AdminUsageAdjustment[];
  grants: AdminEntitlementGrant[];
  selfServeCheckoutBlocked: boolean;
}

export interface AdminUserDetail {
  monthlyQuota: AccountMonthlyQuotaStatus | null;
  user: AdminUser & {
    preferredLanguage: string | null;
    updatedAt: string;
    lastProjectCreatedAt: number | null;
    deletedProjectCount: number;
    closedAt: number | null;
    purgeAfter: number | null;
  };
  onboarding: AdminUserOnboarding;
  agreements: AdminUserAgreement[];
  projects: AdminProject[];
  projectQuotas: Record<string, AdminProjectQuotaDetail>;
  limitRequests: AdminUserLimitRequest[];
  privacyRequests: AdminUserPrivacyRequest[];
  billing: AdminUserBilling;
  usage: AdminUsage;
}
