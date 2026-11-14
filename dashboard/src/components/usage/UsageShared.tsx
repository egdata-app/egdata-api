import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Info,
  Lightbulb,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type {
  AnalyticsDashboardSummary,
  UsageFilters,
  UsageMetrics,
  UsageRow,
} from "../../lib/api";
import { useDashboardAuth } from "../../lib/auth-context";
import { comparison, type UsageInsight } from "../../lib/usage";
import { Button, buttonStyles } from "../ui/Button";
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
  const hitMissSub =
    (t.avgHitLatencyMs ?? 0) > 0 || (t.avgMissLatencyMs ?? 0) > 0
      ? `HIT ${t.avgHitLatencyMs ?? 0} ms · MISS ${t.avgMissLatencyMs ?? 0} ms`
      : comparison(t.avgLatencyMs, p?.avgLatencyMs);
  const statusSplitSub =
    (t.status5xx ?? 0) > 0 || (t.status4xx ?? 0) > 0
      ? `${t.errors.toLocaleString()} total (${t.status4xx ?? 0} 4xx · ${t.status5xx ?? 0} 5xx)`
      : comparison(t.errorRate, p?.errorRate, true);
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
        sub={
          t.cacheHits > 0
            ? `${t.cacheHits.toLocaleString()} hits · ${comparison(t.cacheHitRate, p?.cacheHitRate, true)}`
            : comparison(t.cacheHitRate, p?.cacheHitRate, true)
        }
      />
      <Metric
        label="Error rate · 4xx + 5xx"
        value={`${t.errorRate}%`}
        color={t.errors ? "text-epic-danger" : "text-white"}
        sub={statusSplitSub}
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
        sub={hitMissSub}
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
        sub={`p50 ${t.p50LatencyMs} ms · tail latency`}
      />
      <Metric
        label="Policy denied"
        value={t.blockedPolicy.toLocaleString()}
        color="text-epic-warning"
        sub={
          t.avgResponseBytes && t.avgResponseBytes > 0
            ? `Avg payload ${(t.avgResponseBytes / 1024).toFixed(1)} KB`
            : "Key, IP, origin, method, path or scope checks"
        }
      />
    </div>
  );
}

export function UsageInsightsPanel({ insights }: { insights: UsageInsight[] }) {
  if (!insights.length) return null;
  const toneStyles: Record<UsageInsight["tone"], string> = {
    danger: "border-epic-danger/35 bg-epic-danger/10 text-epic-danger",
    warning: "border-epic-warning/35 bg-epic-warning/10 text-epic-warning",
    info: "border-epic-accent/30 bg-epic-accent-muted/40 text-epic-accent",
    success: "border-epic-success/30 bg-epic-success/10 text-epic-success",
  };
  return (
    <section aria-label="Developer insights" className="space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-epic-text-muted">
        <Lightbulb className="w-3.5 h-3.5 text-epic-accent" aria-hidden="true" />
        Actionable Insights
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        {insights.map((insight) => (
          <div
            key={insight.id}
            className={`rounded-xl border p-4 flex items-start justify-between gap-3 ${toneStyles[insight.tone]}`}
          >
            <div className="flex items-start gap-2.5 min-w-0">
              {insight.tone === "info" ? (
                <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              ) : (
                <AlertTriangle
                  className="w-4 h-4 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white">
                  {insight.title}
                </div>
                <p className="text-xs text-epic-text-muted mt-1 leading-relaxed">
                  {insight.detail}
                </p>
              </div>
            </div>
            {insight.actionLabel && insight.actionTo && (
              <Link
                to={insight.actionTo}
                className={`${buttonStyles({ variant: "secondary", size: "sm" })} shrink-0`}
              >
                {insight.actionLabel}
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export const outcomeLabels: Record<string, string> = {
  ok: "Allowed",
  missing_api_key: "API key missing",
  invalid_api_key: "API key invalid or revoked",
  rate_limited: "Request limit reached",
  monthly_quota_exceeded: "Monthly free quota reached",
  period_quota_exceeded: "Period or daily allowance reached",
  expensive_budget_exceeded: "Expensive operation budget reached",
  entitlement_denied: "Plan entitlement required",
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
  onSelect,
}: {
  title: string;
  items: {
    key?: string;
    label: string;
    count: number;
    color: string;
    active?: boolean;
  }[];
  total: number;
  onSelect?: (key: string) => void;
}) {
  return (
    <section className={panel}>
      <div className="flex items-center justify-between gap-2 mb-4">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {onSelect && items.length > 0 && (
          <span className="text-[10px] text-epic-text-muted">Click to filter</span>
        )}
      </div>
      <div className="space-y-2.5">
        {!items.length && (
          <p className="text-xs text-epic-text-muted">
            No activity in this period.
          </p>
        )}
        {items.map((item) => {
          const content = (
            <>
              <div className="flex justify-between gap-3 text-xs mb-1.5">
                <span className={item.active ? "text-epic-accent font-semibold" : ""}>
                  {item.label}
                </span>
                <span className="text-epic-text-muted tabular-nums">
                  {item.count.toLocaleString()} ·{" "}
                  {total ? ((item.count / total) * 100).toFixed(1) : 0}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-epic-bg overflow-hidden">
                <div
                  className={`h-full rounded-full ${item.color}`}
                  style={{
                    width: `${total ? Math.min(100, (item.count / total) * 100) : 0}%`,
                  }}
                />
              </div>
            </>
          );
          const itemKey = item.key;
          if (onSelect && itemKey) {
            return (
              <button
                key={itemKey}
                type="button"
                onClick={() => onSelect(itemKey)}
                aria-pressed={Boolean(item.active)}
                className={`w-full text-left rounded-lg px-2 py-1 -mx-2 transition cursor-pointer ${
                  item.active
                    ? "bg-epic-accent-muted/60 ring-1 ring-epic-accent/40"
                    : "hover:bg-epic-elevated/60"
                }`}
              >
                {content}
              </button>
            );
          }
          return (
            <div key={item.key ?? item.label} className="py-0.5">
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}
export function UsageBreakdowns({
  data,
  activeFilters,
  onToggleFilter,
}: {
  data: AnalyticsDashboardSummary;
  activeFilters?: Pick<
    UsageFilters,
    | "statusCode"
    | "cacheStatus"
    | "limitOutcome"
    | "country"
    | "clientCategory"
    | "policyFamily"
  >;
  onToggleFilter?: (
    key:
      | "statusCode"
      | "cacheStatus"
      | "limitOutcome"
      | "country"
      | "clientCategory"
      | "policyFamily",
    value: string,
  ) => void;
}) {
  const hasSecondary =
    (data.countryBreakdown && data.countryBreakdown.length > 0) ||
    (data.clientBreakdown && data.clientBreakdown.length > 0) ||
    (data.policyBreakdown && data.policyBreakdown.length > 0);
  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-3 gap-4">
        <Breakdown
          title="Response statuses"
          total={data.totals.requests}
          onSelect={
            onToggleFilter
              ? (val) => onToggleFilter("statusCode", val)
              : undefined
          }
          items={data.statusCodes.map((r) => ({
            key: r.status,
            label: `HTTP ${r.status}`,
            count: r.requests,
            active: activeFilters?.statusCode === r.status,
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
          onSelect={
            onToggleFilter
              ? (val) => onToggleFilter("cacheStatus", val)
              : undefined
          }
          items={data.cacheBreakdown.map((r) => ({
            key: r.status,
            label: cacheLabels[r.status] ?? r.status,
            count: r.requests,
            active: activeFilters?.cacheStatus === r.status,
            color:
              r.status === "EDGE_BLOCK" ? "bg-epic-warning" : "bg-epic-accent",
          }))}
        />
        <Breakdown
          title="Access checks"
          total={data.totals.requests}
          onSelect={
            onToggleFilter
              ? (val) => onToggleFilter("limitOutcome", val)
              : undefined
          }
          items={data.limitOutcomes.map((r) => ({
            key: r.outcome,
            label: outcomeLabels[r.outcome] ?? r.outcome,
            count: r.requests,
            active: activeFilters?.limitOutcome === r.outcome,
            color: r.outcome === "ok" ? "bg-epic-success" : "bg-epic-warning",
          }))}
        />
      </div>
      {hasSecondary && (
        <div className="grid md:grid-cols-3 gap-4">
          <Breakdown
            title="Top countries"
            total={data.totals.requests}
            onSelect={
              onToggleFilter
                ? (val) => onToggleFilter("country", val)
                : undefined
            }
            items={(data.countryBreakdown ?? []).map((r) => ({
              key: r.country,
              label: r.country === "XX" ? "Unknown / Local" : r.country,
              count: r.requests,
              active: activeFilters?.country === r.country,
              color: "bg-epic-accent",
            }))}
          />
          <Breakdown
            title="Client categories"
            total={data.totals.requests}
            onSelect={
              onToggleFilter
                ? (val) => onToggleFilter("clientCategory", val)
                : undefined
            }
            items={(data.clientBreakdown ?? []).map((r) => ({
              key: r.category,
              label: r.category,
              count: r.requests,
              active: activeFilters?.clientCategory === r.category,
              color: "bg-epic-accent",
            }))}
          />
          <Breakdown
            title="Policy & budget families"
            total={data.totals.requests}
            onSelect={
              onToggleFilter
                ? (val) => onToggleFilter("policyFamily", val)
                : undefined
            }
            items={(data.policyBreakdown ?? []).map((r) => ({
              key: r.policy,
              label: r.policy,
              count: r.requests,
              active: activeFilters?.policyFamily === r.policy,
              color: "bg-epic-warning",
            }))}
          />
        </div>
      )}
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
  metric?: keyof Pick<
    UsageMetrics,
    "requests" | "rateLimited" | "errors" | "p95LatencyMs"
  >;
  onSelect: (row: UsageRow) => void;
  empty?: string;
  action?: ReactNode;
}) {
  const unitLabel =
    metric === "rateLimited"
      ? "429s"
      : metric === "errors"
        ? "errors"
        : metric === "p95LatencyMs"
          ? "p95 ms"
          : "requests";
  const valueTone =
    metric === "rateLimited"
      ? "text-epic-warning"
      : metric === "errors"
        ? "text-epic-danger"
        : "text-epic-accent";
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
                  ? `${row.requests.toLocaleString()} req · ${row.cacheHitRate}% cache`
                  : row.detail}
              </span>
            </span>
            <span className={`tabular-nums ${valueTone}`}>
              {row[metric].toLocaleString()}
              <span className="block text-[10px] font-normal text-epic-text-muted">
                {unitLabel}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}
