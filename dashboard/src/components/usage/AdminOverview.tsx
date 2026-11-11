import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useUsage } from "../../lib/usage";
import { Switch, Tag } from "../ui/Controls";
import { Select, SelectItem } from "../ui/Select";
import { UsageChart } from "./UsageCharts";
import {
  Coverage,
  Freshness,
  RankedList,
  ScopeSelector,
  UsageError,
  UsageLoading,
  UsageMetricsStrip,
} from "./UsageShared";
import { UsageTable } from "./UsageTable";

export function AdminOverview() {
  const [hours, setHours] = useState("24");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const result = useUsage({ scope: "all", hours: Number(hours) }, autoRefresh);
  const data = result.data;
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Platform overview
            </h1>
            <Tag tone="accent">Admin</Tag>
          </div>
          <p className="text-sm text-epic-text-muted mt-1">
            Traffic and API health across all applications and owners.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ScopeSelector />
          <Select
            aria-label="Overview time range"
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
      <div className="flex flex-wrap justify-between items-center gap-3">
        <Link to="/analytics" className="text-sm text-epic-accent">
          Explore all usage →
        </Link>
        <div className="flex flex-wrap gap-4 items-center">
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
      {data && (
        <>
          <Coverage data={data} />
          <UsageMetricsStrip data={data} />
          <UsageChart data={data} />
          <div className="grid lg:grid-cols-3 gap-4">
            <RankedList
              title="Busiest applications"
              rows={data.projects}
              onSelect={(row) =>
                void navigate({
                  to: "/analytics",
                  search: { projectId: row.projectId },
                })
              }
            />
            <RankedList
              title="Keys hitting limits"
              rows={data.keys.filter((row) => row.rateLimited > 0)}
              metric="rateLimited"
              empty="No keys reached their limit."
              onSelect={(row) =>
                void navigate({
                  to: "/analytics",
                  search: { projectId: row.projectId, keyId: row.keyId },
                })
              }
            />
            <RankedList
              title="Endpoints hitting limits"
              rows={data.endpoints.filter((row) => row.rateLimited > 0)}
              metric="rateLimited"
              empty="No endpoints were rate limited."
              onSelect={(row) =>
                void navigate({
                  to: "/analytics",
                  search: { route: row.route, method: row.method },
                })
              }
            />
          </div>
          <UsageTable
            filters={{ hours: Number(hours), scope: "all", end: data.end }}
            total={data.totals.requests}
            initialDimension="projects"
            onDrilldown={(dimension, row) =>
              void navigate({
                to: "/analytics",
                search:
                  dimension === "endpoints"
                    ? { route: row.route, method: row.method }
                    : dimension === "keys"
                      ? { projectId: row.projectId, keyId: row.keyId }
                      : { projectId: row.projectId },
              })
            }
          />
        </>
      )}
    </div>
  );
}
