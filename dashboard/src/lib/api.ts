import type { AnalyticsDashboardSummary } from "../../worker/analytics";
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

  getAnalytics: (params: {
    hours: number;
    projectId?: string;
    keyId?: string;
  }) => {
    const qs = new URLSearchParams({ hours: String(params.hours) });
    if (params.projectId) qs.set("projectId", params.projectId);
    if (params.keyId) qs.set("keyId", params.keyId);
    return apiFetch<AnalyticsDashboardSummary>(`/analytics?${qs.toString()}`);
  },

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
