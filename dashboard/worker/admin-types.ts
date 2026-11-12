import type { UsageMetrics, UsageTableResult } from "./analytics-types.js";
import type { DashboardProject } from "./types.js";

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

export interface AdminUserDetail {
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
  limitRequests: AdminUserLimitRequest[];
  privacyRequests: AdminUserPrivacyRequest[];
  usage: AdminUsage;
}
