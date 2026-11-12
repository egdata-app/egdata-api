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
    ],
    ...rows.map((row) => [
      row.label,
      row.detail,
      row.projectId ?? "",
      row.keyId ?? "",
      row.method ?? "",
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
    ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\r\n");
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
