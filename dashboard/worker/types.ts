import type { GrantSource } from "./plans.js";

export type ApiKeyTier = "free" | "pro" | "scale" | "enterprise";

export const API_SCOPES = [
  "catalog:read",
  "offers:read",
  "items:read",
  "search:read",
  "graphql:read",
  "profiles:read",
  "stats:read",
  "builds:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const HTTP_METHODS = ["GET", "HEAD", "POST"] as const;

export type AllowedHttpMethod = (typeof HTTP_METHODS)[number];

export interface CachedKeyMetadata {
  keyId: string;
  projectId: string;
  ownerEpicId: string;
  name: string;
  tier: ApiKeyTier;
  active: boolean;
  scopes: ApiScope[];
  allowedIps: string[];
  allowedOrigins: string[];
  allowedPaths: string[];
  allowedMethods: AllowedHttpMethod[];
  customRpm: number | null;
  expiresAt: string | null;
  entitlementRevision?: number;
  grantSource?: GrantSource;
}

export interface EpicSessionUser {
  epicAccountId: string;
  displayName: string;
  avatarUrl: string;
  preferredLanguage?: string;
  email?: string;
}

export interface DashboardProject {
  id: string;
  ownerEpicId: string;
  name: string;
  slug: string;
  description: string;
  websiteUrl: string;
  tier: ApiKeyTier;
  customRpm: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardApiKey {
  id: string;
  projectId: string;
  ownerEpicId: string;
  name: string;
  keyPrefix: string;
  tier: ApiKeyTier;
  active: boolean;
  scopes: ApiScope[];
  allowedIps: string[];
  allowedOrigins: string[];
  allowedPaths: string[];
  allowedMethods: AllowedHttpMethod[];
  customRpm: number | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LimitIncreaseRequestRecord {
  id: string;
  ownerEpicId: string;
  projectId: string;
  projectName?: string;
  ownerDisplayName?: string;
  contactEmail: string;
  requestedTier: "pro" | "scale" | "enterprise" | "custom";
  requestedRpm: number;
  expectedMonthlyRequests: number;
  useCase: string;
  websiteUrl: string;
  status: "pending" | "approved" | "declined";
  emailDeliveryStatus: string;
  createdAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string;
}

export interface AccountMonthlyQuotaStatus {
  used: number;
  remaining: number;
  allowance: number;
  monthStart: string;
  resetAt: string;
  status: "ok" | "warning" | "critical" | "exhausted";
}

export interface DashboardEnv
  extends Omit<
    Env,
    "EPIC_CLIENT_ID" | "EPIC_CLIENT_SECRET" | "ENABLE_DEV_AUTH"
  > {
  EPIC_CLIENT_ID?: string;
  EPIC_CLIENT_SECRET?: string;
  DASHBOARD_SESSION_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_API_TOKEN?: string;
  ANTI_ABUSE_EDGE_SECRET?: string;
  ORIGIN_AUTH_TOKEN?: string;
  ENABLE_DEV_AUTH?: string;
  /** One SQLite-backed quota object per environment and account ID. Binding name retained for deployment compatibility. */
  API_KEY_RATE_LIMITER: DurableObjectNamespace<
    import("./rate-limiter.js").ApiKeyRateLimiter
  >;
  /** Prevents counter sharing between independently deployed environments. */
  RATE_LIMIT_ENVIRONMENT: string;
  CHANGELOG_INGEST_TOKEN?: string;
  FIRST_PARTY_SERVICE_TOKEN?: string;
  COMMERCIAL_PLAN_LIMITS_ENABLED?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID_PRO?: string;
  STRIPE_PRICE_ID_SCALE?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string;
  STRIPE_MODE?: string;
}
