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
