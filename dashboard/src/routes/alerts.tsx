import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bell,
  BookOpen,
  CheckCheck,
  Clock,
  Info,
  KeyRound,
  RotateCcw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EndpointHistory } from "../components/EndpointHistory";
import { Button } from "../components/ui/Button";
import { Switch, Tag } from "../components/ui/Controls";
import { Input } from "../components/ui/Field";
import { Select, SelectItem } from "../components/ui/Select";
import { getInbox, type Inbox, notifyAlertsChanged } from "../lib/alerts";
import { apiFetch } from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/alerts")({
  validateSearch: (search: Record<string, unknown>): { endpoint?: string } => ({
    endpoint: typeof search.endpoint === "string" ? search.endpoint : undefined,
  }),
  component: AlertsPage,
});

const CHANGE_TYPE_OPTIONS = [
  { id: "all", label: "All change types" },
  { id: "added", label: "Added" },
  { id: "changed", label: "Changed" },
  { id: "fixed", label: "Fixed" },
  { id: "deprecated", label: "Deprecated" },
  { id: "removed", label: "Removed" },
  { id: "security", label: "Security" },
];

const COMPATIBILITY_OPTIONS = [
  { id: "all", label: "All compatibility" },
  { id: "compatible", label: "Compatible" },
  { id: "breaking", label: "Breaking" },
];

function AlertsPage() {
  const { selectedProject } = useDashboardAuth();
  const { endpoint } = Route.useSearch();
  return selectedProject ? (
    <ProjectInbox
      key={`${selectedProject.id}:${endpoint}`}
      projectId={selectedProject.id}
      endpoint={endpoint}
    />
  ) : (
    <div className="bg-epic-surface border border-dashed border-epic-border rounded-xl py-12 px-4 text-center space-y-2">
      <Bell className="w-8 h-8 text-epic-text-muted mx-auto" />
      <p className="text-sm font-medium text-epic-text">
        Select a project to view its alerts.
      </p>
    </div>
  );
}

function ProjectInbox({
  projectId,
  endpoint,
}: {
  projectId: string;
  endpoint?: string;
}) {
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(false);
  const [operation, setOperation] = useState(endpoint ?? "");
  const [type, setType] = useState("");
  const [compatibility, setCompatibility] = useState("");
  const generation = useRef(0);

  const hasFilters = Boolean(unread || operation || type || compatibility);

  const load = useCallback(
    async (before?: number) => {
      const request = ++generation.current;
      setBusy(true);
      setError("");
      try {
        const result = await getInbox(projectId, {
          ...(unread ? { unread: "true" } : {}),
          ...(operation ? { endpoint: operation } : {}),
          ...(type ? { type } : {}),
          ...(compatibility ? { compatibility } : {}),
          ...(before ? { before: String(before) } : {}),
        });
        if (request !== generation.current) return;
        setData((previous) =>
          before && previous
            ? {
                ...result,
                cutoffToken: previous.cutoffToken,
                alerts: [...previous.alerts, ...result.alerts],
              }
            : result,
        );
      } catch (e) {
        if (request !== generation.current) return;
        setError(e instanceof Error ? e.message : "Alerts unavailable");
      } finally {
        if (request === generation.current) setBusy(false);
      }
    },
    [projectId, unread, operation, type, compatibility],
  );

  useEffect(() => {
    let active = true;
    setData(null);
    const timer = setTimeout(() => {
      if (active) void load();
    }, 0);
    return () => {
      active = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [load]);

  async function mark(recordId?: string) {
    if (!data) return;
    setBusy(true);
    try {
      await apiFetch(
        `/alerts/${encodeURIComponent(projectId)}/${recordId ? `${encodeURIComponent(recordId)}/read` : "read-all"}`,
        {
          method: "POST",
          body: JSON.stringify(
            recordId ? {} : { cutoffToken: data.cutoffToken },
          ),
        },
      );
      notifyAlertsChanged();
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Read state could not be saved",
      );
    } finally {
      setBusy(false);
    }
  }

  function resetFilters() {
    setUnread(false);
    setOperation("");
    setType("");
    setCompatibility("");
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Alerts
            </h1>
            <Tag tone="warning">
              <AlertTriangle className="w-3 h-3" />
              Merged; deployment not verified
            </Tag>
            {data && data.unread > 0 && (
              <Tag tone="accent">{data.unread} unread</Tag>
            )}
          </div>
          <p className="text-sm text-epic-text-muted">
            Changes to v1 endpoints used by this project’s keys during the 30
            UTC dates ending on each merge date.
          </p>
        </div>
        <Button
          variant="secondary"
          isDisabled={!data || busy || data.unread === 0}
          onPress={() => void mark()}
        >
          <CheckCheck className="w-4 h-4" />
          Mark all read ({data?.unread ?? "…"})
        </Button>
      </header>

      {/* Tracking Status Surface */}
      {data && (
        <div className="bg-epic-surface border border-epic-border rounded-xl p-4 space-y-2.5 text-xs">
          <div className="flex items-start gap-2.5 text-epic-text-muted">
            {data.trackingStartedAt ? (
              <Clock className="w-4 h-4 text-epic-accent shrink-0 mt-0.5" />
            ) : (
              <Info className="w-4 h-4 text-epic-text-muted shrink-0 mt-0.5" />
            )}
            <p className="leading-relaxed">
              {data.trackingStartedAt ? (
                <>
                  Tracking began{" "}
                  <code className="font-mono text-epic-text">
                    {data.trackingStartedAt}
                  </code>
                  . No earlier usage is inferred.
                </>
              ) : (
                "Usage tracking has not started. No historical usage is fabricated."
              )}
            </p>
          </div>
          {!data.trackingEnabled && (
            <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-epic-warning/10 border border-epic-warning/25 text-epic-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>Usage capture is disabled.</p>
            </div>
          )}
          {data.trackingDegraded && (
            <output className="flex items-start gap-2.5 p-2.5 rounded-lg bg-epic-warning/10 border border-epic-warning/25 text-epic-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Usage delivery is degraded. Relevant alerts may be delayed; an
                empty inbox does not establish no impact.
              </span>
            </output>
          )}
        </div>
      )}

      {/* Filter Toolbar Surface */}
      <div className="bg-epic-surface border border-epic-border rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-0">
          <div className="relative flex-1 min-w-52 max-w-xs">
            <Search
              aria-hidden
              className="w-4 h-4 text-epic-text-muted pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            />
            <Input
              aria-label="Filter by operation ID"
              className="w-full pl-9 font-mono text-xs"
              placeholder="Endpoint operation ID"
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
            />
          </div>

          <Select
            aria-label="Change type"
            selectedKey={type || "all"}
            onSelectionChange={(key) =>
              key !== null && setType(key === "all" ? "" : String(key))
            }
            items={CHANGE_TYPE_OPTIONS}
            className="w-44"
          >
            {(item) => (
              <SelectItem id={item.id} textValue={item.label}>
                {item.label}
              </SelectItem>
            )}
          </Select>

          <Select
            aria-label="Compatibility"
            selectedKey={compatibility || "all"}
            onSelectionChange={(key) =>
              key !== null && setCompatibility(key === "all" ? "" : String(key))
            }
            items={COMPATIBILITY_OPTIONS}
            className="w-44"
          >
            {(item) => (
              <SelectItem id={item.id} textValue={item.label}>
                {item.label}
              </SelectItem>
            )}
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {hasFilters && (
            <Button variant="quiet" size="sm" onPress={resetFilters}>
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </Button>
          )}
          <div className="pl-3 border-l border-epic-border">
            <Switch isSelected={unread} onChange={setUnread}>
              Unread only
            </Switch>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-3.5 rounded-xl bg-epic-danger/15 border border-epic-danger/30 text-xs text-epic-danger"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading Indicator */}
      {busy && !data && (
        <output className="block bg-epic-surface border border-epic-border rounded-xl py-12 px-4">
          <span className="flex items-center justify-center gap-2.5 text-sm text-epic-text-muted">
            <span className="w-4 h-4 rounded-full border-2 border-epic-accent border-t-transparent motion-safe:animate-spin" />
            Loading alerts…
          </span>
        </output>
      )}

      {/* Alerts List */}
      {data?.alerts.map((alert) => {
        const operationIds = [
          ...new Set(alert.matches.map((m) => m.operation_id)),
        ];
        const keyIds = [...new Set(alert.matches.map((m) => m.key_id))];

        return (
          <section
            key={alert.record.id}
            className={`rounded-xl border bg-epic-surface overflow-hidden transition-colors ${
              alert.read
                ? "border-epic-border"
                : "border-epic-accent/45 shadow-lg shadow-epic-accent/5"
            }`}
          >
            {/* Status Header Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 bg-epic-elevated/60 border-b border-epic-border">
              <div className="flex items-center gap-2.5">
                {!alert.read && (
                  <span
                    aria-hidden
                    className="w-2 h-2 rounded-full bg-epic-accent shadow-[0_0_8px_var(--color-epic-accent)]"
                  />
                )}
                <Tag tone={alert.read ? "neutral" : "accent"}>
                  {alert.read ? "Read" : "Unread"}
                </Tag>
                <span className="text-xs font-mono text-epic-text-muted">
                  {alert.record.id}
                </span>
              </div>
              {!alert.read && (
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={busy}
                  onPress={() => void mark(alert.record.id)}
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  Mark read
                </Button>
              )}
            </div>

            {/* Record Body */}
            <div className="p-5">
              <EndpointHistory entries={[alert]} embedded />
            </div>

            {/* Matched Operations & Keys Footer */}
            <div className="px-5 py-3 bg-epic-bg/50 border-t border-epic-border flex flex-wrap items-center gap-2 text-xs">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-epic-text-muted mr-1">
                Matched usage
              </span>
              {operationIds.map((id) => (
                <Link
                  key={id}
                  className="inline-flex items-center gap-1.5 font-mono text-xs px-2.5 py-1 rounded-md bg-epic-elevated hover:bg-epic-hover text-epic-accent border border-epic-border hover:border-epic-border-hover transition-colors"
                  to="/docs/$slug"
                  params={{ slug: id }}
                >
                  <BookOpen className="w-3 h-3" />
                  {id}
                </Link>
              ))}
              {keyIds.map((id) => (
                <Link
                  key={id}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-epic-elevated hover:bg-epic-hover text-epic-text hover:text-white border border-epic-border hover:border-epic-border-hover transition-colors"
                  to={id.startsWith("console_") ? "/docs" : "/keys"}
                  search={id.startsWith("console_") ? {} : { keyId: id }}
                >
                  <KeyRound className="w-3 h-3 text-epic-accent" />
                  {id.startsWith("console_") ? (
                    "API console"
                  ) : (
                    <>
                      Key <span className="font-mono">{id}</span>
                    </>
                  )}
                </Link>
              ))}
            </div>
          </section>
        );
      })}

      {/* Empty State */}
      {data && !data.alerts.length && !busy && (
        <div className="bg-epic-surface border border-epic-border rounded-xl py-12 px-6 text-center space-y-3">
          <div className="w-10 h-10 rounded-full bg-epic-elevated border border-epic-border flex items-center justify-center mx-auto">
            <Bell className="w-5 h-5 text-epic-text-muted" />
          </div>
          <div className="text-sm font-medium text-epic-text">
            No matching alerts
          </div>
          <p className="text-xs text-epic-text-muted max-w-md mx-auto leading-relaxed">
            Alerts persist after qualifying usage ages out. Undated historical
            notes never generate alerts.
          </p>
          {hasFilters && (
            <div className="pt-1">
              <Button variant="secondary" size="sm" onPress={resetFilters}>
                <RotateCcw className="w-3.5 h-3.5" />
                Clear filters
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {data?.nextBefore != null && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            isDisabled={busy}
            isPending={busy}
            onPress={() => {
              if (data.nextBefore != null) void load(data.nextBefore);
            }}
          >
            Load more alerts
          </Button>
        </div>
      )}
    </div>
  );
}
