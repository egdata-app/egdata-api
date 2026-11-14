// Reserved telemetry identity, never a real Epic account, project, or API key.
export const UNATTRIBUTED_LEGACY_ID = "__legacy_unattributed__";

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
  cacheMisses?: number;
  status2xx?: number;
  status3xx?: number;
  status4xx?: number;
  status5xx?: number;
  avgHitLatencyMs?: number;
  avgMissLatencyMs?: number;
  avgUpstreamLatencyMs?: number;
  avgResponseBytes?: number;
}

export type UsageDimension =
  | "endpoints"
  | "projects"
  | "keys"
  | "origins"
  | "ips"
  | "userAgents"
  | "statusCodes"
  | "limitOutcomes"
  | "cacheStatuses"
  | "policies";
export type UsageSort =
  | "requests"
  | "cacheHitRate"
  | "errors"
  | "errorRate"
  | "rateLimited"
  | "blockedPolicy"
  | "avgLatencyMs"
  | "p50LatencyMs"
  | "p95LatencyMs"
  | "p99LatencyMs"
  | "label";
export interface UsageRow extends UsageMetrics {
  id: string;
  label: string;
  detail: string;
  route?: string;
  method?: string;
  projectId?: string;
  keyId?: string;
  operationId?: string;
  scope?: string;
  expensive?: string;
}
export type StatusClassFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx";
export interface UsageFilters {
  hours: number;
  scope?: "project" | "all";
  apiVersion?: "all" | "legacy" | "v1";
  projectId?: string;
  keyId?: string;
  route?: string;
  method?: string;
  statusClass?: StatusClassFilter;
  statusCode?: string;
  limitOutcome?: string;
  cacheStatus?: string;
  country?: string;
  clientCategory?: string;
  originPresence?: "present" | "direct";
  policyFamily?: string;
  excludeConsole?: boolean;
  /** Optional explicit start/end keep zoomed windows, comparisons, and table pages aligned. */
  start?: string;
  end?: string;
}
export interface UsageTableFilters extends UsageFilters {
  dimension?: UsageDimension;
  search?: string;
  minRequests?: number;
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
  previousTimeseries?: Array<{
    bucket: string;
    requests: number;
    errors: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  }>;
  quotaTimeseries?: Array<{ bucket: string; requests: number }>;
  latencyDistribution?: Array<{ label: string; requests: number }>;
  endpoints: UsageRow[];
  busiestEndpoints?: UsageRow[];
  slowestEndpoints?: UsageRow[];
  errorEndpoints?: UsageRow[];
  projects: UsageRow[];
  keys: UsageRow[];
  busiestKeys?: UsageRow[];
  cacheBreakdown: Array<{ status: string; requests: number }>;
  limitOutcomes: Array<{ outcome: string; requests: number }>;
  statusCodes: Array<{ status: string; requests: number }>;
  countryBreakdown?: Array<{ country: string; requests: number }>;
  clientBreakdown?: Array<{ category: string; requests: number }>;
  policyBreakdown?: Array<{ policy: string; requests: number }>;
}
