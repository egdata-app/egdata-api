import { useEffect, useState } from "react";
import {
  type AnalyticsDashboardSummary,
  dashboardClient,
  type UsageFilters,
  type UsageRow,
  type UsageTableFilters,
  type UsageTableResult,
} from "./api";

export function useUsageResource<T>(
  params: UsageTableFilters | null,
  table: boolean,
  autoRefresh = false,
): {
  data?: T;
  error?: string;
  loading: boolean;
  updatedAt?: number;
  refreshKey: number;
  refresh: () => void;
} {
  const key = JSON.stringify(params);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: string;
    loading: boolean;
    updatedAt?: number;
  }>({ key, loading: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision triggers manual and scheduled refreshes.
  useEffect(() => {
    const requestParams = JSON.parse(key) as UsageTableFilters | null;
    if (!requestParams) return;
    const controller = new AbortController();
    setState((prev) => ({
      ...(prev.key === key ? prev : {}),
      key,
      loading: true,
      error: undefined,
    }));
    const request = table
      ? dashboardClient.getUsageTable(requestParams, controller.signal)
      : dashboardClient.getAnalytics(requestParams, controller.signal);
    void request
      .then((data) => {
        if (!controller.signal.aborted)
          setState({
            key,
            data: data as T,
            loading: false,
            updatedAt: Date.now(),
          });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted)
          setState((prev) => ({
            ...prev,
            key,
            loading: false,
            error: error.message,
          }));
      });
    return () => controller.abort();
  }, [key, revision, table]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") setRevision((r) => r + 1);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh]);
  return {
    ...(state.key === key && params ? state : { loading: Boolean(params) }),
    refreshKey: revision,
    refresh: () => setRevision((r) => r + 1),
  };
}
export function useUsage(params: UsageFilters | null, autoRefresh = false) {
  return useUsageResource<AnalyticsDashboardSummary>(
    params,
    false,
    autoRefresh,
  );
}
export function useUsageTable(params: UsageTableFilters | null) {
  return useUsageResource<UsageTableResult>(params, true);
}

export function usageCsv(rows: UsageRow[]) {
  const cell = (value: string | number) => {
    // Quoting alone does not prevent spreadsheet formula execution.
    const raw = String(value);
    const text = /^[\s]*[=+@-]|^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [
    [
      "Name",
      "Detail",
      "Project ID",
      "Key ID",
      "Method",
      "Operation ID",
      "Expensive policy",
      "Requests",
      "Cache hit %",
      "Errors",
      "Error %",
      "429s",
      "Policy denied",
      "Average ms",
      "p50 ms",
      "p95 ms",
      "p99 ms",
      "Avg payload bytes",
    ],
    ...rows.map((row) => [
      row.label,
      row.detail,
      row.projectId ?? "",
      row.keyId ?? "",
      row.method ?? "",
      row.operationId ?? "",
      row.expensive ?? "",
      row.requests,
      row.cacheHitRate,
      row.errors,
      row.errorRate,
      row.rateLimited,
      row.blockedPolicy,
      row.avgLatencyMs,
      row.p50LatencyMs,
      row.p95LatencyMs,
      row.p99LatencyMs,
      row.avgResponseBytes ?? 0,
    ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\r\n");
}

export interface UsageInsight {
  id: string;
  tone: "warning" | "danger" | "info" | "success";
  title: string;
  detail: string;
  actionLabel?: string;
  actionTo?: "/keys" | "/limits" | "/alerts";
}

export function deriveUsageInsights(
  data: AnalyticsDashboardSummary,
  options?: {
    rpmLimit?: number;
    monthlyUsed?: number;
    monthlyAllowance?: number;
    monthlyResetAt?: string;
  },
): UsageInsight[] {
  const insights: UsageInsight[] = [];
  const t = data.totals;
  if (t.requests === 0) return insights;

  // 1. Burst throttling vs sustained RPM saturation
  if (t.rateLimited > 0 && options?.rpmLimit && data.timeseries.length > 0) {
    const peakBucket = Math.max(...data.timeseries.map((p) => p.requests));
    const avgBucketRpm =
      t.requests / Math.max(1, data.rangeHours * 60);
    const peakRpm = peakBucket / Math.max(1, data.bucketMinutes);
    if (avgBucketRpm < options.rpmLimit * 0.4) {
      insights.push({
        id: "burst-rate-limit",
        tone: "warning",
        title: `${t.rateLimited.toLocaleString()} requests throttled by burst spikes`,
        detail: `Average pace is ~${avgBucketRpm.toFixed(1)} req/min (peak ~${peakRpm.toFixed(0)} req/min vs ${options.rpmLimit.toLocaleString()} req/min cap). Client-side pacing, retries with backoff, or caching hot GETs can eliminate 429s without upgrading.`,
        actionLabel: "Review limits",
        actionTo: "/limits",
      });
    } else {
      insights.push({
        id: "sustained-rate-limit",
        tone: "danger",
        title: `${t.rateLimited.toLocaleString()} requests hit rate or quota limits`,
        detail: `Sustained throughput is approaching your ${options.rpmLimit.toLocaleString()} req/min allowance.`,
        actionLabel: "Increase limits",
        actionTo: "/limits",
      });
    }
  }

  // 2. Policy denials pointing to key allowlist / scope misconfiguration
  if (t.blockedPolicy > 0) {
    const topDenied = data.limitOutcomes.find(
      (o) =>
        o.outcome !== "ok" &&
        o.outcome !== "rate_limited" &&
        o.outcome !== "monthly_quota_exceeded" &&
        o.outcome !== "period_quota_exceeded" &&
        o.outcome !== "expensive_budget_exceeded",
    );
    insights.push({
      id: "policy-denied",
      tone: "warning",
      title: `${t.blockedPolicy.toLocaleString()} requests blocked by key policy`,
      detail: topDenied
        ? `Most common reason: ${topDenied.outcome.replaceAll("_", " ")} (${topDenied.requests.toLocaleString()} requests). Check API key scopes, IP/origin allowlists, or expiry.`
        : "Check API key scopes, IP/origin allowlists, or method restrictions.",
      actionLabel: "Inspect API keys",
      actionTo: "/keys",
    });
  }

  // 3. Monthly / period quota burn projection
  if (
    options?.monthlyAllowance &&
    options.monthlyUsed !== undefined &&
    options.monthlyResetAt &&
    data.rangeHours >= 6
  ) {
    const remaining = Math.max(0, options.monthlyAllowance - options.monthlyUsed);
    const dailyBurn = (t.requests / data.rangeHours) * 24;
    const msUntilReset = Date.parse(options.monthlyResetAt) - Date.now();
    const daysUntilReset = Math.max(0, msUntilReset / 86_400_000);
    if (dailyBurn > 0 && remaining > 0) {
      const daysUntilExhausted = remaining / dailyBurn;
      if (daysUntilExhausted < daysUntilReset) {
        insights.push({
          id: "quota-burn",
          tone: daysUntilExhausted < 3 ? "danger" : "warning",
          title: `Projected quota exhaustion in ~${daysUntilExhausted.toFixed(1)} days`,
          detail: `At ~${Math.round(dailyBurn).toLocaleString()} req/day, the remaining ${remaining.toLocaleString()} requests would run out before reset on ${options.monthlyResetAt.slice(0, 10)}.`,
          actionLabel: "Plan & billing",
          actionTo: "/limits",
        });
      }
    }
  }

  // 4. High-volume endpoints with low cache hit rate
  const uncachedHot = (data.busiestEndpoints ?? data.endpoints).find(
    (ep) =>
      (ep.method === "GET" || ep.method === "HEAD") &&
      ep.requests >= 20 &&
      ep.cacheHitRate < 25,
  );
  if (uncachedHot) {
    insights.push({
      id: "low-cache-hit",
      tone: "info",
      title: `Low cache hit rate (${uncachedHot.cacheHitRate}%) on ${uncachedHot.method} ${uncachedHot.route}`,
      detail: `${uncachedHot.requests.toLocaleString()} requests had ${uncachedHot.cacheHitRate}% edge cache hits. Sending consistent query parameters and conditional If-None-Match / ETag headers can cut origin latency.`,
    });
  }

  // 5. 5xx server/upstream errors
  if ((t.status5xx ?? 0) > 0) {
    insights.push({
      id: "server-errors",
      tone: "danger",
      title: `${(t.status5xx ?? 0).toLocaleString()} upstream 5xx responses detected`,
      detail: `Check endpoint alerts and retry transient 502/503 responses with exponential backoff.`,
      actionLabel: "View alerts",
      actionTo: "/alerts",
    });
  }

  // 6. Latency gap between edge HITs and origin MISSes
  const hitMs = t.avgHitLatencyMs ?? 0;
  const missMs = t.avgMissLatencyMs ?? 0;
  if (hitMs > 0 && missMs > hitMs * 5 && missMs > 120) {
    insights.push({
      id: "cache-latency-gap",
      tone: "info",
      title: `Origin misses are ${(missMs / Math.max(1, hitMs)).toFixed(0)}x slower than edge cache hits`,
      detail: `Edge hits average ${hitMs} ms vs ${missMs} ms on origin misses (overall p95 ${t.p95LatencyMs} ms).`,
    });
  }

  return insights.slice(0, 4);
}

export function comparison(
  current: number,
  previous: number | undefined,
  percentagePoints = false,
) {
  if (previous === undefined) return "Comparison unavailable";
  const delta = current - previous;
  if (percentagePoints)
    return `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pp vs previous period`;
  if (previous === 0)
    return current === 0
      ? "No change vs previous period"
      : "New activity vs previous period";
  const percent = (delta / previous) * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}% vs previous period`;
}
