import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  Cpu,
  Globe,
  Network,
  Play,
  RefreshCw,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Tag } from "../components/ui/Controls";
import { Select, SelectItem } from "../components/ui/Select";
import {
  Cell,
  Column,
  Row,
  Tab,
  TabList,
  Table,
  TableBody,
  TableHeader,
  TabPanel,
  Tabs,
} from "../components/ui/TableAndTabs";
import { notify } from "../components/ui/Toast";
import {
  type AnalyticsDashboardSummary,
  type DashboardApiKey,
  dashboardClient,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
});

const TIME_RANGES = [
  { id: "6", label: "Last 6 hours" },
  { id: "24", label: "Last 24 hours" },
  { id: "168", label: "Last 7 days" },
  { id: "720", label: "Last 30 days" },
];

function AnalyticsPage() {
  const { selectedProject } = useDashboardAuth();
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const [selectedKeyFilter, setSelectedKeyFilter] = useState<string>("all");
  const [hours, setHours] = useState<string>("24");
  const [data, setData] = useState<AnalyticsDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState(false);

  const loadAnalytics = useCallback(async () => {
    if (!selectedProject) return;
    setLoading(true);
    try {
      const [keysRes, analyticsRes] = await Promise.all([
        dashboardClient.getKeys(selectedProject.id),
        dashboardClient.getAnalytics({
          hours: Number(hours),
          projectId: selectedProject.id,
          keyId: selectedKeyFilter === "all" ? undefined : selectedKeyFilter,
        }),
      ]);
      setKeys(keysRes.keys);
      setData(analyticsRes);
    } catch (err) {
      notify({
        title: "Failed to load analytics",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setLoading(false);
    }
  }, [selectedProject, hours, selectedKeyFilter]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  async function handleSimulate() {
    setSimulating(true);
    try {
      const res = await dashboardClient.simulateTraffic();
      notify({
        title: `Recorded ${res.generated} sample edge events`,
        description: "Analytics charts refreshed.",
        tone: "success",
      });
      await loadAnalytics();
    } catch (err) {
      notify({
        title: "Cannot simulate traffic",
        description:
          err instanceof Error ? err.message : "Create an API key first",
        tone: "danger",
      });
    } finally {
      setSimulating(false);
    }
  }

  const keyOptions = [
    { id: "all", label: "All Project Keys" },
    ...keys.map((k) => ({ id: k.id, label: `${k.name} (${k.keyPrefix})` })),
  ];

  const rpmThreshold =
    selectedProject?.tier === "enterprise"
      ? 6000
      : selectedProject?.tier === "pro"
        ? 1200
        : 120;

  return (
    <div className="space-y-6">
      {/* Header & Filters */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Edge Analytics
            </h1>
            {data && (
              <Tag
                tone={
                  data.source === "cloudflare_analytics_engine"
                    ? "accent"
                    : "neutral"
                }
              >
                {data.source === "cloudflare_analytics_engine"
                  ? "Workers Analytics Engine SQL"
                  : "Live Edge Buffer"}
              </Tag>
            )}
          </div>
          <p className="text-sm text-epic-text-muted mt-1">
            Monitor normalized endpoints, Cloudflare cache hits, rate-limit
            thresholds, origins, client IPs, and user agents.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            aria-label="Filter by API key"
            selectedKey={selectedKeyFilter}
            onSelectionChange={(k) => k && setSelectedKeyFilter(String(k))}
            items={keyOptions}
            className="w-52"
          >
            {(item) => (
              <SelectItem id={item.id} textValue={item.label}>
                {item.label}
              </SelectItem>
            )}
          </Select>

          <Select
            aria-label="Time range"
            selectedKey={hours}
            onSelectionChange={(k) => k && setHours(String(k))}
            items={TIME_RANGES}
            className="w-40"
          >
            {(item) => (
              <SelectItem id={item.id} textValue={item.label}>
                {item.label}
              </SelectItem>
            )}
          </Select>

          <Button
            variant="secondary"
            onPress={() => {
              void loadAnalytics();
            }}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>

          {data?.source === "local_buffer" && (
            <Button
              variant="quiet"
              isPending={simulating}
              onPress={() => {
                void handleSimulate();
              }}
            >
              <Play className="w-3.5 h-3.5 text-epic-accent" />
              Sample Events
            </Button>
          )}
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
        <MetricPill
          label="Total Requests"
          value={(data?.totals.requests ?? 0).toLocaleString()}
          accent="text-white"
        />
        <MetricPill
          label="Cache Hit Rate"
          value={`${data?.totals.cacheHitRate ?? 0}%`}
          accent="text-epic-success"
        />
        <MetricPill
          label="Avg Edge Latency"
          value={`${data?.totals.avgLatencyMs ?? 0} ms`}
          accent="text-epic-accent"
        />
        <MetricPill
          label="429 Rate Limited"
          value={(data?.totals.rateLimited ?? 0).toLocaleString()}
          accent="text-epic-warning"
        />
        <MetricPill
          label="Key RPM Threshold"
          value={`${rpmThreshold.toLocaleString()} / min`}
          accent="text-epic-text"
        />
      </div>

      {/* Main Charts Grid */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Timeseries Bar Chart */}
        <div className="lg:col-span-2 bg-epic-surface border border-epic-border rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-epic-accent" />
                Request Throughput, Cache Hits & Rate-Limit Bursts
              </h2>
              <p className="text-xs text-epic-text-muted mt-0.5">
                Stacked comparison of Cloudflare cache hits vs origin misses and
                429 throttles.
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-epic-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-epic-accent" />
                Cache Hit
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-epic-hover border border-epic-border-hover" />
                Origin Miss
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-epic-warning" />
                429 Throttled
              </span>
            </div>
          </div>

          <TimeseriesChart points={data?.timeseries ?? []} />
        </div>

        {/* Cache & Limit Thresholds Breakdown */}
        <div className="bg-epic-surface border border-epic-border rounded-xl p-5 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-epic-success" />
              CF-Cache-Status Distribution
            </h2>
            <div className="mt-3 space-y-2.5">
              {(data?.cacheBreakdown.length ?? 0) === 0 ? (
                <p className="text-xs text-epic-text-muted py-4">
                  No cache telemetry in range.
                </p>
              ) : (
                data?.cacheBreakdown.map((item) => {
                  const pct =
                    data.totals.requests > 0
                      ? Math.round((item.requests / data.totals.requests) * 100)
                      : 0;
                  return (
                    <HorizontalBar
                      key={item.status}
                      label={item.status}
                      count={item.requests}
                      percent={pct}
                      color={
                        item.status === "HIT" || item.status === "REVALIDATED"
                          ? "bg-epic-success"
                          : item.status === "EDGE_BLOCK"
                            ? "bg-epic-warning"
                            : "bg-epic-accent"
                      }
                    />
                  );
                })
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-epic-border">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-epic-warning" />
              Limit & Policy Outcomes
            </h2>
            <div className="mt-3 space-y-2.5">
              {(data?.limitOutcomes.length ?? 0) === 0 ? (
                <p className="text-xs text-epic-text-muted py-2">
                  No policy events recorded.
                </p>
              ) : (
                data?.limitOutcomes.map((item) => {
                  const pct =
                    data.totals.requests > 0
                      ? Math.round((item.requests / data.totals.requests) * 100)
                      : 0;
                  return (
                    <HorizontalBar
                      key={item.outcome}
                      label={item.outcome}
                      count={item.requests}
                      percent={pct}
                      color={
                        item.outcome === "ok"
                          ? "bg-epic-accent"
                          : "bg-epic-danger"
                      }
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Detailed Dimension Tabs */}
      <Tabs>
        <TabList aria-label="Analytics Dimensions">
          <Tab id="endpoints">Top Endpoints</Tab>
          <Tab id="origins">Origins</Tab>
          <Tab id="ips">Client IPs & Geo</Tab>
          <Tab id="useragents">User Agents</Tab>
        </TabList>

        <TabPanel id="endpoints">
          <Table aria-label="Top Endpoints Hit">
            <TableHeader>
              <Column isRowHeader>Normalized Route (X-Route-Template)</Column>
              <Column>Method</Column>
              <Column>Requests</Column>
              <Column>Cache Hits</Column>
              <Column>429 Rate Limited</Column>
              <Column>Avg Latency</Column>
            </TableHeader>
            <TableBody
              items={(data?.endpoints ?? []).map((e) => ({
                ...e,
                id: `${e.method}:${e.route}`,
              }))}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No endpoint requests recorded for this filter.
                </div>
              )}
            >
              {(ep) => (
                <Row id={ep.id}>
                  <Cell>
                    <span className="font-mono text-xs text-epic-text">
                      {ep.route}
                    </span>
                  </Cell>
                  <Cell>
                    <Tag tone="accent">{ep.method}</Tag>
                  </Cell>
                  <Cell className="font-mono text-xs">
                    {ep.requests.toLocaleString()}
                  </Cell>
                  <Cell className="font-mono text-xs text-epic-success">
                    {ep.cacheHits.toLocaleString()} (
                    {ep.requests > 0
                      ? Math.round((ep.cacheHits / ep.requests) * 100)
                      : 0}
                    %)
                  </Cell>
                  <Cell className="font-mono text-xs text-epic-warning">
                    {ep.rateLimited.toLocaleString()}
                  </Cell>
                  <Cell className="font-mono text-xs text-epic-text-muted">
                    {ep.avgLatencyMs} ms
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </TabPanel>

        <TabPanel id="origins">
          <Table aria-label="Request Origins">
            <TableHeader>
              <Column isRowHeader>Origin Header</Column>
              <Column>Requests</Column>
              <Column>Share</Column>
            </TableHeader>
            <TableBody
              items={(data?.origins ?? []).map((o) => ({ ...o, id: o.origin }))}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No Origin headers recorded.
                </div>
              )}
            >
              {(orig) => (
                <Row id={orig.id}>
                  <Cell>
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <Globe className="w-3.5 h-3.5 text-epic-accent" />
                      {orig.origin}
                    </div>
                  </Cell>
                  <Cell className="font-mono text-xs">
                    {orig.requests.toLocaleString()}
                  </Cell>
                  <Cell className="font-mono text-xs text-epic-text-muted">
                    {data && data.totals.requests > 0
                      ? `${Math.round((orig.requests / data.totals.requests) * 100)}%`
                      : "0%"}
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </TabPanel>

        <TabPanel id="ips">
          <Table aria-label="Client IP Addresses">
            <TableHeader>
              <Column isRowHeader>Client IP (CF-Connecting-IP)</Column>
              <Column>Country</Column>
              <Column>Requests</Column>
              <Column>Rate Limited (429)</Column>
            </TableHeader>
            <TableBody
              items={(data?.ips ?? []).map((item) => ({
                ...item,
                id: `${item.ip}:${item.country}`,
              }))}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No client IPs recorded.
                </div>
              )}
            >
              {(ipItem) => (
                <Row id={ipItem.id}>
                  <Cell>
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <Network className="w-3.5 h-3.5 text-epic-accent" />
                      {ipItem.ip}
                    </div>
                  </Cell>
                  <Cell>
                    <Tag tone="neutral">{ipItem.country}</Tag>
                  </Cell>
                  <Cell className="font-mono text-xs">
                    {ipItem.requests.toLocaleString()}
                  </Cell>
                  <Cell className="font-mono text-xs text-epic-warning">
                    {ipItem.rateLimited.toLocaleString()}
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </TabPanel>

        <TabPanel id="useragents">
          <Table aria-label="Client User Agents">
            <TableHeader>
              <Column isRowHeader>User-Agent String</Column>
              <Column>Requests</Column>
            </TableHeader>
            <TableBody
              items={(data?.userAgents ?? []).map((u) => ({
                ...u,
                id: u.userAgent,
              }))}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No User-Agents recorded.
                </div>
              )}
            >
              {(ua) => (
                <Row id={ua.id}>
                  <Cell>
                    <div className="flex items-center gap-2 font-mono text-xs max-w-2xl truncate">
                      <Cpu className="w-3.5 h-3.5 text-epic-accent shrink-0" />
                      <span className="truncate">{ua.userAgent}</span>
                    </div>
                  </Cell>
                  <Cell className="font-mono text-xs">
                    {ua.requests.toLocaleString()}
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </TabPanel>
      </Tabs>
    </div>
  );
}

function MetricPill({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="bg-epic-surface border border-epic-border rounded-xl px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-epic-text-muted">
        {label}
      </div>
      <div className={`text-xl font-bold tracking-tight mt-1 ${accent}`}>
        {value}
      </div>
    </div>
  );
}

function HorizontalBar({
  label,
  count,
  percent,
  color,
}: {
  label: string;
  count: number;
  percent: number;
  color: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-epic-text">{label}</span>
        <span className="text-epic-text-muted font-mono">
          {count.toLocaleString()} ({percent}%)
        </span>
      </div>
      <div className="h-2 rounded-full bg-epic-bg overflow-hidden border border-epic-border/60">
        <div
          className={`h-full rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${Math.max(percent, count > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function TimeseriesChart({
  points,
}: {
  points: AnalyticsDashboardSummary["timeseries"];
}) {
  if (points.length === 0) {
    return (
      <div className="h-56 flex flex-col items-center justify-center border border-dashed border-epic-border rounded-lg text-xs text-epic-text-muted gap-2">
        <p>No time-series buckets recorded in this window yet.</p>
        <p className="text-[11px]">
          Make requests with your{" "}
          <code className="font-mono text-epic-accent">X-API-Key</code> (or
          click &ldquo;Sample Events&rdquo; in local dev) to populate live
          charts.
        </p>
      </div>
    );
  }

  const maxReq = Math.max(...points.map((p) => p.requests), 1);

  return (
    <div className="space-y-2">
      <div className="h-56 flex items-end gap-1.5 pt-4 px-2 bg-epic-bg/60 border border-epic-border/70 rounded-lg">
        {points.map((pt) => {
          const totalHeightPct = Math.max((pt.requests / maxReq) * 100, 4);
          const hitShare =
            pt.requests > 0 ? (pt.cacheHits / pt.requests) * 100 : 0;
          const rlShare =
            pt.requests > 0 ? (pt.rateLimited / pt.requests) * 100 : 0;
          const missShare = Math.max(0, 100 - hitShare - rlShare);
          const label = new Date(pt.bucket).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });

          return (
            <div
              key={pt.bucket}
              className="flex-1 min-w-0 h-full flex flex-col justify-end items-center group relative"
              title={`${label}: ${pt.requests} req (${pt.cacheHits} hits, ${pt.rateLimited} 429s)`}
            >
              <div
                className="w-full max-w-8 rounded-t-sm overflow-hidden flex flex-col justify-end transition-all group-hover:brightness-110"
                style={{ height: `${totalHeightPct}%` }}
              >
                {rlShare > 0 && (
                  <div
                    className="w-full bg-epic-warning"
                    style={{ height: `${rlShare}%` }}
                  />
                )}
                {missShare > 0 && (
                  <div
                    className="w-full bg-epic-hover"
                    style={{ height: `${missShare}%` }}
                  />
                )}
                {hitShare > 0 && (
                  <div
                    className="w-full bg-epic-accent"
                    style={{ height: `${hitShare}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-[11px] font-mono text-epic-text-muted px-1">
        <span>{new Date(points[0].bucket).toLocaleString()}</span>
        <span>
          {new Date(points[points.length - 1].bucket).toLocaleString()}
        </span>
      </div>
    </div>
  );
}
