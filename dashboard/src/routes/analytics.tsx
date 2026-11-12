import { createFileRoute } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "../components/ui/Button";
import { Switch, Tag } from "../components/ui/Controls";
import { Dialog, Heading, Modal } from "../components/ui/Modal";
import { Select, SelectItem } from "../components/ui/Select";
import { UsageChart } from "../components/usage/UsageCharts";
import {
  Coverage,
  Freshness,
  Metric,
  RankedList,
  ScopeSelector,
  UsageBreakdowns,
  UsageError,
  UsageLoading,
  UsageMetricsStrip,
} from "../components/usage/UsageShared";
import { UsageTable } from "../components/usage/UsageTable";
import {
  type DashboardApiKey,
  dashboardClient,
  type UsageDimension,
  type UsageFilters,
  type UsageRow,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";
import { useUsage } from "../lib/usage";

const searchSchema = z.object({
  apiVersion: z.enum(["all", "legacy", "v1"]).optional(),
  projectId: z.string().optional(),
  keyId: z.string().optional(),
  route: z.string().optional(),
  method: z.string().optional(),
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

function UsagePage() {
  const { selectedProject, analyticsScope } = useDashboardAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [hours, setHours] = useState("24");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const projectId =
    analyticsScope === "all" ? search.projectId : selectedProject?.id;
  const filters: UsageFilters = {
    hours: Number(hours),
    scope: analyticsScope,
    apiVersion: analyticsScope === "all" ? search.apiVersion : undefined,
    projectId,
    keyId: search.keyId,
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
    void navigate({ search: next });
  };
  function drilldown(dimension: UsageDimension, row: UsageRow) {
    if (dimension === "endpoints")
      updateSearch({ ...search, route: row.route, method: row.method });
    if (dimension === "projects")
      updateSearch({ ...search, projectId: row.projectId, keyId: undefined });
    if (dimension === "keys")
      updateSearch({ ...search, projectId: row.projectId, keyId: row.keyId });
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
      : selectedProject?.tier === "pro"
        ? 1200
        : 120);
  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Usage
            </h1>
            {analyticsScope === "all" && (
              <Tag tone="accent">Admin · All traffic</Tag>
            )}
          </div>
          <p className="text-sm text-epic-text-muted mt-1">
            Explore traffic, response times, and requests that need attention.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <ScopeSelector />
          {analyticsScope === "all" && (
            <Select
              aria-label="API version"
              selectedKey={search.apiVersion ?? "all"}
              onSelectionChange={(key) =>
                updateSearch({
                  apiVersion: key === "legacy" || key === "v1" ? key : "all",
                })
              }
              className="w-40"
            >
              <SelectItem id="all">All API versions</SelectItem>
              <SelectItem id="legacy">Legacy (non-v1)</SelectItem>
              <SelectItem id="v1">v1</SelectItem>
            </Select>
          )}
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
            aria-label="Time range"
            selectedKey={hours}
            onSelectionChange={(key) => setHours(String(key))}
            className="w-40"
          >
            {[
              { id: "6", label: "Last 6 hours" },
              { id: "24", label: "Last 24 hours" },
              { id: "168", label: "Last 7 days" },
              { id: "720", label: "Last 30 days" },
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
              Project default: {quota.toLocaleString()} requests/min per key
            </span>
          )}
          {analyticsScope === "all" && search.projectId && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => updateSearch({ apiVersion: search.apiVersion })}
            >
              App:{" "}
              {data?.projects.find((p) => p.projectId === search.projectId)
                ?.label ?? search.projectId}
              <X className="w-3 h-3" />
            </Button>
          )}
          {search.keyId && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => updateSearch({ ...search, keyId: undefined })}
            >
              Key:{" "}
              {data?.keys.find((k) => k.keyId === search.keyId)?.label ??
                search.keyId}
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
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
          <UsageMetricsStrip data={data} />
          <UsageChart data={data} />
          <div className="grid lg:grid-cols-2 gap-6">
            <UsageChart data={data} kind="latency" />
            <UsageChart data={data} kind="errors" />
          </div>
          <UsageBreakdowns data={data} />
          {analyticsScope === "all" && (
            <div className="grid lg:grid-cols-3 gap-4">
              <RankedList
                title="Busiest applications"
                rows={data.projects}
                onSelect={(row) => drilldown("projects", row)}
              />
              <RankedList
                title="Keys hitting limits"
                rows={data.keys.filter((r) => r.rateLimited > 0)}
                metric="rateLimited"
                onSelect={(row) => drilldown("keys", row)}
                empty="No keys reached their limit."
              />
              <RankedList
                title="Endpoints hitting limits"
                rows={data.endpoints.filter((r) => r.rateLimited > 0)}
                metric="rateLimited"
                onSelect={(row) => drilldown("endpoints", row)}
                empty="No endpoints were rate limited."
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
  onClose,
  onDrilldown,
}: {
  filters: UsageFilters;
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
            <Heading
              slot="title"
              className="text-lg font-semibold text-white break-all"
            >
              {filters.method} {filters.route}
            </Heading>
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
          <Button
            variant="quiet"
            aria-label="Close endpoint detail"
            onPress={onClose}
          >
            <X className="w-5 h-5" />
          </Button>
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
                />
                <Metric
                  label="Error rate"
                  value={`${data.totals.errorRate}%`}
                />
                <Metric
                  label="Rate limited"
                  value={String(data.totals.rateLimited)}
                />
                <Metric
                  label="p95 processing time"
                  value={`${data.totals.p95LatencyMs} ms`}
                />
              </div>
              <UsageChart data={data} compact />
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
