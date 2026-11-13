import { useId, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsDashboardSummary } from "../../lib/api";
import { Button } from "../ui/Button";
import { panel } from "./UsageShared";

const colors = {
  accent: "var(--color-epic-accent)",
  success: "var(--color-epic-success)",
  warning: "var(--color-epic-warning)",
  danger: "var(--color-epic-danger)",
  muted: "var(--color-epic-text-muted)",
  border: "var(--color-epic-border)",
};
const series = {
  traffic: [
    { key: "requests", name: "Requests", color: colors.accent },
    { key: "cacheHits", name: "Cached", color: colors.success },
  ],
  latency: [
    { key: "avgLatencyMs", name: "Average", color: colors.accent },
    { key: "p95LatencyMs", name: "p95", color: colors.warning },
    { key: "p99LatencyMs", name: "p99", color: colors.muted },
  ],
  errors: [
    { key: "otherErrors", name: "Other 4xx / 5xx", color: colors.danger },
    { key: "rateLimited", name: "429s", color: colors.warning },
  ],
};
export function buildUsageChartPoints(
  data: Pick<
    AnalyticsDashboardSummary,
    "start" | "end" | "bucketMinutes" | "timeseries" | "quotaTimeseries"
  >,
  cumulative = false,
) {
  const buckets = new Map(
    data.timeseries.map((p) => [Date.parse(p.bucket), p]),
  );
  const quotaBuckets = data.quotaTimeseries
    ? new Map(
        data.quotaTimeseries.map((p) => [Date.parse(p.bucket), p.requests]),
      )
    : null;
  const bucketMs = data.bucketMinutes * 60_000;
  const times: number[] = [];
  for (
    let time = Math.floor(Date.parse(data.start) / bucketMs) * bucketMs;
    time < Date.parse(data.end);
    time += bucketMs
  ) {
    times.push(time);
  }
  let cumulativeRequests = 0;
  let cumulativeCacheHits = 0;
  let cumulativeQuotaRequests = 0;
  return times.map((time) => {
    const p = buckets.get(time);
    if (cumulative) {
      cumulativeRequests += p?.requests ?? 0;
      cumulativeCacheHits += p?.cacheHits ?? 0;
      if (quotaBuckets) {
        cumulativeQuotaRequests += quotaBuckets.get(time) ?? 0;
      }
    }
    return {
      time,
      // Missing local-buffer intervals are unknown, not zero. Nulls also prevent
      // latency lines from joining across unobserved periods.
      requests: cumulative ? cumulativeRequests : (p?.requests ?? null),
      cacheHits: cumulative ? cumulativeCacheHits : (p?.cacheHits ?? null),
      quotaRequests:
        cumulative && quotaBuckets ? cumulativeQuotaRequests : null,
      rateLimited: p?.rateLimited ?? null,
      otherErrors: p ? Math.max(0, p.errors - p.rateLimited) : null,
      avgLatencyMs: p?.requests ? p.avgLatencyMs : null,
      p95LatencyMs: p?.requests ? p.p95LatencyMs : null,
      p99LatencyMs: p?.requests ? p.p99LatencyMs : null,
    };
  });
}

export function UsageChart({
  data,
  kind = "traffic",
  compact = false,
  cumulative = false,
  limit = null,
  limitLabel = "Limit",
}: {
  data: AnalyticsDashboardSummary;
  kind?: keyof typeof series;
  compact?: boolean;
  cumulative?: boolean;
  limit?: number | null;
  limitLabel?: string;
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const chartId = useId();
  const isCumulative = cumulative && kind === "traffic";
  const hasQuotaSeries = isCumulative && Array.isArray(data.quotaTimeseries);
  const definitions = hasQuotaSeries
    ? [
        ...series.traffic,
        {
          key: "quotaRequests",
          name: "Free quota usage",
          color: colors.warning,
        },
      ]
    : series[kind];
  const hasLimit = hasQuotaSeries && typeof limit === "number" && limit > 0;
  const title =
    kind === "traffic"
      ? isCumulative
        ? "Cumulative requests over time"
        : "Requests over time"
      : kind === "latency"
        ? "Processing time"
        : "Errors over time";
  const points = buildUsageChartPoints(data, isCumulative);
  const tick = (time: number) =>
    new Date(time).toLocaleString(
      [],
      data.rangeHours > 48
        ? {
            month: "short",
            day: "numeric",
            ...(data.bucketMinutes < 1440 ? { hour: "2-digit" } : {}),
          }
        : { hour: "2-digit", minute: "2-digit" },
    );
  return (
    <section className={panel} aria-labelledby={chartId}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 id={chartId} className="text-sm font-semibold text-white">
            {title}
          </h2>
          <p className="text-xs text-epic-text-muted mt-1">
            {data.bucketMinutes < 60
              ? `${data.bucketMinutes}-minute`
              : `${data.bucketMinutes / 60}-hour`}{" "}
            intervals · {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>
        </div>
        <fieldset
          className="flex flex-wrap gap-1"
          aria-label={`${title} series`}
        >
          {definitions.map((s) => (
            <Button
              key={s.key}
              variant="quiet"
              size="sm"
              aria-pressed={!hidden.includes(s.key)}
              onPress={() =>
                setHidden((prev) =>
                  prev.includes(s.key)
                    ? prev.filter((k) => k !== s.key)
                    : [...prev, s.key],
                )
              }
              className={`!text-[11px] !px-2 ${hidden.includes(s.key) ? "opacity-40" : ""}`}
            >
              <span
                className="w-2 h-2 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              {s.name}
            </Button>
          ))}
          {hasLimit && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-epic-warning px-2 py-1">
              <span
                aria-hidden="true"
                className="w-3 border-t-2 border-dashed border-epic-warning"
              />
              {limitLabel} · {limit.toLocaleString()}
            </span>
          )}
        </fieldset>
      </div>
      {data.totals.requests === 0 ? (
        <div className="h-48 flex items-center justify-center text-xs text-epic-text-muted border border-dashed border-epic-border rounded-lg">
          No requests match this period and these filters.
        </div>
      ) : (
        <div className={compact ? "h-48 min-w-0" : "h-60 min-w-0"}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <ComposedChart
              data={points}
              accessibilityLayer
              syncId={`usage-${data.start}-${data.end}`}
              syncMethod="value"
              margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                stroke={colors.border}
                strokeDasharray="3 4"
                vertical={false}
              />
              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={[Date.parse(data.start), Date.parse(data.end)]}
                ticks={Array.from(
                  { length: 5 },
                  (_, index) =>
                    Date.parse(data.start) +
                    ((Date.parse(data.end) - Date.parse(data.start)) * index) /
                      4,
                )}
                tickFormatter={tick}
                stroke={colors.muted}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                minTickGap={36}
              />
              <YAxis
                width={kind === "latency" ? 58 : 40}
                stroke={colors.muted}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                allowDecimals={kind === "latency"}
                domain={
                  hasLimit
                    ? [0, (dataMax: number) => Math.max(dataMax, limit)]
                    : undefined
                }
                tickFormatter={(value) =>
                  kind === "latency"
                    ? `${value} ms`
                    : Intl.NumberFormat("en", { notation: "compact" }).format(
                        value,
                      )
                }
              />
              <Tooltip
                labelFormatter={(value) =>
                  new Date(Number(value)).toLocaleString()
                }
                contentStyle={{
                  background: "var(--color-epic-elevated)",
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{
                  color: "var(--color-epic-text)",
                  marginBottom: 6,
                }}
                cursor={{
                  stroke: colors.muted,
                  fill: "var(--color-epic-hover)",
                  fillOpacity: 0.2,
                }}
                formatter={(value, name) => [
                  kind === "latency"
                    ? `${value} ms`
                    : Number(value).toLocaleString(),
                  name,
                ]}
              />
              {hasLimit && (
                <ReferenceLine
                  y={limit}
                  stroke={colors.warning}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
                  label={{
                    value: `${limitLabel} · ${Intl.NumberFormat("en", {
                      notation: "compact",
                    }).format(limit)}`,
                    position: "insideTopRight",
                    fill: colors.warning,
                    fontSize: 11,
                  }}
                />
              )}
              {definitions.map((s) =>
                kind === "latency" ||
                (kind === "traffic" &&
                  (s.key === "cacheHits" || s.key === "quotaRequests")) ? (
                  <Line
                    key={s.key}
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={
                      data.timeseries.filter((p) => p.requests > 0).length < 8
                    }
                    connectNulls={false}
                    type="linear"
                    hide={hidden.includes(s.key)}
                    isAnimationActive={false}
                  />
                ) : (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.name}
                    fill={s.color}
                    maxBarSize={28}
                    stackId={kind === "errors" ? "errors" : undefined}
                    hide={hidden.includes(s.key)}
                    isAnimationActive={false}
                  />
                ),
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="text-[11px] text-epic-text-muted mt-3">
        {kind === "traffic"
          ? hasQuotaSeries
            ? "Cumulative totals for the ongoing month. Free quota usage counts admitted free-project requests against the monthly limit."
            : isCumulative
              ? "Cumulative totals for the ongoing month. Cached responses are included in total requests."
              : "Cached responses are included in total requests."
          : kind === "errors"
            ? "429s are separated from other errors to avoid double counting."
            : "Intervals without requests have no processing-time value."}{" "}
        Use arrow keys on the chart to inspect values.
      </p>
    </section>
  );
}
