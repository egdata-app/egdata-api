import { ChevronLeft, ChevronRight, Download, Filter, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SortDescriptor } from "react-aria-components";
import {
  dashboardClient,
  type UsageDimension,
  type UsageFilters,
  type UsageRow,
  type UsageSort,
} from "../../lib/api";
import { usageCsv, useUsageTable } from "../../lib/usage";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Controls";
import { Select, SelectItem } from "../ui/Select";
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
} from "../ui/TableAndTabs";
import { TextField } from "../ui/TextField";
import { outcomeLabels, UsageError } from "./UsageShared";

const tabs: { id: UsageDimension; label: string }[] = [
  { id: "endpoints", label: "Endpoints" },
  { id: "projects", label: "Applications" },
  { id: "keys", label: "API keys" },
  { id: "statusCodes", label: "Status codes" },
  { id: "limitOutcomes", label: "Access checks" },
  { id: "cacheStatuses", label: "Cache results" },
  { id: "policies", label: "Policies" },
  { id: "origins", label: "Origin presence" },
  { id: "ips", label: "Countries" },
  { id: "userAgents", label: "Client categories" },
];
const sortable: { id: UsageSort; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "cacheHitRate", label: "Cache hit %" },
  { id: "errors", label: "Errors" },
  { id: "errorRate", label: "Error %" },
  { id: "rateLimited", label: "429s" },
  { id: "blockedPolicy", label: "Denied" },
  { id: "avgLatencyMs", label: "Avg time" },
  { id: "p95LatencyMs", label: "p95 time" },
  { id: "p99LatencyMs", label: "p99 time" },
];

export function UsageTable({
  filters,
  total,
  onDrilldown,
  initialDimension = "endpoints",
}: {
  filters: UsageFilters;
  total: number;
  onDrilldown: (dimension: UsageDimension, row: UsageRow) => void;
  initialDimension?: UsageDimension;
}) {
  const [dimension, setDimension] = useState<UsageDimension>(initialDimension);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState("");
  const [minRequests, setMinRequests] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<SortDescriptor>({
    column: "requests",
    direction: "descending",
  });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const exportController = useRef<AbortController | null>(null);
  const filterKey = JSON.stringify({
    ...filters,
    dimension,
    query,
    method,
    minRequests,
    sort,
  });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed query invalidates pagination and in-flight exports.
  useEffect(() => {
    setOffset(0);
    exportController.current?.abort();
    setExporting(false);
    setExportError(undefined);
  }, [filterKey]);
  useEffect(() => () => exportController.current?.abort(), []);
  const params = {
    ...filters,
    method: filters.method || method || undefined,
    minRequests: minRequests > 0 ? minRequests : undefined,
    dimension,
    search: query,
    sort: sort.column as UsageSort,
    direction:
      sort.direction === "ascending" ? ("asc" as const) : ("desc" as const),
    offset,
    limit: pageSize,
  };
  const result = useUsageTable(params);
  async function exportAll() {
    const controller = new AbortController();
    exportController.current?.abort();
    exportController.current = controller;
    setExporting(true);
    setExportError(undefined);
    try {
      const rows: UsageRow[] = [];
      let nextOffset = 0;
      const end = filters.end ?? result.data?.end ?? new Date().toISOString();
      while (!controller.signal.aborted) {
        const page = await dashboardClient.getUsageTable(
          { ...params, end, offset: nextOffset, limit: 100 },
          controller.signal,
        );
        rows.push(...page.rows);
        if (!page.hasMore) break;
        nextOffset += page.rows.length;
        if (nextOffset > 1_000_000 || page.rows.length === 0)
          throw new Error("Export is too large. Narrow the filters and retry.");
      }
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob(["\uFEFF", usageCsv(rows)], {
          type: "text/csv;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `egdata-usage-${dimension}-${end.slice(0, 10)}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (!controller.signal.aborted)
        setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      if (exportController.current === controller) setExporting(false);
    }
  }
  const formatRowLabel = (row: UsageRow) => {
    if (dimension === "origins" && row.label === "(direct)") {
      return "No origin provided";
    }
    if (dimension === "limitOutcomes") {
      return outcomeLabels[row.label] ?? row.label;
    }
    if (dimension === "ips" && row.label === "XX") {
      return "Unknown / Local";
    }
    return row.label;
  };
  const contents = (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end justify-between">
        <div className="flex flex-wrap gap-3 items-end">
          <TextField
            aria-label={`Search ${dimension}`}
            placeholder={`Search ${dimension === "projects" ? "app name or ID" : dimension === "keys" ? "key name or ID" : tabs.find((t) => t.id === dimension)?.label.toLowerCase() ?? dimension}…`}
            value={search}
            onChange={setSearch}
            className="w-64"
          />
          {dimension === "endpoints" && !filters.method && (
            <Select
              aria-label="HTTP method"
              selectedKey={method || "all"}
              onSelectionChange={(key) => {
                setMethod(key === "all" ? "" : String(key));
                setOffset(0);
              }}
              className="w-36"
            >
              {[
                "all",
                "GET",
                "HEAD",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "OPTIONS",
              ].map((m) => (
                <SelectItem key={m} id={m}>
                  {m === "all" ? "All methods" : m}
                </SelectItem>
              ))}
            </Select>
          )}
          <Select
            aria-label="Minimum requests"
            selectedKey={String(minRequests)}
            onSelectionChange={(key) => {
              setMinRequests(Number(key));
              setOffset(0);
            }}
            className="w-40"
          >
            <SelectItem id="0">All volumes</SelectItem>
            <SelectItem id="10">≥ 10 requests</SelectItem>
            <SelectItem id="100">≥ 100 requests</SelectItem>
            <SelectItem id="1000">≥ 1,000 requests</SelectItem>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            isDisabled={exporting || !result.data || result.loading}
            onPress={() => void exportAll()}
          >
            <Download className="w-4 h-4" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          {exporting && (
            <Button
              variant="quiet"
              onPress={() => {
                exportController.current?.abort();
                setExporting(false);
              }}
            >
              <X className="w-3 h-3" />
              Cancel export
            </Button>
          )}
        </div>
      </div>
      <UsageError
        message={result.error ?? exportError}
        retry={exportError ? () => void exportAll() : result.refresh}
        stale={Boolean(result.data)}
      />
      <div aria-busy={result.loading}>
        <Table
          aria-label={`${tabs.find((t) => t.id === dimension)?.label} usage`}
          sortDescriptor={sort}
          onSortChange={(value) => {
            setSort(value);
            setOffset(0);
          }}
        >
          <TableHeader>
            <Column id="label" isRowHeader allowsSorting>
              {tabs.find((t) => t.id === dimension)?.label}
            </Column>
            {sortable.map((col) => (
              <Column key={col.id} id={col.id} allowsSorting>
                {col.label}
              </Column>
            ))}
          </TableHeader>
          <TableBody
            items={result.data?.rows ?? []}
            renderEmptyState={() => (
              <div className="py-10 text-xs text-epic-text-muted">
                {result.loading
                  ? "Loading breakdown…"
                  : result.error
                    ? "Usage could not be loaded."
                    : "No requests match these filters. Try a wider range, lower the min-requests threshold, or clear the search."}
              </div>
            )}
          >
            {(row) => (
              <Row id={row.id}>
                <Cell>
                  <div className="min-w-48 max-w-80">
                    <Button
                      variant="quiet"
                      className="!p-0 !min-h-0 text-left max-w-full group/btn"
                      onPress={() => onDrilldown(dimension, row)}
                    >
                      {row.method && <Tag tone="accent">{row.method}</Tag>}
                      <span
                        className="truncate font-mono text-xs group-hover/btn:text-epic-accent transition-colors"
                        title={row.label}
                      >
                        {formatRowLabel(row)}
                      </span>
                      {!["endpoints", "projects", "keys"].includes(dimension) && (
                        <Filter className="w-3 h-3 text-epic-text-muted opacity-0 group-hover/btn:opacity-100 shrink-0" />
                      )}
                    </Button>
                    {dimension === "endpoints" &&
                      (row.operationId || row.expensive) && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {row.operationId && (
                            <span className="text-[10px] font-mono text-epic-text-muted">
                              {row.operationId}
                            </span>
                          )}
                          {row.expensive && (
                            <Tag tone="warning">{row.expensive}</Tag>
                          )}
                        </div>
                      )}
                    {row.detail && dimension !== "endpoints" && (
                      <span
                        className="block text-[11px] text-epic-text-muted truncate mt-1"
                        title={row.detail}
                      >
                        {row.detail}
                      </span>
                    )}
                  </div>
                </Cell>
                <Cell className="font-mono text-xs tabular-nums">
                  <div>{row.requests.toLocaleString()}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="h-1 w-12 rounded-full bg-epic-bg overflow-hidden">
                      <div
                        className="h-full bg-epic-accent"
                        style={{
                          width: `${total ? Math.min(100, (row.requests / total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-epic-text-muted">
                      {total ? ((row.requests / total) * 100).toFixed(1) : 0}%
                    </span>
                  </div>
                </Cell>
                <Cell className="font-mono text-xs text-epic-success">
                  {row.cacheHitRate}%
                </Cell>
                <Cell
                  className={`font-mono text-xs ${row.errors ? "text-epic-danger" : "text-epic-text-muted"}`}
                >
                  {row.errors.toLocaleString()}
                </Cell>
                <Cell
                  className={`font-mono text-xs ${row.errors ? "text-epic-danger" : "text-epic-text-muted"}`}
                >
                  {row.errorRate}%
                </Cell>
                <Cell
                  className={`font-mono text-xs ${row.rateLimited ? "text-epic-warning" : "text-epic-text-muted"}`}
                >
                  {row.rateLimited.toLocaleString()}
                </Cell>
                <Cell className="font-mono text-xs">
                  {row.blockedPolicy.toLocaleString()}
                </Cell>
                <Cell className="font-mono text-xs whitespace-nowrap">
                  <div>{row.avgLatencyMs} ms</div>
                  <div className="text-[10px] text-epic-text-muted">
                    p50 {row.p50LatencyMs} ms
                  </div>
                </Cell>
                <Cell className="font-mono text-xs whitespace-nowrap text-epic-accent">
                  {row.p95LatencyMs} ms
                </Cell>
                <Cell className="font-mono text-xs whitespace-nowrap text-epic-text-muted">
                  {row.p99LatencyMs} ms
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap justify-between items-center gap-3 text-xs text-epic-text-muted">
        <span>
          {result.loading
            ? "Updating…"
            : result.data?.rows.length
              ? `Rows ${offset + 1}–${offset + result.data.rows.length}`
              : "0 rows"}{" "}
          · Share of selected scope · 429s are included in error % · Click a
          row to drill down or filter
        </span>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Rows per page"
            selectedKey={String(pageSize)}
            onSelectionChange={(key) => {
              setPageSize(Number(key));
              setOffset(0);
            }}
            className="w-40"
          >
            {[10, 25, 50, 100].map((n) => (
              <SelectItem key={n} id={String(n)}>
                {n} rows
              </SelectItem>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Previous page"
            isDisabled={offset === 0 || result.loading}
            onPress={() => setOffset((n) => Math.max(0, n - pageSize))}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Next page"
            isDisabled={!result.data?.hasMore || result.loading}
            onPress={() => setOffset((n) => n + pageSize)}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
  return (
    <Tabs
      selectedKey={dimension}
      onSelectionChange={(key) => {
        setDimension(key as UsageDimension);
        setOffset(0);
        setSearch("");
        setQuery("");
        setMethod("");
        exportController.current?.abort();
        setExporting(false);
      }}
    >
      <TabList aria-label="Usage breakdown">
        {tabs.map((tab) => (
          <Tab key={tab.id} id={tab.id} className="shrink-0 whitespace-nowrap">
            {tab.label}
          </Tab>
        ))}
      </TabList>
      {tabs.map((tab) => (
        <TabPanel key={tab.id} id={tab.id}>
          {dimension === tab.id ? contents : null}
        </TabPanel>
      ))}
    </Tabs>
  );
}
