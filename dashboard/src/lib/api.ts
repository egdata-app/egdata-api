import type {
  AdminAuditEntry,
  AdminPage,
  AdminProject,
  AdminUser,
} from "../../worker/admin-types";
import type { AnalyticsDashboardSummary } from "../../worker/analytics";
import type {
  UsageFilters,
  UsageTableFilters,
  UsageTableResult,
} from "../../worker/analytics-types";

export type {
  UsageDimension,
  UsageFilters,
  UsageMetrics,
  UsageRow,
  UsageSort,
  UsageTableFilters,
  UsageTableResult,
} from "../../worker/analytics-types";

import type {
  AllowedHttpMethod,
  ApiScope,
  DashboardApiKey,
  DashboardProject,
  EpicSessionUser,
  LimitIncreaseRequestRecord,
} from "../../worker/types";

export type {
  AllowedHttpMethod,
  AnalyticsDashboardSummary,
  ApiScope,
  DashboardApiKey,
  DashboardProject,
  EpicSessionUser,
  LimitIncreaseRequestRecord,
};

export interface SessionResponse {
  authenticated: boolean;
  isAdmin: boolean;
  user: EpicSessionUser | null;
  projects: DashboardProject[];
  oauthConfigured: boolean;
  devAuthAvailable: boolean;
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
    throw new Error(data?.error?.message || `Request failed (${res.status})`);
  }

  return data;
}

export const dashboardClient = {
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
    requestedTier: "pro" | "enterprise" | "custom";
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
};
