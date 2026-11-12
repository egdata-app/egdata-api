import { RefreshCw, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type {
  AnalyticsDashboardSummary,
  UsageMetrics,
  UsageRow,
} from "../../lib/api";
import { useDashboardAuth } from "../../lib/auth-context";
import { comparison } from "../../lib/usage";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Controls";
import { Select, SelectItem } from "../ui/Select";

export const panel =
  "min-w-0 bg-epic-surface border border-epic-border rounded-xl p-5";
export function ScopeSelector() {
  const { isAdmin, analyticsScope, setAnalyticsScope } = useDashboardAuth();
  if (!isAdmin) return null;
  return (
    <div className="flex items-center gap-2">
      <ShieldCheck className="w-4 h-4 text-epic-accent" aria-hidden="true" />
      <Select
        aria-label="Analytics scope"
        selectedKey={analyticsScope}
        onSelectionChange={(key) =>
          setAnalyticsScope(key === "all" ? "all" : "project")
        }
        className="w-44"
      >
        <SelectItem id="project">Current project</SelectItem>
        <SelectItem id="all">All traffic</SelectItem>
      </Select>
    </div>
  );
}
export function UsageLoading() {
  return (
    <div className="space-y-6">
      <output className="sr-only">Loading usage…</output>
      <span className="sr-only">Loading usage…</span>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`${panel} h-24 motion-safe:animate-pulse bg-epic-elevated`}
          />
        ))}
      </div>
      <div
        className={`${panel} h-72 motion-safe:animate-pulse bg-epic-elevated`}
      />
    </div>
  );
}
export function UsageError({
  message,
  retry,
  stale = false,
}: {
  message?: string;
  retry: () => void;
  stale?: boolean;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-epic-danger/30 bg-epic-surface p-4 flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      <p>
        {message}
        {stale && " Showing the last successful result."}
      </p>
      <Button variant="secondary" onPress={retry}>
        Retry
      </Button>
    </div>
  );
}
export function Freshness({
  updatedAt,
  loading,
  onRefresh,
}: {
  updatedAt?: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = updatedAt
    ? Math.max(0, Math.floor((now - updatedAt) / 1000))
    : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-epic-text-muted">
        {updatedAt
          ? seconds < 60
            ? "Updated just now"
            : `Updated ${Math.floor(seconds / 60)}m ago`
          : "Awaiting usage"}
      </span>
      <Button variant="secondary" isDisabled={loading} onPress={onRefresh}>
        <RefreshCw
          className={`w-4 h-4 ${loading ? "motion-safe:animate-spin" : ""}`}
        />
        Refresh
      </Button>
    </div>
  );
}
export function Coverage({ data }: { data: AnalyticsDashboardSummary }) {
  return (
    <p className="text-xs text-epic-text-muted leading-relaxed">
      {data.source === "local_buffer" ? (
        <>
          <Tag tone="warning">Recent activity only</Tag> History is incomplete.
          Empty intervals and previous-period comparisons are unavailable.
        </>
      ) : (
        <>
          Recorded gateway traffic · Counts and percentiles may be estimated
          from sampled events.
        </>
      )}{" "}
      {data.scope === "all" && "Administrator view."} Processing time includes
      gateway checks; it is not client round-trip time.
    </p>
  );
}
export function Metric({
  label,
  value,
  sub,
  color = "text-white",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className={`${panel} px-4 py-3.5`}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-epic-text-muted">
        {label}
      </div>
      <div className={`text-xl font-bold tracking-tight mt-1 ${color}`}>
        {value}
      </div>
      {sub && <p className="text-[11px] text-epic-text-muted mt-1.5">{sub}</p>}
    </div>
  );
}
export function UsageMetricsStrip({
  data,
}: {
  data: AnalyticsDashboardSummary;
}) {
  const { totals: t, previous: p } = data;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
      <Metric
        label="Total requests"
        value={t.requests.toLocaleString()}
        sub={comparison(t.requests, p?.requests)}
      />
      <Metric
        label="Cache hit rate"
        value={`${t.cacheHitRate}%`}
        color="text-epic-success"
        sub={comparison(t.cacheHitRate, p?.cacheHitRate, true)}
      />
      <Metric
        label="Error rate · 4xx + 5xx"
        value={`${t.errorRate}%`}
        color={t.errors ? "text-epic-danger" : "text-white"}
        sub={comparison(t.errorRate, p?.errorRate, true)}
      />
      <Metric
        label="Rate limited · 429"
        value={t.rateLimited.toLocaleString()}
        color="text-epic-warning"
        sub={comparison(t.rateLimited, p?.rateLimited)}
      />
      <Metric
        label="Average processing time"
        value={`${t.avgLatencyMs} ms`}
        color="text-epic-accent"
        sub={comparison(t.avgLatencyMs, p?.avgLatencyMs)}
      />
      <Metric
        label="p95 processing time"
        value={`${t.p95LatencyMs} ms`}
        color="text-epic-accent"
        sub={comparison(t.p95LatencyMs, p?.p95LatencyMs)}
      />
      <Metric
        label="p99 processing time"
        value={`${t.p99LatencyMs} ms`}
        sub={`p50 ${t.p50LatencyMs} ms · percentiles across requests`}
      />
      <Metric
        label="Policy denied"
        value={t.blockedPolicy.toLocaleString()}
        color="text-epic-warning"
        sub="Key, IP, origin, method, path or scope checks"
      />
    </div>
  );
}
export const outcomeLabels: Record<string, string> = {
  ok: "Allowed",
  missing_api_key: "API key missing",
  invalid_api_key: "API key invalid or revoked",
  rate_limited: "Request limit reached",
  monthly_quota_exceeded: "Monthly free quota reached",
  key_inactive: "Key paused or revoked",
  key_expired: "Key expired",
  ip_denied: "IP not allowed",
  origin_denied: "Origin not allowed",
  method_denied: "Method not allowed",
  path_denied: "Endpoint not allowed",
  scope_denied: "Permission missing",
};
const cacheLabels: Record<string, string> = {
  HIT: "Cache hit",
  MISS: "Cache miss",
  EXPIRED: "Expired",
  STALE: "Stale response",
  UPDATING: "Refreshing",
  REVALIDATED: "Revalidated",
  BYPASS: "Bypassed",
  DYNAMIC: "Not cached",
  EDGE_BLOCK: "Blocked at gateway",
};
export function Breakdown({
  title,
  items,
  total,
}: {
  title: string;
  items: { label: string; count: number; color: string }[];
  total: number;
}) {
  return (
    <section className={panel}>
      <h2 className="text-sm font-semibold text-white mb-4">{title}</h2>
      <div className="space-y-3">
        {!items.length && (
          <p className="text-xs text-epic-text-muted">
            No activity in this period.
          </p>
        )}
        {items.map((item) => (
          <div key={item.label}>
            <div className="flex justify-between gap-3 text-xs mb-1.5">
              <span>{item.label}</span>
              <span className="text-epic-text-muted tabular-nums">
                {item.count.toLocaleString()} ·{" "}
                {total ? ((item.count / total) * 100).toFixed(1) : 0}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-epic-bg overflow-hidden">
              <div
                className={`h-full rounded-full ${item.color}`}
                style={{ width: `${total ? (item.count / total) * 100 : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
export function UsageBreakdowns({ data }: { data: AnalyticsDashboardSummary }) {
  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Breakdown
        title="Response statuses"
        total={data.totals.requests}
        items={data.statusCodes.map((r) => ({
          label: `HTTP ${r.status}`,
          count: r.requests,
          color:
            Number(r.status) >= 500
              ? "bg-epic-danger"
              : Number(r.status) >= 400
                ? "bg-epic-warning"
                : "bg-epic-success",
        }))}
      />
      <Breakdown
        title="Cache results"
        total={data.totals.requests}
        items={data.cacheBreakdown.map((r) => ({
          label: cacheLabels[r.status] ?? r.status,
          count: r.requests,
          color:
            r.status === "EDGE_BLOCK" ? "bg-epic-warning" : "bg-epic-accent",
        }))}
      />
      <Breakdown
        title="Access checks"
        total={data.totals.requests}
        items={data.limitOutcomes.map((r) => ({
          label: outcomeLabels[r.outcome] ?? r.outcome,
          count: r.requests,
          color: r.outcome === "ok" ? "bg-epic-success" : "bg-epic-warning",
        }))}
      />
    </div>
  );
}
export function RankedList({
  title,
  rows,
  metric = "requests",
  onSelect,
  empty,
  action,
}: {
  title: string;
  rows: UsageRow[];
  metric?: keyof Pick<UsageMetrics, "requests" | "rateLimited">;
  onSelect: (row: UsageRow) => void;
  empty?: string;
  action?: ReactNode;
}) {
  return (
    <section className={panel}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {action}
      </div>
      <div className="space-y-2">
        {!rows.length && (
          <p className="text-xs text-epic-text-muted">
            {empty ?? "No recorded activity."}
          </p>
        )}
        {rows.map((row) => (
          <Button
            key={row.id}
            variant="quiet"
            className="w-full !justify-between !px-2"
            onPress={() => onSelect(row)}
          >
            <span className="min-w-0 text-left">
              <span className="block truncate max-w-64">
                {row.method} {row.label}
              </span>
              <span className="block text-[11px] font-normal text-epic-text-muted truncate max-w-64">
                {row.method
                  ? `${row.requests.toLocaleString()} requests`
                  : row.detail}
              </span>
            </span>
            <span
              className={`tabular-nums ${metric === "rateLimited" ? "text-epic-warning" : "text-epic-accent"}`}
            >
              {row[metric].toLocaleString()}
              <span className="block text-[10px] font-normal text-epic-text-muted">
                {metric === "rateLimited" ? "429s" : "requests"}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}
