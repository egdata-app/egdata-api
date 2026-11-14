import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, BookOpen, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Button, buttonStyles } from "../components/ui/Button";
import { Switch, Tag } from "../components/ui/Controls";
import { Dialog, Heading, Modal } from "../components/ui/Modal";
import { Select, SelectItem } from "../components/ui/Select";
import { MonthlyQuotaPanel } from "../components/usage/MonthlyQuotaPanel";
import {
  CacheEfficiencyChart,
  LatencyDistributionChart,
  UsageChart,
} from "../components/usage/UsageCharts";
import {
  Coverage,
  Freshness,
  Metric,
  outcomeLabels,
  RankedList,
  ScopeSelector,
  UsageBreakdowns,
  UsageError,
  UsageInsightsPanel,
  UsageLoading,
  UsageMetricsStrip,
} from "../components/usage/UsageShared";
import { UsageTable } from "../components/usage/UsageTable";
import {
  type AccountMonthlyQuotaStatus,
  type DashboardApiKey,
  dashboardClient,
  type StatusClassFilter,
  type UsageDimension,
  type UsageFilters,
  type UsageRow,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";
import { deriveUsageInsights, useUsage } from "../lib/usage";

const searchSchema = z.object({
  range: z.enum(["1", "6", "24", "168", "720", "month"]).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  apiVersion: z.enum(["all", "legacy", "v1"]).optional(),
  projectId: z.string().optional(),
  keyId: z.string().optional(),
  route: z.string().optional(),
  method: z.string().optional(),
  statusClass: z.enum(["all", "2xx", "3xx", "4xx", "5xx"]).optional(),
  statusCode: z.string().optional(),
  limitOutcome: z.string().optional(),
  cacheStatus: z.string().optional(),
  country: z.string().optional(),
  clientCategory: z.string().optional(),
  originPresence: z.enum(["present", "direct"]).optional(),
  policyFamily: z.string().optional(),
  excludeConsole: z.boolean().optional(),
});
export const Route = createFileRoute("/analytics")({
  validateSearch: searchSchema,
  component: UsageRoute,
});

function UsageRoute() {
  const { selectedProject, analyticsScope } = useDashboardAuth();
  const navigate = Route.useNavigate();
  const contextKey = `${analyticsScope}:${selectedProject?.id}`;
  const [previousContext, setPreviousContext] = useState(contextKey);
  const changingScope = previousContext !== contextKey;
  useEffect(() => {
    if (previousContext !== contextKey) {
      void navigate({ search: {}, replace: true }).then(() =>
        setPreviousContext(contextKey),
      );
    }
  }, [contextKey, navigate, previousContext]);
  if (changingScope) return <UsageLoading />;
  return <UsagePage key={`${analyticsScope}:${selectedProject?.id}`} />;
}

function resolveMonthWindow(): { start: string; hours: number } {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const hours = Math.min(
    720,
    Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 3600_000)),
  );
  return { start: monthStart.toISOString(), hours };
}

function UsagePage() {
  const { selectedProject, analyticsScope } = useDashboardAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const [monthlyQuota, setMonthlyQuota] =
    useState<AccountMonthlyQuotaStatus | null>(null);

  const rangeKey = search.range ?? "24";
  const monthWindow = useMemo(
    () => (rangeKey === "month" ? resolveMonthWindow() : null),
    [rangeKey],
  );

  const projectId =
    analyticsScope === "all" ? search.projectId : selectedProject?.id;
  const filters: UsageFilters = {
    hours: monthWindow ? monthWindow.hours : Number(rangeKey),
    start: search.start ?? monthWindow?.start,
    end: search.end,
    scope: analyticsScope,
    apiVersion: search.apiVersion,
    projectId,
    keyId: search.keyId,
    statusClass: search.statusClass,
    statusCode: search.statusCode,
    limitOutcome: search.limitOutcome,
    cacheStatus: search.cacheStatus,
    country: search.country,
    clientCategory: search.clientCategory,
    originPresence: search.originPresence,
    policyFamily: search.policyFamily,
    excludeConsole: search.excludeConsole,
  };
  const result = useUsage(
    analyticsScope === "all" || projectId ? filters : null,
    autoRefresh,
  );
  const data = result.data;
  useEffect(() => {
    if (analyticsScope === "all" || !selectedProject) return;
    let current = true;
    void dashboardClient
      .getKeys(selectedProject.id)
      .then((r) => {
        if (current) setKeys(r.keys);
      })
      .catch(() => {
        if (current) setKeys([]);
      });
    return () => {
      current = false;
    };
  }, [selectedProject, analyticsScope]);

  const updateSearch = (next: z.infer<typeof searchSchema>) => {
    const cleaned = Object.fromEntries(
      Object.entries(next).filter(
        ([, v]) => v !== undefined && v !== "" && v !== false && v !== "all",
      ),
    ) as z.infer<typeof searchSchema>;
    void navigate({ search: cleaned });
  };

  function toggleFilter<K extends keyof z.infer<typeof searchSchema>>(
    key: K,
    value: z.infer<typeof searchSchema>[K],
  ) {
    updateSearch({
      ...search,
      [key]: search[key] === value ? undefined : value,
    });
  }

  function drilldown(dimension: UsageDimension, row: UsageRow) {
    if (dimension === "endpoints")
      updateSearch({ ...search, route: row.route, method: row.method });
    if (dimension === "projects")
      updateSearch({ ...search, projectId: row.projectId, keyId: undefined });
    if (dimension === "keys")
      updateSearch({ ...search, projectId: row.projectId, keyId: row.keyId });
    if (dimension === "statusCodes") toggleFilter("statusCode", row.label);
    if (dimension === "limitOutcomes") toggleFilter("limitOutcome", row.label);
    if (dimension === "cacheStatuses") toggleFilter("cacheStatus", row.label);
    if (dimension === "policies") toggleFilter("policyFamily", row.label);
    if (dimension === "ips") toggleFilter("country", row.label);
    if (dimension === "userAgents") toggleFilter("clientCategory", row.label);
    if (dimension === "origins") {
      toggleFilter(
        "originPresence",
        row.label === "(direct)" ? "direct" : "present",
      );
    }
  }

  const keyOptions = [
    { id: "all", label: "All project keys" },
    ...(selectedProject
      ? [{ id: `console_${selectedProject.id}`, label: "API console" }]
      : []),
    ...keys.map((k) => ({ id: k.id, label: k.name })),
  ];
  if (search.keyId && !keyOptions.some((k) => k.id === search.keyId))
    keyOptions.push({ id: search.keyId, label: search.keyId });

  const quota =
    selectedProject?.customRpm ??
    (selectedProject?.tier === "enterprise"
      ? 6000
      : selectedProject?.tier === "scale"
        ? 1200
        : selectedProject?.tier === "pro"
          ? 300
          : 120);

  const insights = useMemo(() => {
    if (!data) return [];
    return deriveUsageInsights(data, {
      rpmLimit: analyticsScope !== "all" ? quota : undefined,
      monthlyUsed:
        analyticsScope !== "all" && selectedProject?.tier === "free"
          ? monthlyQuota?.used
          : undefined,
      monthlyAllowance:
        analyticsScope !== "all" && selectedProject?.tier === "free"
          ? monthlyQuota?.allowance
          : undefined,
      monthlyResetAt:
        analyticsScope !== "all" && selectedProject?.tier === "free"
          ? monthlyQuota?.resetAt
          : undefined,
    });
  }, [data, analyticsScope, quota, selectedProject?.tier, monthlyQuota]);

  const activeChips: Array<{ label: string; onClear: () => void }> = [];
  if (search.start && search.end) {
    activeChips.push({
      label: `Zoomed: ${search.start.slice(11, 16)}–${search.end.slice(11, 16)} UTC`,
      onClear: () =>
        updateSearch({ ...search, start: undefined, end: undefined }),
    });
  }
  if (analyticsScope === "all" && search.projectId) {
    activeChips.push({
      label: `App: ${data?.projects.find((p) => p.projectId === search.projectId)?.label ?? search.projectId}`,
      onClear: () => updateSearch({ ...search, projectId: undefined }),
    });
  }
  if (search.keyId) {
    activeChips.push({
      label: `Key: ${data?.keys.find((k) => k.keyId === search.keyId)?.label ?? search.keyId}`,
      onClear: () => updateSearch({ ...search, keyId: undefined }),
    });
  }
  if (search.apiVersion && search.apiVersion !== "all") {
    activeChips.push({
      label: `API: ${search.apiVersion}`,
      onClear: () => updateSearch({ ...search, apiVersion: undefined }),
    });
  }
  if (search.statusClass && search.statusClass !== "all") {
    activeChips.push({
      label: `Class: ${search.statusClass}`,
      onClear: () => updateSearch({ ...search, statusClass: undefined }),
    });
  }
  if (search.statusCode) {
    activeChips.push({
      label: `HTTP ${search.statusCode}`,
      onClear: () => updateSearch({ ...search, statusCode: undefined }),
    });
  }
  if (search.cacheStatus) {
    activeChips.push({
      label: `Cache: ${search.cacheStatus}`,
      onClear: () => updateSearch({ ...search, cacheStatus: undefined }),
    });
  }
  if (search.limitOutcome) {
    activeChips.push({
      label: `Outcome: ${outcomeLabels[search.limitOutcome] ?? search.limitOutcome}`,
      onClear: () => updateSearch({ ...search, limitOutcome: undefined }),
    });
  }
  if (search.country) {
    activeChips.push({
      label: `Country: ${search.country}`,
      onClear: () => updateSearch({ ...search, country: undefined }),
    });
  }
  if (search.clientCategory) {
    activeChips.push({
      label: `Client: ${search.clientCategory}`,
      onClear: () => updateSearch({ ...search, clientCategory: undefined }),
    });
  }
  if (search.originPresence) {
    activeChips.push({
      label: `Origin: ${search.originPresence === "present" ? "Browser origin" : "Direct"}`,
      onClear: () => updateSearch({ ...search, originPresence: undefined }),
    });
  }
  if (search.policyFamily) {
    activeChips.push({
      label: `Policy: ${search.policyFamily}`,
      onClear: () => updateSearch({ ...search, policyFamily: undefined }),
    });
  }
  if (search.excludeConsole) {
    activeChips.push({
      label: "Excluding API Console",
      onClear: () => updateSearch({ ...search, excludeConsole: undefined }),
    });
  }

  const busiestEndpoints = data?.busiestEndpoints ?? data?.endpoints ?? [];
  const slowestEndpoints = data?.slowestEndpoints ?? [];
  const errorEndpoints = (data?.errorEndpoints ?? []).filter(
    (e) => e.errors > 0,
  );
  const throttledEndpoints = (data?.endpoints ?? []).filter(
    (e) => e.rateLimited > 0,
  );
  const throttledKeys = (data?.keys ?? []).filter((k) => k.rateLimited > 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Usage &amp; Insights
            </h1>
            {analyticsScope === "all" && (
              <Tag tone="accent">Admin · All traffic</Tag>
            )}
          </div>
          <p className="text-sm text-epic-text-muted mt-1">
            Explore traffic, cache efficiency, tail latency, quota pacing, and
            requests that need attention.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <ScopeSelector />
          <Select
            aria-label="API version"
            selectedKey={search.apiVersion ?? "all"}
            onSelectionChange={(key) =>
              updateSearch({
                ...search,
                apiVersion: key === "legacy" || key === "v1" ? key : undefined,
              })
            }
            className="w-40"
          >
            <SelectItem id="all">All API versions</SelectItem>
            <SelectItem id="v1">v1 only</SelectItem>
            <SelectItem id="legacy">Legacy (non-v1)</SelectItem>
          </Select>
          {analyticsScope !== "all" && (
            <Select
              aria-label="Filter by API key"
              selectedKey={search.keyId ?? "all"}
              onSelectionChange={(key) =>
                updateSearch({
                  ...search,
                  keyId: key === "all" ? undefined : String(key),
                })
              }
              className="w-44"
            >
              {keyOptions.map((k) => (
                <SelectItem key={k.id} id={k.id}>
                  {k.label}
                </SelectItem>
              ))}
            </Select>
          )}
          <Select
            aria-label="Status class"
            selectedKey={search.statusClass ?? "all"}
            onSelectionChange={(key) =>
              updateSearch({
                ...search,
                statusClass:
                  key === "all" ? undefined : (String(key) as StatusClassFilter),
              })
            }
            className="w-36"
          >
            <SelectItem id="all">All statuses</SelectItem>
            <SelectItem id="2xx">2xx Success</SelectItem>
            <SelectItem id="3xx">3xx Redirect</SelectItem>
            <SelectItem id="4xx">4xx Client</SelectItem>
            <SelectItem id="5xx">5xx Server</SelectItem>
          </Select>
          <Select
            aria-label="Cache filter"
            selectedKey={search.cacheStatus ?? "all"}
            onSelectionChange={(key) =>
              updateSearch({
                ...search,
                cacheStatus: key === "all" ? undefined : String(key),
              })
            }
            className="w-36"
          >
            <SelectItem id="all">All cache</SelectItem>
            <SelectItem id="HIT">Cache HIT</SelectItem>
            <SelectItem id="MISS">Cache MISS</SelectItem>
            <SelectItem id="REVALIDATED">Revalidated</SelectItem>
            <SelectItem id="DYNAMIC">Dynamic</SelectItem>
            <SelectItem id="EDGE_BLOCK">Edge block</SelectItem>
          </Select>
          <Select
            aria-label="Time range"
            selectedKey={rangeKey}
            onSelectionChange={(key) =>
              updateSearch({
                ...search,
                range: String(key) as z.infer<typeof searchSchema>["range"],
                start: undefined,
                end: undefined,
              })
            }
            className="w-40"
          >
            {[
              { id: "1", label: "Last 1 hour" },
              { id: "6", label: "Last 6 hours" },
              { id: "24", label: "Last 24 hours" },
              { id: "168", label: "Last 7 days" },
              { id: "720", label: "Last 30 days" },
              { id: "month", label: "This month (UTC)" },
            ].map((r) => (
              <SelectItem key={r.id} id={r.id}>
                {r.label}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap justify-between gap-3 items-center">
        <div className="flex flex-wrap items-center gap-2 text-xs text-epic-text-muted">
          {analyticsScope === "all" ? (
            <span>
              Recorded gateway traffic, including legacy requests without API
              keys
            </span>
          ) : (
            <span>
              Project allowance: {quota.toLocaleString()} requests/min shared by
              all keys
            </span>
          )}
          {activeChips.map((chip) => (
            <Button
              key={chip.label}
              size="sm"
              variant="secondary"
              onPress={chip.onClear}
            >
              {chip.label}
              <X className="w-3 h-3" />
            </Button>
          ))}
          {activeChips.length > 1 && (
            <Button
              size="sm"
              variant="quiet"
              onPress={() =>
                updateSearch({
                  range: search.range,
                  projectId:
                    analyticsScope === "all" ? undefined : search.projectId,
                })
              }
            >
              <RotateCcw className="w-3 h-3" />
              Clear all
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {analyticsScope !== "all" && !search.keyId && (
            <Switch
              isSelected={Boolean(search.excludeConsole)}
              onChange={(selected) =>
                updateSearch({
                  ...search,
                  excludeConsole: selected ? true : undefined,
                })
              }
            >
              Exclude API Console
            </Switch>
          )}
          <Switch isSelected={autoRefresh} onChange={setAutoRefresh}>
            Auto-refresh · 30s
          </Switch>
          <Freshness
            updatedAt={result.updatedAt}
            loading={result.loading}
            onRefresh={result.refresh}
          />
        </div>
      </div>

      {analyticsScope !== "all" && (
        <MonthlyQuotaPanel
          refreshKey={result.refreshKey}
          onStatusLoaded={setMonthlyQuota}
        />
      )}
      <UsageError
        message={result.error}
        retry={result.refresh}
        stale={Boolean(data)}
      />
      {!data && result.loading && <UsageLoading />}
      {!data && !result.loading && !result.error && (
        <p className="text-sm text-epic-text-muted">
          Select a project to view usage.
        </p>
      )}
      {data && (
        <>
          <Coverage data={data} />
          <UsageInsightsPanel insights={insights} />
          <UsageMetricsStrip data={data} />
          <UsageChart
            data={data}
            rpmLimit={analyticsScope !== "all" ? quota : null}
            limit={
              rangeKey === "month" &&
              analyticsScope !== "all" &&
              selectedProject?.tier === "free"
                ? monthlyQuota?.allowance ?? null
                : null
            }
            limitLabel="Monthly free quota"
            onZoomRange={(startIso, endIso) =>
              updateSearch({ ...search, start: startIso, end: endIso })
            }
          />
          <div className="grid lg:grid-cols-2 gap-6">
            <UsageChart
              data={data}
              kind="latency"
              onZoomRange={(startIso, endIso) =>
                updateSearch({ ...search, start: startIso, end: endIso })
              }
            />
            <UsageChart
              data={data}
              kind="errors"
              onZoomRange={(startIso, endIso) =>
                updateSearch({ ...search, start: startIso, end: endIso })
              }
            />
          </div>
          <div className="grid lg:grid-cols-2 gap-6">
            <CacheEfficiencyChart data={data} />
            <LatencyDistributionChart data={data} />
          </div>
          <UsageBreakdowns
            data={data}
            activeFilters={{
              statusCode: search.statusCode,
              cacheStatus: search.cacheStatus,
              limitOutcome: search.limitOutcome,
              country: search.country,
              clientCategory: search.clientCategory,
              policyFamily: search.policyFamily,
            }}
            onToggleFilter={(key, value) => toggleFilter(key, value)}
          />
          {analyticsScope === "all" ? (
            <div className="grid lg:grid-cols-4 gap-4">
              <RankedList
                title="Busiest applications"
                rows={data.projects}
                onSelect={(row) => drilldown("projects", row)}
              />
              <RankedList
                title="Keys hitting limits"
                rows={throttledKeys}
                metric="rateLimited"
                onSelect={(row) => drilldown("keys", row)}
                empty="No keys reached their limit."
              />
              <RankedList
                title="Endpoints hitting limits"
                rows={throttledEndpoints}
                metric="rateLimited"
                onSelect={(row) => drilldown("endpoints", row)}
                empty="No endpoints were rate limited."
              />
              <RankedList
                title="Slowest endpoints (p95)"
                rows={slowestEndpoints}
                metric="p95LatencyMs"
                onSelect={(row) => drilldown("endpoints", row)}
                empty="No latency data recorded."
              />
            </div>
          ) : (
            <div className="grid lg:grid-cols-3 gap-4">
              <RankedList
                title="Busiest endpoints"
                rows={busiestEndpoints}
                onSelect={(row) => drilldown("endpoints", row)}
                empty="No endpoint traffic yet."
              />
              <RankedList
                title="Slowest endpoints (p95)"
                rows={slowestEndpoints}
                metric="p95LatencyMs"
                onSelect={(row) => drilldown("endpoints", row)}
                empty="No latency data yet."
              />
              <RankedList
                title="Endpoints with errors"
                rows={errorEndpoints}
                metric="errors"
                onSelect={(row) => drilldown("endpoints", row)}
                empty="No errors recorded in this window."
              />
            </div>
          )}
          <UsageTable
            filters={{ ...filters, end: data.end }}
            total={data.totals.requests}
            onDrilldown={drilldown}
          />
        </>
      )}
      {search.route && (
        <EndpointDetail
          filters={{
            ...filters,
            end: data?.end,
            route: search.route,
            method: search.method,
          }}
          endpointMeta={
            busiestEndpoints.find(
              (r) =>
                r.route === search.route &&
                (!search.method || r.method === search.method),
            ) ??
            data?.endpoints.find(
              (r) =>
                r.route === search.route &&
                (!search.method || r.method === search.method),
            )
          }
          onClose={() =>
            updateSearch({ ...search, route: undefined, method: undefined })
          }
          onDrilldown={drilldown}
        />
      )}
    </div>
  );
}

function EndpointDetail({
  filters,
  endpointMeta,
  onClose,
  onDrilldown,
}: {
  filters: UsageFilters;
  endpointMeta?: UsageRow;
  onClose: () => void;
  onDrilldown: (dimension: UsageDimension, row: UsageRow) => void;
}) {
  const result = useUsage(filters);
  const data = result.data;
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="xl"
      className="!max-w-5xl"
    >
      <Dialog>
        <div className="flex justify-between gap-4 items-start mb-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Heading
                slot="title"
                className="text-lg font-semibold text-white break-all"
              >
                {filters.method} {filters.route}
              </Heading>
              {endpointMeta?.operationId && (
                <Tag tone="accent">{endpointMeta.operationId}</Tag>
              )}
              {endpointMeta?.scope && (
                <Tag tone="neutral">{endpointMeta.scope}</Tag>
              )}
              {endpointMeta?.expensive && (
                <Tag tone="warning">{endpointMeta.expensive}</Tag>
              )}
            </div>
            <p className="text-xs text-epic-text-muted mt-1">
              Endpoint detail · Last {filters.hours} hours ·{" "}
              {filters.projectId
                ? (data?.projects.find((p) => p.projectId === filters.projectId)
                    ?.label ?? filters.projectId)
                : filters.scope === "all"
                  ? "All traffic"
                  : "Current project"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/docs"
              className={buttonStyles({ variant: "secondary", size: "sm" })}
            >
              <BookOpen className="w-3.5 h-3.5" />
              API Docs
            </Link>
            <Link
              to="/alerts"
              className={buttonStyles({ variant: "secondary", size: "sm" })}
            >
              <Bell className="w-3.5 h-3.5" />
              Alerts
            </Link>
            <Button
              variant="quiet"
              aria-label="Close endpoint detail"
              onPress={onClose}
            >
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>
        <div className="space-y-5">
          <UsageError message={result.error} retry={result.refresh} />
          {!data && result.loading && <UsageLoading />}
          {data && (
            <>
              <Coverage data={data} />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Metric
                  label="Requests"
                  value={data.totals.requests.toLocaleString()}
                  sub={`${data.totals.cacheHitRate}% cached`}
                />
                <Metric
                  label="Error rate"
                  value={`${data.totals.errorRate}%`}
                  color={data.totals.errors ? "text-epic-danger" : "text-white"}
                  sub={`${data.totals.errors.toLocaleString()} total errors`}
                />
                <Metric
                  label="Rate limited"
                  value={String(data.totals.rateLimited)}
                  color="text-epic-warning"
                  sub={`${data.totals.blockedPolicy} policy denied`}
                />
                <Metric
                  label="p95 / p99 latency"
                  value={`${data.totals.p95LatencyMs} ms`}
                  color="text-epic-accent"
                  sub={`p50 ${data.totals.p50LatencyMs} ms · p99 ${data.totals.p99LatencyMs} ms`}
                />
              </div>
              <UsageChart data={data} compact />
              <div className="grid md:grid-cols-2 gap-4">
                <UsageChart data={data} kind="latency" compact />
                <UsageChart data={data} kind="errors" compact />
              </div>
              <UsageBreakdowns data={data} />
              <UsageTable
                filters={{ ...filters, end: data.end }}
                total={data.totals.requests}
                initialDimension={filters.scope === "all" ? "projects" : "keys"}
                onDrilldown={onDrilldown}
              />
            </>
          )}
        </div>
      </Dialog>
    </Modal>
  );
}
