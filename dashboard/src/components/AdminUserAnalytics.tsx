import { useEffect, useState } from "react";
import type { AdminUserAnalyticsRange } from "../../worker/admin-types";
import { type AnalyticsDashboardSummary, dashboardClient } from "../lib/api";
import { Select, SelectItem } from "./ui/Select";
import { UsageChart } from "./usage/UsageCharts";
import {
  Coverage,
  Metric,
  UsageError,
  UsageLoading,
} from "./usage/UsageShared";

export function AdminUserAnalytics({
  userId,
  monthlyLimit = null,
  refreshKey,
}: {
  userId: string;
  monthlyLimit?: number | null;
  refreshKey: number;
}) {
  const [range, setRange] = useState<AdminUserAnalyticsRange>("month");
  const [data, setData] = useState<AnalyticsDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and retry trigger fresh analytics reads.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    void dashboardClient
      .getAdminUserAnalytics(userId, range, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not load user analytics.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [userId, range, refreshKey, retry]);

  return (
    <section
      aria-label="User analytics"
      aria-busy={loading}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">API activity</h2>
          <p className="text-xs text-epic-text-muted mt-1">
            All projects and API keys owned by this user, including console
            sessions.
          </p>
        </div>
        <Select
          aria-label="User analytics time range"
          selectedKey={range}
          onSelectionChange={(key) =>
            setRange(String(key) as AdminUserAnalyticsRange)
          }
          className="w-44"
        >
          <SelectItem id="month">This month (UTC)</SelectItem>
          <SelectItem id="6">Last 6 hours</SelectItem>
          <SelectItem id="24">Last 24 hours</SelectItem>
          <SelectItem id="168">Last 7 days</SelectItem>
          <SelectItem id="720">Last 30 days</SelectItem>
        </Select>
      </div>
      <UsageError
        message={error}
        retry={() => setRetry((value) => value + 1)}
      />
      {loading && <UsageLoading />}
      {data && (
        <>
          <Coverage data={data} />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <Metric
              label="Requests"
              value={data.totals.requests.toLocaleString()}
            />
            <Metric
              label="Cached responses"
              value={data.totals.cacheHits.toLocaleString()}
              sub={`${data.totals.cacheHitRate}% cache hit rate`}
              color="text-epic-success"
            />
            <Metric
              label="Errors"
              value={data.totals.errors.toLocaleString()}
              sub={`${data.totals.errorRate}% of requests`}
            />
            <Metric
              label="Rate limited · 429"
              value={data.totals.rateLimited.toLocaleString()}
              color="text-epic-warning"
            />
          </div>
          <UsageChart
            data={data}
            cumulative={range === "month"}
            limit={range === "month" ? monthlyLimit : null}
            limitLabel="Monthly limit"
          />
          <p className="text-xs text-epic-text-muted">
            Activity includes blocked requests and paid projects. Monthly quota
            usage counts admitted free-project requests, including cached
            responses.
          </p>
        </>
      )}
    </section>
  );
}
