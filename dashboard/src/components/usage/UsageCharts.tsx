import { useId, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
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
  statusMix: [
    { key: "status2xx3xx", name: "2xx / 3xx", color: colors.success },
    { key: "status4xxOther", name: "4xx Client", color: colors.warning },
    { key: "rateLimited", name: "429s", color: "#fb923c" },
    { key: "status5xx", name: "5xx Server", color: colors.danger },
  ],
  rpm: [{ key: "rpm", name: "Avg req/min", color: colors.accent }],
  latency: [
    { key: "avgLatencyMs", name: "Average", color: colors.accent },
    { key: "p50LatencyMs", name: "p50", color: colors.success },
    { key: "p95LatencyMs", name: "p95", color: colors.warning },
    { key: "p99LatencyMs", name: "p99", color: colors.muted },
  ],
  cacheLatency: [
    { key: "avgHitLatencyMs", name: "Edge HIT avg", color: colors.success },
    { key: "avgMissLatencyMs", name: "Origin MISS avg", color: colors.warning },
    { key: "avgUpstreamLatencyMs", name: "Upstream avg", color: colors.accent },
  ],
  errors: [
    { key: "status4xxOther", name: "4xx Client/Auth", color: "#facc15" },
    { key: "rateLimited", name: "429s", color: colors.warning },
    { key: "status5xx", name: "5xx Server", color: colors.danger },
  ],
};

export function buildUsageChartPoints(
  data: Pick<
    AnalyticsDashboardSummary,
    | "start"
    | "end"
    | "bucketMinutes"
    | "timeseries"
    | "quotaTimeseries"
    | "previousTimeseries"
  >,
  cumulative = false,
) {
  const buckets = new Map(
    data.timeseries.map((p) => [Date.parse(p.bucket), p]),
  );
  const prevBuckets = data.previousTimeseries
    ? new Map(data.previousTimeseries.map((p) => [Date.parse(p.bucket), p]))
    : null;
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
    const prev = prevBuckets?.get(time);
    if (cumulative) {
      cumulativeRequests += p?.requests ?? 0;
      cumulativeCacheHits += p?.cacheHits ?? 0;
      if (quotaBuckets) {
        cumulativeQuotaRequests += quotaBuckets.get(time) ?? 0;
      }
    }
    const status5xx = p
      ? (p.status5xx ?? Math.max(0, p.errors - p.rateLimited))
      : null;
    const status4xxTotal = p
      ? (p.status4xx ?? p.rateLimited)
      : 0;
    const status4xxOther = p
      ? p.status4xx !== undefined
        ? Math.max(0, status4xxTotal - p.rateLimited)
        : Math.max(0, p.errors - p.rateLimited - (status5xx ?? 0))
      : null;
    const status2xx3xx = p
      ? p.status2xx !== undefined || p.status3xx !== undefined
        ? (p.status2xx ?? 0) + (p.status3xx ?? 0)
        : Math.max(0, p.requests - p.errors)
      : null;
    return {
      time,
      // Missing local-buffer intervals are unknown, not zero. Nulls also prevent
      // latency lines from joining across unobserved periods.
      requests: cumulative ? cumulativeRequests : (p?.requests ?? null),
      cacheHits: cumulative ? cumulativeCacheHits : (p?.cacheHits ?? null),
      quotaRequests:
        cumulative && quotaBuckets ? cumulativeQuotaRequests : null,
      prevRequests: !cumulative && prev ? prev.requests : null,
      prevAvgLatencyMs:
        !cumulative && prev && prev.requests > 0 ? prev.avgLatencyMs : null,
      rpm: p
        ? Math.round((p.requests / Math.max(1, data.bucketMinutes)) * 10) / 10
        : null,
      cacheHitRate: p && p.requests > 0 ? p.cacheHitRate : null,
      rateLimited: p?.rateLimited ?? null,
      otherErrors: p ? Math.max(0, p.errors - p.rateLimited) : null,
      status2xx3xx,
      status4xxOther,
      status5xx,
      blockedPolicy: p?.blockedPolicy ?? null,
      avgLatencyMs: p?.requests ? p.avgLatencyMs : null,
      p50LatencyMs: p?.requests ? p.p50LatencyMs : null,
      p95LatencyMs: p?.requests ? p.p95LatencyMs : null,
      p99LatencyMs: p?.requests ? p.p99LatencyMs : null,
      avgHitLatencyMs:
        p?.requests && (p.avgHitLatencyMs ?? 0) > 0 ? p.avgHitLatencyMs : null,
      avgMissLatencyMs:
        p?.requests && (p.avgMissLatencyMs ?? 0) > 0
          ? p.avgMissLatencyMs
          : null,
      avgUpstreamLatencyMs:
        p?.requests && (p.avgUpstreamLatencyMs ?? 0) > 0
          ? p.avgUpstreamLatencyMs
          : null,
    };
  });
}

type TrafficMode = "requests" | "statusMix" | "rpm" | "cumulative";
type LatencyMode = "percentiles" | "cacheSplit";

export function UsageChart({
  data,
  kind = "traffic",
  compact = false,
  cumulative = false,
  limit = null,
  limitLabel = "Limit",
  rpmLimit = null,
  onZoomRange,
}: {
  data: AnalyticsDashboardSummary;
  kind?: "traffic" | "latency" | "errors";
  compact?: boolean;
  cumulative?: boolean;
  limit?: number | null;
  limitLabel?: string;
  rpmLimit?: number | null;
  onZoomRange?: (startIso: string, endIso: string) => void;
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [trafficMode, setTrafficMode] = useState<TrafficMode>(
    cumulative ? "cumulative" : "requests",
  );
  const [latencyMode, setLatencyMode] = useState<LatencyMode>("percentiles");
  const [showPrevious, setShowPrevious] = useState(false);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const chartId = useId();

  const effectiveTrafficMode = cumulative ? "cumulative" : trafficMode;
  const isCumulative =
    kind === "traffic" && effectiveTrafficMode === "cumulative";
  const hasQuotaSeries = isCumulative && Array.isArray(data.quotaTimeseries);
  const hasPrevSeries =
    Array.isArray(data.previousTimeseries) && data.previousTimeseries.length > 0;

  let definitions = series[kind];
  if (kind === "traffic") {
    if (effectiveTrafficMode === "statusMix") definitions = series.statusMix;
    else if (effectiveTrafficMode === "rpm") definitions = series.rpm;
    else if (hasQuotaSeries) {
      definitions = [
        ...series.traffic,
        {
          key: "quotaRequests",
          name: "Free quota usage",
          color: colors.warning,
        },
      ];
    }
  } else if (kind === "latency" && latencyMode === "cacheSplit") {
    definitions = series.cacheLatency;
  }

  const hasMonthlyLimit =
    isCumulative && typeof limit === "number" && limit > 0;
  const hasRpmLimit =
    kind === "traffic" &&
    effectiveTrafficMode === "rpm" &&
    typeof rpmLimit === "number" &&
    rpmLimit > 0;

  const title =
    kind === "traffic"
      ? effectiveTrafficMode === "cumulative"
        ? "Cumulative requests over time"
        : effectiveTrafficMode === "statusMix"
          ? "Response status mix over time"
          : effectiveTrafficMode === "rpm"
            ? "Request pace (RPM) vs project cap"
            : "Requests over time"
      : kind === "latency"
        ? latencyMode === "cacheSplit"
          ? "Edge cache HIT vs origin MISS latency"
          : "Processing time"
        : "Errors & throttling over time";

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

  const canZoom = Boolean(onZoomRange && !isCumulative && !compact);
  const activeLeft =
    dragStart !== null && dragEnd !== null
      ? Math.min(dragStart, dragEnd)
      : null;
  const activeRight =
    dragStart !== null && dragEnd !== null
      ? Math.max(dragStart, dragEnd)
      : null;

  const finishDrag = () => {
    if (
      canZoom &&
      onZoomRange &&
      activeLeft !== null &&
      activeRight !== null &&
      activeRight - activeLeft >= data.bucketMinutes * 60_000
    ) {
      onZoomRange(
        new Date(activeLeft).toISOString(),
        new Date(activeRight + data.bucketMinutes * 60_000).toISOString(),
      );
    }
    setDragStart(null);
    setDragEnd(null);
  };

  const isRpmUnit = kind === "traffic" && effectiveTrafficMode === "rpm";

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
            {canZoom ? " · Drag across chart to zoom" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kind === "traffic" && !cumulative && !compact && (
            <fieldset
              className="inline-flex rounded-lg border border-epic-border bg-epic-bg p-0.5 m-0"
              aria-label="Traffic chart view"
            >
              {(
                [
                  { id: "requests", label: "Volume" },
                  { id: "statusMix", label: "Status mix" },
                  ...(rpmLimit ? [{ id: "rpm", label: "RPM pace" } as const] : []),
                  { id: "cumulative", label: "Cumulative" },
                ] as readonly { id: TrafficMode; label: string }[]
              ).map((tab) => (
                <Button
                  key={tab.id}
                  variant={trafficMode === tab.id ? "secondary" : "quiet"}
                  size="sm"
                  onPress={() => setTrafficMode(tab.id)}
                  className="!text-[11px] !px-2.5 !py-1 !min-h-0"
                >
                  {tab.label}
                </Button>
              ))}
            </fieldset>
          )}
          {kind === "latency" && !compact && (
            <fieldset
              className="inline-flex rounded-lg border border-epic-border bg-epic-bg p-0.5 m-0"
              aria-label="Latency chart view"
            >
              {(
                [
                  { id: "percentiles", label: "Percentiles" },
                  { id: "cacheSplit", label: "HIT vs MISS" },
                ] as const
              ).map((tab) => (
                <Button
                  key={tab.id}
                  variant={latencyMode === tab.id ? "secondary" : "quiet"}
                  size="sm"
                  onPress={() => setLatencyMode(tab.id)}
                  className="!text-[11px] !px-2.5 !py-1 !min-h-0"
                >
                  {tab.label}
                </Button>
              ))}
            </fieldset>
          )}
          {hasPrevSeries &&
            !compact &&
            ((kind === "traffic" && effectiveTrafficMode === "requests") ||
              (kind === "latency" && latencyMode === "percentiles")) && (
              <Button
                variant={showPrevious ? "secondary" : "quiet"}
                size="sm"
                aria-pressed={showPrevious}
                onPress={() => setShowPrevious((v) => !v)}
                className="!text-[11px] !px-2 !py-1 !min-h-0"
              >
                <span
                  aria-hidden="true"
                  className="w-3 border-t border-dashed border-epic-text-muted"
                />
                Prev period
              </Button>
            )}
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
            {hasMonthlyLimit && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-epic-warning px-2 py-1">
                <span
                  aria-hidden="true"
                  className="w-3 border-t-2 border-dashed border-epic-warning"
                />
                {limitLabel} · {limit.toLocaleString()}
              </span>
            )}
            {hasRpmLimit && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-epic-warning px-2 py-1">
                <span
                  aria-hidden="true"
                  className="w-3 border-t-2 border-dashed border-epic-warning"
                />
                Cap · {rpmLimit.toLocaleString()} req/min
              </span>
            )}
          </fieldset>
        </div>
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
              onMouseDown={(e) => {
                if (canZoom && e?.activeLabel !== undefined) {
                  setDragStart(Number(e.activeLabel));
                  setDragEnd(Number(e.activeLabel));
                }
              }}
              onMouseMove={(e) => {
                if (
                  canZoom &&
                  dragStart !== null &&
                  e?.activeLabel !== undefined
                ) {
                  setDragEnd(Number(e.activeLabel));
                }
              }}
              onMouseUp={finishDrag}
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
                width={kind === "latency" ? 58 : 44}
                stroke={colors.muted}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                allowDecimals={kind === "latency" || isRpmUnit}
                domain={
                  hasMonthlyLimit
                    ? [0, (dataMax: number) => Math.max(dataMax, limit)]
                    : hasRpmLimit
                      ? [0, (dataMax: number) => Math.max(dataMax, rpmLimit)]
                      : undefined
                }
                tickFormatter={(value) =>
                  kind === "latency"
                    ? `${value} ms`
                    : isRpmUnit
                      ? `${value}/m`
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
                    : isRpmUnit
                      ? `${value} req/min`
                      : Number(value).toLocaleString(),
                  name,
                ]}
              />
              {hasMonthlyLimit && (
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
              {hasRpmLimit && (
                <ReferenceLine
                  y={rpmLimit}
                  stroke={colors.warning}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
                  label={{
                    value: `Cap · ${rpmLimit.toLocaleString()} rpm`,
                    position: "insideTopRight",
                    fill: colors.warning,
                    fontSize: 11,
                  }}
                />
              )}
              {activeLeft !== null &&
                activeRight !== null &&
                activeRight > activeLeft && (
                  <ReferenceArea
                    x1={activeLeft}
                    x2={activeRight}
                    strokeOpacity={0.4}
                    fill="var(--color-epic-accent)"
                    fillOpacity={0.18}
                  />
                )}
              {showPrevious &&
                hasPrevSeries &&
                kind === "traffic" &&
                effectiveTrafficMode === "requests" && (
                  <Line
                    dataKey="prevRequests"
                    name="Previous period"
                    stroke={colors.muted}
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                )}
              {showPrevious &&
                hasPrevSeries &&
                kind === "latency" &&
                latencyMode === "percentiles" && (
                  <Line
                    dataKey="prevAvgLatencyMs"
                    name="Previous avg"
                    stroke={colors.muted}
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                )}
              {definitions.map((s) =>
                kind === "latency" ||
                isRpmUnit ||
                (kind === "traffic" &&
                  effectiveTrafficMode !== "statusMix" &&
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
                    stackId={
                      kind === "errors" ||
                      effectiveTrafficMode === "statusMix"
                        ? "stack"
                        : undefined
                    }
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
            ? "Cumulative totals for the selected window. Free quota usage counts admitted free-project requests against the monthly limit."
            : isCumulative
              ? "Cumulative totals across the selected window. Cached responses are included in total requests."
              : effectiveTrafficMode === "rpm"
                ? "Average requests per minute per interval compared against your project RPM ceiling."
                : effectiveTrafficMode === "statusMix"
                  ? "Stacked HTTP response classes across every interval."
                  : "Cached responses are included in total requests."
          : kind === "errors"
            ? "429s are separated from other 4xx client/auth errors and 5xx server errors to avoid double counting."
            : latencyMode === "cacheSplit"
              ? "Edge HIT responses bypass origin processing; Origin MISS shows uncached end-to-end processing."
              : "Intervals without requests have no processing-time value."}{" "}
        Use arrow keys on the chart to inspect values.
      </p>
    </section>
  );
}

export function CacheEfficiencyChart({
  data,
}: {
  data: AnalyticsDashboardSummary;
}) {
  const chartId = useId();
  const points = buildUsageChartPoints(data, false);
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
      <div className="mb-4">
        <h2 id={chartId} className="text-sm font-semibold text-white">
          Edge cache hit ratio
        </h2>
        <p className="text-xs text-epic-text-muted mt-1">
          Percentage of requests served from edge cache or 304 revalidation
        </p>
      </div>
      {data.totals.requests === 0 ? (
        <div className="h-44 flex items-center justify-center text-xs text-epic-text-muted border border-dashed border-epic-border rounded-lg">
          No requests match this period and these filters.
        </div>
      ) : (
        <div className="h-48 min-w-0">
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
                width={44}
                domain={[0, 100]}
                stroke={colors.muted}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value) => `${value}%`}
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
                formatter={(value) => [`${value}%`, "Cache hit rate"]}
              />
              <Area
                dataKey="cacheHitRate"
                name="Cache hit %"
                stroke={colors.success}
                fill={colors.success}
                fillOpacity={0.14}
                strokeWidth={2}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export function LatencyDistributionChart({
  data,
}: {
  data: AnalyticsDashboardSummary;
}) {
  const chartId = useId();
  const buckets = data.latencyDistribution ?? [];
  return (
    <section className={panel} aria-labelledby={chartId}>
      <div className="mb-4">
        <h2 id={chartId} className="text-sm font-semibold text-white">
          Processing-time distribution
        </h2>
        <p className="text-xs text-epic-text-muted mt-1">
          Request latency spread across edge cache hits and origin responses
        </p>
      </div>
      {data.totals.requests === 0 || buckets.length === 0 ? (
        <div className="h-44 flex items-center justify-center text-xs text-epic-text-muted border border-dashed border-epic-border rounded-lg">
          No latency distribution data for this window.
        </div>
      ) : (
        <div className="h-48 min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart
              data={buckets}
              accessibilityLayer
              margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                stroke={colors.border}
                strokeDasharray="3 4"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                stroke={colors.muted}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                width={44}
                stroke={colors.muted}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value) =>
                  Intl.NumberFormat("en", { notation: "compact" }).format(value)
                }
              />
              <Tooltip
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
                formatter={(value) => [
                  Number(value).toLocaleString(),
                  "Requests",
                ]}
              />
              <Bar
                dataKey="requests"
                name="Requests"
                fill={colors.accent}
                radius={[4, 4, 0, 0]}
                maxBarSize={44}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
