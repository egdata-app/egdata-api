export interface UsageMetrics {
  requests: number;
  cacheHits: number;
  cacheHitRate: number;
  rateLimited: number;
  blockedPolicy: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export type UsageDimension =
  | "endpoints"
  | "projects"
  | "keys"
  | "origins"
  | "ips"
  | "userAgents";
export type UsageSort =
  | "requests"
  | "cacheHitRate"
  | "rateLimited"
  | "blockedPolicy"
  | "errorRate"
  | "avgLatencyMs"
  | "p95LatencyMs";
export interface UsageRow extends UsageMetrics {
  id: string;
  label: string;
  detail: string;
  route?: string;
  method?: string;
  projectId?: string;
  keyId?: string;
}
export interface UsageFilters {
  hours: number;
  scope?: "project" | "all";
  projectId?: string;
  keyId?: string;
  route?: string;
  method?: string;
  /** Fixed end time keeps comparisons and table pages on the same window. */
  end?: string;
}
export interface UsageTableFilters extends UsageFilters {
  dimension?: UsageDimension;
  search?: string;
  sort?: UsageSort;
  direction?: "asc" | "desc";
  offset?: number;
  limit?: number;
}
export interface UsageTableResult {
  rows: UsageRow[];
  hasMore: boolean;
  offset: number;
  end: string;
  source: "cloudflare_analytics_engine" | "local_buffer";
}
export interface AnalyticsDashboardSummary {
  source: UsageTableResult["source"];
  scope: "project" | "all";
  rangeHours: number;
  start: string;
  end: string;
  bucketMinutes: number;
  totals: UsageMetrics;
  previous: UsageMetrics | null;
  timeseries: Array<UsageMetrics & { bucket: string }>;
  endpoints: UsageRow[];
  projects: UsageRow[];
  keys: UsageRow[];
  cacheBreakdown: Array<{ status: string; requests: number }>;
  limitOutcomes: Array<{ outcome: string; requests: number }>;
  statusCodes: Array<{ status: string; requests: number }>;
}
