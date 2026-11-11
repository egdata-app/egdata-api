import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState, useRef } from "react";
import { EndpointHistory } from "../components/EndpointHistory";
import { apiFetch } from "../lib/api";
import { getInbox, notifyAlertsChanged, type Inbox } from "../lib/alerts";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/alerts")({
  validateSearch: (search: Record<string, unknown>): { endpoint?: string } => ({
    endpoint: typeof search.endpoint === "string" ? search.endpoint : undefined,
  }),
  component: AlertsPage,
});

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
    <p>Select a project to view its alerts.</p>
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
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap gap-4 justify-between">
        <div>
          <h1 className="text-3xl font-bold">Alerts</h1>
          <p className="text-epic-text-muted mt-2">
            Changes to v1 endpoints used by this project’s keys during the 30
            UTC dates ending on each merge date.
          </p>
        </div>
        <button
          disabled={!data || busy}
          onClick={() => void mark()}
          className="px-4 py-2 border border-epic-border rounded-lg disabled:opacity-50"
        >
          Mark all read ({data?.unread ?? "…"})
        </button>
      </header>
      <p className="text-epic-warning">Merged; deployment not verified.</p>
      {data && (
        <div className="border border-epic-border rounded-xl p-4 text-sm space-y-2">
          <p>
            {data.trackingStartedAt
              ? `Tracking began ${data.trackingStartedAt}. No earlier usage is inferred.`
              : "Usage tracking has not started. No historical usage is fabricated."}
          </p>
          {!data.trackingEnabled && (
            <p className="text-epic-warning">Usage capture is disabled.</p>
          )}
          {data.trackingDegraded && (
            <p role="status" className="text-epic-warning">
              Usage delivery is degraded. Relevant alerts may be delayed; an
              empty inbox does not establish no impact.
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-3 items-center">
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            checked={unread}
            onChange={(e) => setUnread(e.target.checked)}
          />
          Unread only
        </label>
        <input
          aria-label="Filter by operation ID"
          className="bg-epic-elevated border border-epic-border rounded-lg p-2"
          placeholder="Endpoint operation ID"
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
        />
        <select
          aria-label="Change type"
          className="bg-epic-elevated rounded-lg p-2"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">All change types</option>
          {[
            "added",
            "changed",
            "fixed",
            "deprecated",
            "removed",
            "security",
          ].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select
          aria-label="Compatibility"
          className="bg-epic-elevated rounded-lg p-2"
          value={compatibility}
          onChange={(e) => setCompatibility(e.target.value)}
        >
          <option value="">All compatibility</option>
          <option>compatible</option>
          <option>breaking</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="text-epic-warning">
          {error}
        </p>
      )}
      {busy && <p role="status">Loading alerts…</p>}
      {data?.alerts.map((alert) => (
        <section key={alert.record.id} className="space-y-3">
          <div className="flex flex-wrap gap-3 items-center">
            <span
              className={
                alert.read
                  ? "text-epic-text-muted"
                  : "text-epic-accent font-semibold"
              }
            >
              {alert.read ? "Read" : "Unread"}
            </span>
            {!alert.read && (
              <button
                className="text-epic-accent"
                disabled={busy}
                onClick={() => void mark(alert.record.id)}
              >
                Mark read
              </button>
            )}
          </div>
          <EndpointHistory entries={[alert]} />
          <div className="text-sm flex flex-wrap gap-3">
            {[...new Set(alert.matches.map((m) => m.operation_id))].map(
              (id) => (
                <Link
                  key={id}
                  className="text-epic-accent"
                  to="/docs/$operationId"
                  params={{ operationId: id }}
                >
                  {id}
                </Link>
              ),
            )}
            {[...new Set(alert.matches.map((m) => m.key_id))].map((id) => (
              <a
                key={id}
                className="text-epic-accent"
                href={
                  id.startsWith("console_")
                    ? "/docs"
                    : `/keys?keyId=${encodeURIComponent(id)}`
                }
              >
                {id.startsWith("console_") ? "API console" : `Key ${id}`}
              </a>
            ))}
          </div>
        </section>
      ))}
      {data && !data.alerts.length && !busy && (
        <p className="p-8 border border-epic-border rounded-xl text-epic-text-muted">
          No matching alerts. Alerts persist after qualifying usage ages out.
          Undated historical notes never generate alerts.
        </p>
      )}
      {data?.nextBefore && (
        <button
          className="text-epic-accent"
          disabled={busy}
          onClick={() => void load(data.nextBefore!)}
        >
          Load more alerts
        </button>
      )}
    </div>
  );
}
