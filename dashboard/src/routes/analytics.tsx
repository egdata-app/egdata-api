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
import { useCallback, useEffect, useRef, useState } from "react";
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

const CACHE_STATUS_LABELS: Record<string, string> = {
  HIT: "Served from cache",
  MISS: "Not in cache",
  EXPIRED: "Cached response expired",
  STALE: "Served an older cached response",
  UPDATING: "Cache refresh in progress",
  REVALIDATED: "Cached response checked for updates",
  BYPASS: "Cache skipped",
  DYNAMIC: "Not cached",
  EDGE_BLOCK: "Blocked before reaching the API",
};

const LIMIT_OUTCOME_LABELS: Record<string, string> = {
  ok: "Allowed",
  rate_limited: "Request limit reached",
  key_inactive: "Key revoked or paused",
  key_expired: "Key expired",
  ip_denied: "IP address not allowed",
  origin_denied: "Browser origin not allowed",
  method_denied: "HTTP method not allowed",
  path_denied: "Endpoint not allowed",
  scope_denied: "Required permission missing",
};

function AnalyticsPage() {
  const { selectedProject } = useDashboardAuth();
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const [selectedKeyFilter, setSelectedKeyFilter] = useState<string>("all");
  const [hours, setHours] = useState<string>("24");
  const [data, setData] = useState<AnalyticsDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState(false);

  const requestGeneration = useRef(0);
  const loadAnalytics = useCallback(async () => {
    if (!selectedProject) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setData(null);
    try {
      const [keysRes, analyticsRes] = await Promise.all([
        dashboardClient.getKeys(selectedProject.id),
        dashboardClient.getAnalytics({
          hours: Number(hours),
          projectId: selectedProject.id,
          keyId: selectedKeyFilter === "all" ? undefined : selectedKeyFilter,
        }),
      ]);
      if (generation !== requestGeneration.current) return;
      setKeys(keysRes.keys);
      setData(analyticsRes);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      notify({
        title: "Failed to load analytics",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [selectedProject, hours, selectedKeyFilter]);

  useEffect(() => {
    void loadAnalytics();
    return () => {
      ++requestGeneration.current;
    };
  }, [loadAnalytics]);

  async function handleSimulate() {
    setSimulating(true);
    try {
      const res = await dashboardClient.simulateTraffic();
      notify({
        title: `Added ${res.generated} sample requests`,
        description: "Sample data is for previewing the charts.",
        tone: "success",
      });
      await loadAnalytics();
    } catch (err) {
      notify({
        title: "Could not add sample data",
        description:
          err instanceof Error ? err.message : "Create an API key first",
        tone: "danger",
      });
    } finally {
      setSimulating(false);
    }
  }

  const keyOptions = [
    ...(selectedProject
      ? [{ id: `console_${selectedProject.id}`, label: "API console" }]
      : []),
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
              Usage
            </h1>
            {data?.source === "local_buffer" && (
              <Tag tone="neutral">Recent activity only</Tag>
            )}
          </div>
          <p className="text-sm text-epic-text-muted mt-1">
            Review requests made with your API keys and see which ones reached
            their limits.
          </p>
          {data?.source === "local_buffer" && (
            <p className="text-xs text-epic-text-muted mt-1">
              Full usage history is unavailable. These results may not cover the
              entire selected period.
            </p>
          )}
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
              Add Sample Data
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
          label="Served from Cache"
          value={`${data?.totals.cacheHitRate ?? 0}%`}
          accent="text-epic-success"
        />
        <MetricPill
          label="Avg Processing Time"
          value={`${data?.totals.avgLatencyMs ?? 0} ms`}
          accent="text-epic-accent"
        />
        <MetricPill
          label="Rate Limited (429)"
          value={(data?.totals.rateLimited ?? 0).toLocaleString()}
          accent="text-epic-warning"
        />
        <MetricPill
          label="Limit per Key"
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
                Requests over time
              </h2>
              <p className="text-xs text-epic-text-muted mt-0.5">
                Requests grouped by time and how they were handled.
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-epic-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-epic-accent" />
                Cached
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-epic-hover border border-epic-border-hover" />
                Other Requests
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-epic-warning" />
                Rate Limited
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
              Cache Results
            </h2>
            <div className="mt-3 space-y-2.5">
              {(data?.cacheBreakdown.length ?? 0) === 0 ? (
                <p className="text-xs text-epic-text-muted py-4">
                  No cache results for this period.
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
                      label={CACHE_STATUS_LABELS[item.status] ?? item.status}
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
              Access Checks
            </h2>
            <div className="mt-3 space-y-2.5">
              {(data?.limitOutcomes.length ?? 0) === 0 ? (
                <p className="text-xs text-epic-text-muted py-2">
                  No access checks recorded for this period.
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
                      label={LIMIT_OUTCOME_LABELS[item.outcome] ?? item.outcome}
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
      <p className="text-xs text-epic-text-muted">
        Version 1 traffic appears under `/v1/...` route templates alongside
        legacy routes. Filter by API key to compare quota outcomes per key.
      </p>
      <Tabs>
        <TabList aria-label="Usage breakdown">
          <Tab id="endpoints">Top Endpoints</Tab>
          <Tab id="origins">Browser Origins</Tab>
          <Tab id="ips">IP Addresses</Tab>
          <Tab id="useragents">User Agents</Tab>
        </TabList>

        <TabPanel id="endpoints">
          <Table aria-label="Most requested endpoints">
            <TableHeader>
              <Column isRowHeader>Endpoint</Column>
              <Column>Method</Column>
              <Column>Requests</Column>
              <Column>Cached Responses</Column>
              <Column>Rate Limited (429)</Column>
              <Column>Avg Processing Time</Column>
            </TableHeader>
            <TableBody
              items={(data?.endpoints ?? []).map((e) => ({
                ...e,
                id: `${e.method}:${e.route}`,
              }))}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No requests match these filters.
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
              <Column isRowHeader>Browser Origin</Column>
              <Column>Requests</Column>
              <Column>Share</Column>
            </TableHeader>
            <TableBody
              items={(data?.origins ?? []).map((o) => ({ ...o, id: o.origin }))}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No browser origins recorded for this period.
                </div>
              )}
            >
              {(orig) => (
                <Row id={orig.id}>
                  <Cell>
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <Globe className="w-3.5 h-3.5 text-epic-accent" />
                      {orig.origin === "(direct)"
                        ? "No origin provided"
                        : orig.origin}
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
              <Column isRowHeader>IP Address</Column>
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
              <Column isRowHeader>User Agent</Column>
              <Column>Requests</Column>
            </TableHeader>
            <TableBody
              items={(data?.userAgents ?? []).map((u) => ({
                ...u,
                id: u.userAgent,
              }))}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No user agents recorded for this period.
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
        <p>No requests recorded for this period.</p>
        <p className="text-[11px]">
          Send a request with your API key, then refresh to check for activity.
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
              tabIndex={0}
              role="img"
              aria-label={`${label}: ${pt.requests} requests (${pt.cacheHits} cached, ${pt.rateLimited} rate limited)`}
              className="flex-1 min-w-0 h-full flex flex-col justify-end items-center group relative"
              title={`${label}: ${pt.requests} requests (${pt.cacheHits} cached, ${pt.rateLimited} rate limited)`}
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
