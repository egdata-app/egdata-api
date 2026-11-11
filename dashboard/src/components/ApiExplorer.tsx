import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  History as HistoryIcon,
  Info,
  Layers,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { OpenAPIV3 } from "openapi-types";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDashboardAuth } from "../lib/auth-context";
import { type ConsoleSession, useConsoleSession } from "../lib/console-session";
import {
  type ApiDocument,
  executable,
  executeOperation,
  groupOperationsByResource,
  type Operation,
  type OperationGroup,
  operationReference,
  operations,
  redactedSnippet,
  safeDocument,
  type TryResult,
} from "../lib/explorer";
import { EndpointHistory, type MergedRecord } from "./EndpointHistory";
import { Button, buttonStyles } from "./ui/Button";
import { Tag } from "./ui/Controls";
import { Tab, TabList, TabPanel, Tabs } from "./ui/TableAndTabs";
import { notify } from "./ui/Toast";

const ScalarReference = lazy(() => import("./ScalarReference"));

type History = {
  endpoints: Array<{
    apiVersion: string;
    operationId: string;
    method: string;
    path: string;
    status: string;
  }>;
  records: MergedRecord[];
};

const inputClass =
  "w-full rounded-lg border border-epic-border bg-epic-bg px-3 py-2 text-sm text-epic-text placeholder:text-epic-text-muted/60 focus:border-epic-accent focus:outline-none transition-colors";

function methodBadgeStyles(method: string) {
  switch (method.toUpperCase()) {
    case "POST":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "DELETE":
      return "bg-epic-danger/15 text-epic-danger border-epic-danger/30";
    case "PUT":
    case "PATCH":
      return "bg-epic-warning/15 text-epic-warning border-epic-warning/30";
    default:
      return "bg-epic-accent-muted text-epic-accent border-epic-accent/30";
  }
}

export function ApiExplorer({ operationId }: { operationId?: string }) {
  const { selectedProject, user, authenticated } = useDashboardAuth();
  return (
    <ExplorerSession
      key={`${selectedProject?.id}:${user?.epicAccountId}:${authenticated}`}
      operationId={operationId}
    />
  );
}

function ExplorerSession({ operationId }: { operationId?: string }) {
  const { selectedProject } = useDashboardAuth();
  const consoleAccess = useConsoleSession(selectedProject?.id);
  const [document, setDocument] = useState<ApiDocument | null>(null);
  const [snapshot, setSnapshot] = useState<ApiDocument | null>(null);
  const [history, setHistory] = useState<History>({
    endpoints: [],
    records: [],
  });
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      import("../../../openapi/egdata.v1.openapi.json").then((module) => {
        if (!controller.signal.aborted)
          setSnapshot(safeDocument(module.default));
      }),
      fetch("/proxy/v1/open-api.json", {
        signal: controller.signal,
        cache: "no-store",
      }).then(async (r) => {
        if (!r.ok) {
          throw new Error(
            "Deployed v1 contract is unavailable. Try it is disabled.",
          );
        }
        setDocument(safeDocument(await r.json()));
      }),
      fetch("/_dashboard/reference/history", {
        signal: controller.signal,
        cache: "no-store",
      }).then(async (r) => {
        if (!r.ok) throw new Error("Merged history is unavailable.");
        setHistory(await r.json());
      }),
    ]).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, []);

  // Keyboard shortcut `/` to focus sidebar search when not typing in an input
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          e.target instanceof HTMLSelectElement ||
          (e.target instanceof HTMLElement && e.target.isContentEditable)
        )
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const deployed = useMemo(
    () => (document ? operations(document) : []),
    [document],
  );

  const {
    reference: current,
    deployed: liveOperation,
    document: referenceDocument,
  } = operationReference(operationId, document, snapshot);

  const references = useMemo(
    () =>
      snapshot
        ? operations(snapshot).filter(
            (e) => !deployed.some((d) => d.operationId === e.operationId),
          )
        : [],
    [snapshot, deployed],
  );

  const historical = history.endpoints.find(
    (e) => e.apiVersion === "v1" && e.operationId === operationId,
  );

  const all: Operation[] = useMemo(
    () => [
      ...deployed,
      ...references,
      ...history.endpoints
        .filter(
          (e) =>
            e.apiVersion === "v1" &&
            ![...deployed, ...references].some(
              (d) => d.operationId === e.operationId,
            ),
        )
        .map((e) => ({
          operationId: e.operationId,
          method: e.method,
          path: e.path,
          operation: {
            summary: e.operationId,
            tags: ["Merged history"],
            responses: {},
          },
        })),
    ],
    [deployed, references, history.endpoints],
  );

  const declaredTags = (document ?? snapshot)?.tags ?? [];

  const allGroups = useMemo(
    () => groupOperationsByResource(all, declaredTags),
    [all, declaredTags],
  );

  const trimmedQuery = query.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!trimmedQuery) return allGroups;
    return allGroups
      .map((group) => ({
        ...group,
        operations: group.operations.filter((e) =>
          `${e.operationId} ${e.method} ${e.path} ${e.operation.summary ?? ""} ${group.name}`
            .toLowerCase()
            .includes(trimmedQuery),
        ),
      }))
      .filter((group) => group.operations.length > 0);
  }, [allGroups, trimmedQuery]);

  // Auto-expand the group containing the active operation when navigating
  const activeGroupName = useMemo(() => {
    if (!operationId) return null;
    return (
      allGroups.find((g) =>
        g.operations.some((op) => op.operationId === operationId),
      )?.name ?? null
    );
  }, [allGroups, operationId]);

  useEffect(() => {
    if (!activeGroupName) return;
    setOpenGroups((prev) => {
      if (prev.has(activeGroupName)) return prev;
      const next = new Set(prev);
      next.add(activeGroupName);
      return next;
    });
  }, [activeGroupName]);

  const details = useMemo(() => {
    if (!referenceDocument || !current) return null;
    return {
      ...referenceDocument,
      tags: referenceDocument.tags?.filter((tag) =>
        current.operation.tags?.includes(tag.name),
      ),
      paths: {
        [current.path]: {
          parameters: referenceDocument.paths[current.path]?.parameters,
          [current.method.toLowerCase()]: current.operation,
        },
      },
    };
  }, [referenceDocument, current]);

  const endpointHistoryRecords = useMemo(
    () =>
      operationId
        ? history.records.filter((r) =>
            r.record.endpoints.some(
              (e) => e.apiVersion === "v1" && e.operationId === operationId,
            ),
          )
        : [],
    [history.records, operationId],
  );

  const totalMatchingOps = useMemo(
    () => filteredGroups.reduce((sum, g) => sum + g.operations.length, 0),
    [filteredGroups],
  );

  const allExpanded =
    allGroups.length > 0 && allGroups.every((g) => openGroups.has(g.name));

  function toggleGroup(name: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleExpandAll() {
    if (allExpanded) {
      setOpenGroups(
        activeGroupName ? new Set([activeGroupName]) : new Set<string>(),
      );
    } else {
      setOpenGroups(new Set(allGroups.map((g) => g.name)));
    }
  }

  function selectResourceFromOverview(groupName: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.add(groupName);
      return next;
    });
  }

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Search + Collapse Controls */}
      <div className="p-3 border-b border-epic-border space-y-2.5 bg-epic-surface/80">
        <div className="relative">
          <Search
            aria-hidden
            className="w-4 h-4 text-epic-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          />
          <input
            ref={searchInputRef}
            className="w-full rounded-lg border border-epic-border bg-epic-bg pl-9 pr-8 py-1.5 text-sm text-epic-text placeholder:text-epic-text-muted/60 focus:border-epic-accent focus:outline-none transition-colors"
            aria-label="Search operations"
            placeholder="Filter endpoints… (/)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-epic-text-muted hover:text-epic-text cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between text-[11px] text-epic-text-muted px-0.5">
          <span>
            {trimmedQuery
              ? `${totalMatchingOps} matching endpoint${totalMatchingOps === 1 ? "" : "s"}`
              : `${allGroups.length} resources · ${all.length} endpoints`}
          </span>
          {!trimmedQuery && allGroups.length > 0 && (
            <button
              type="button"
              onClick={toggleExpandAll}
              className="inline-flex items-center gap-1 text-epic-text-muted hover:text-epic-text transition-colors cursor-pointer font-medium"
            >
              {allExpanded ? (
                <>
                  <ChevronsDownUp className="w-3 h-3" />
                  Collapse all
                </>
              ) : (
                <>
                  <ChevronsUpDown className="w-3 h-3" />
                  Expand all
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Resource Accordion */}
      <nav
        aria-label="Operations"
        className="flex-1 overflow-y-auto p-2 space-y-1"
      >
        {filteredGroups.length === 0 ? (
          <div className="py-10 px-4 text-center space-y-2">
            <p className="text-xs text-epic-text-muted">
              No endpoints match{" "}
              <span className="text-epic-text font-medium">“{query}”</span>.
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-xs text-epic-accent hover:underline cursor-pointer"
            >
              Reset filter
            </button>
          </div>
        ) : (
          filteredGroups.map((group) => {
            const isExpanded =
              Boolean(trimmedQuery) || openGroups.has(group.name);
            const hasActiveChild = group.operations.some(
              (op) => op.operationId === operationId,
            );
            return (
              <div key={group.name} className="rounded-lg overflow-hidden">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => toggleGroup(group.name)}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left text-xs font-semibold transition-colors cursor-pointer select-none ${
                    hasActiveChild && !isExpanded
                      ? "bg-epic-accent-muted text-epic-accent"
                      : "text-epic-text hover:bg-epic-elevated"
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <ChevronRight
                      aria-hidden
                      className={`w-3.5 h-3.5 shrink-0 text-epic-text-muted transition-transform duration-150 ${
                        isExpanded ? "rotate-90 text-epic-text" : ""
                      }`}
                    />
                    <span className="truncate">{group.name}</span>
                  </span>
                  <span
                    className={`text-[11px] font-mono px-1.5 py-0.5 rounded-md shrink-0 ${
                      hasActiveChild
                        ? "bg-epic-accent/20 text-epic-accent"
                        : "bg-epic-elevated text-epic-text-muted"
                    }`}
                  >
                    {group.operations.length}
                  </span>
                </button>

                {isExpanded && (
                  <div className="mt-0.5 ml-3 pl-2 border-l border-epic-border/80 space-y-0.5 py-0.5">
                    {group.operations.map((op) => {
                      const active = operationId === op.operationId;
                      const shortPath = op.path.replace(/^\/v1/, "") || "/";
                      return (
                        <Link
                          key={op.operationId}
                          to="/docs/$operationId"
                          params={{ operationId: op.operationId }}
                          onClick={() => setMobileNavOpen(false)}
                          className={`group flex items-start gap-2 px-2.5 py-1.5 rounded-md transition-colors ${
                            active
                              ? "bg-epic-accent-muted text-epic-text"
                              : "hover:bg-epic-elevated/80 text-epic-text-muted hover:text-epic-text"
                          }`}
                        >
                          <span
                            className={`mt-0.5 text-[10px] font-mono font-semibold px-1.5 py-0.2 rounded border shrink-0 leading-4 ${methodBadgeStyles(
                              op.method,
                            )}`}
                          >
                            {op.method}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block text-xs truncate ${
                                active
                                  ? "font-semibold text-epic-text"
                                  : "text-epic-text/90"
                              }`}
                            >
                              {op.operation.summary || shortPath}
                            </span>
                            <span className="block text-[11px] font-mono text-epic-text-muted truncate">
                              {shortPath}
                            </span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </nav>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Compact Page Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-4 border-b border-epic-border">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              API Reference
            </h1>
            <Tag tone="accent">v1</Tag>
          </div>
          <p className="text-sm text-epic-text-muted">
            Deployed contract for live requests. Dated histories describe merged
            changes and may be ahead of deployment.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            className={buttonStyles({ variant: "secondary", size: "sm" })}
            href="https://docs.egdata.app/docs/v1-problems"
            target="_blank"
            rel="noreferrer"
          >
            Auth, Quotas & Problem Details
            <ArrowUpRight className="w-3.5 h-3.5" />
          </a>

          {/* Mobile endpoint drawer toggle */}
          <button
            type="button"
            onClick={() => setMobileNavOpen((o) => !o)}
            className="lg:hidden inline-flex items-center gap-2 h-8 px-3 rounded-lg border border-epic-border bg-epic-elevated text-xs font-medium text-epic-text hover:bg-epic-hover cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5 text-epic-accent" />
            {mobileNavOpen ? "Hide endpoints" : "Browse endpoints"}
          </button>
        </div>
      </div>

      <section
        aria-label="Console access"
        className="rounded-xl border border-epic-border bg-epic-surface p-4 space-y-3"
      >
        <h2 className="text-sm font-semibold text-white">
          Try with this project
        </h2>
        <p className="text-xs text-epic-text-muted leading-relaxed">
          Start a 10-minute session for{" "}
          {selectedProject?.name ?? "the selected project"}. It works only in
          the signed-in console. Requests count as API console usage for this
          project, with shared console limits across sessions.
        </p>
        {consoleAccess.session ? (
          <div className="flex flex-wrap items-center gap-3">
            <Tag tone="success">
              Expires in {Math.floor(consoleAccess.remaining / 60)}:
              {String(consoleAccess.remaining % 60).padStart(2, "0")}
            </Tag>
            <Button variant="secondary" size="sm" onPress={consoleAccess.end}>
              End console session
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            isDisabled={!selectedProject || consoleAccess.busy}
            onPress={() => void consoleAccess.start()}
          >
            {consoleAccess.busy ? "Starting…" : "Start 10-minute session"}
          </Button>
        )}
        {consoleAccess.error && (
          <p role="alert" className="text-xs text-epic-warning">
            {consoleAccess.error}
          </p>
        )}
      </section>

      {/* Collapsible Problem Details quick-reference */}
      <details className="group rounded-xl border border-epic-border bg-epic-surface/60 text-xs">
        <summary className="flex items-center justify-between gap-2 px-4 py-2.5 cursor-pointer select-none text-epic-text-muted hover:text-epic-text transition-colors list-none">
          <span className="flex items-center gap-2 font-medium">
            <Info className="w-3.5 h-3.5 text-epic-accent shrink-0" />
            Problem Details error standard (RFC 9457)
          </span>
          <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90" />
        </summary>
        <p className="px-4 pb-3 pt-1 text-epic-text-muted leading-relaxed border-t border-epic-border/60">
          Errors use{" "}
          <code className="font-mono text-epic-text bg-epic-elevated px-1.5 py-0.5 rounded">
            application/problem+json
          </code>{" "}
          with <code>type</code>, <code>title</code>, <code>status</code>,{" "}
          <code>detail</code>, <code>code</code>, <code>requestId</code>,
          optional <code>instance</code> and field errors. Use <code>code</code>{" "}
          for handling and <code>requestId</code> for support. Quota denials
          return 429 and <code>Retry-After</code>; an uncertain quota decision
          returns 503. Response errors from admitted requests still count as
          attempted endpoint use.
        </p>
      </details>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-xl border border-epic-warning/30 bg-epic-warning/10 px-4 py-3 text-sm text-epic-warning"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Mobile collapsible sidebar drawer */}
      {mobileNavOpen && (
        <div className="lg:hidden rounded-xl border border-epic-border bg-epic-surface max-h-[65vh] flex flex-col overflow-hidden">
          {sidebarContent}
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid lg:grid-cols-[300px_minmax(0,1fr)] gap-6 items-start">
        {/* Sticky Desktop Sidebar */}
        <aside className="hidden lg:flex flex-col rounded-xl border border-epic-border bg-epic-surface sticky top-28 h-[calc(100vh-8.5rem)] overflow-hidden">
          {sidebarContent}
        </aside>

        {/* Endpoint Workspace */}
        <section className="min-w-0 space-y-5">
          {!operationId ? (
            <ResourceOverviewGrid
              groups={allGroups}
              onSelectResource={selectResourceFromOverview}
            />
          ) : (
            <EndpointDetailView
              operationId={operationId}
              current={current}
              liveOperation={liveOperation}
              historical={historical}
              details={details}
              document={document}
              selectedProjectId={selectedProject?.id}
              historyRecords={endpointHistoryRecords}
              consoleSession={consoleAccess.session}
              endConsoleSession={consoleAccess.end}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function ResourceOverviewGrid({
  groups,
  onSelectResource,
}: {
  groups: OperationGroup[];
  onSelectResource: (name: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-epic-border bg-epic-surface p-6 space-y-2">
        <div className="flex items-center gap-2 text-epic-accent text-xs font-semibold uppercase tracking-wider">
          <BookOpen className="w-4 h-4" />
          Explore by Resource
        </div>
        <h2 className="text-lg font-semibold text-white">
          Choose an operation to inspect its contract, run a request, and review
          its history.
        </h2>
        <p className="text-xs text-epic-text-muted leading-relaxed">
          Expand any resource section in the sidebar or pick a category below to
          jump directly to its first endpoint.
        </p>
      </div>

      {groups.length > 0 && (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
          {groups.map((group) => {
            const firstOp = group.operations[0];
            if (!firstOp) return null;
            return (
              <Link
                key={group.name}
                to="/docs/$operationId"
                params={{ operationId: firstOp.operationId }}
                onClick={() => onSelectResource(group.name)}
                className="group rounded-xl border border-epic-border bg-epic-surface hover:bg-epic-elevated/70 hover:border-epic-border-hover p-4 transition flex flex-col justify-between gap-3"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold text-sm text-epic-text group-hover:text-epic-accent transition-colors">
                      {group.name}
                    </h3>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-epic-elevated text-epic-text-muted border border-epic-border">
                      {group.operations.length}{" "}
                      {group.operations.length === 1 ? "endpoint" : "endpoints"}
                    </span>
                  </div>
                  {group.description && (
                    <p className="text-xs text-epic-text-muted line-clamp-2">
                      {group.description}
                    </p>
                  )}
                </div>

                <div className="pt-2 border-t border-epic-border/60 flex items-center gap-1.5 text-[11px] font-mono text-epic-text-muted truncate">
                  <span
                    className={`px-1.5 py-0.2 rounded border text-[10px] font-semibold ${methodBadgeStyles(
                      firstOp.method,
                    )}`}
                  >
                    {firstOp.method}
                  </span>
                  <span className="truncate">{firstOp.path}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EndpointDetailView({
  operationId,
  current,
  liveOperation,
  historical,
  details,
  document,
  selectedProjectId,
  historyRecords,
  consoleSession,
  endConsoleSession,
}: {
  operationId: string;
  current: Operation | undefined;
  liveOperation: Operation | undefined;
  historical:
    | {
        apiVersion: string;
        operationId: string;
        method: string;
        path: string;
        status: string;
      }
    | undefined;
  details: ApiDocument | null;
  document: ApiDocument | null;
  selectedProjectId: string | undefined;
  historyRecords: MergedRecord[];
  consoleSession: ConsoleSession | null;
  endConsoleSession: () => void;
}) {
  const [copiedPath, setCopiedPath] = useState(false);

  const method = current?.method ?? historical?.method ?? "GET";
  const path = current?.path ?? historical?.path ?? operationId;
  const summary = current?.operation.summary;
  const primaryResource = current?.operation.tags?.[0];
  const scope = current
    ? String(
        current.operation[
          "x-egdata-scope" as keyof OpenAPIV3.OperationObject
        ] ?? "See authentication schema",
      )
    : null;
  const isPublic =
    current?.operation[
      "x-egdata-visibility" as keyof OpenAPIV3.OperationObject
    ] === "public" ||
    (Array.isArray(current?.operation.security) &&
      current.operation.security.length === 0);

  function copyPath() {
    void navigator.clipboard.writeText(path);
    setCopiedPath(true);
    notify({ title: "Copied endpoint path", tone: "info" });
    setTimeout(() => setCopiedPath(false), 1800);
  }

  return (
    <div className="space-y-5">
      {/* Endpoint Identity Header Card */}
      <div className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Link
              to="/docs"
              className="text-epic-text-muted hover:text-epic-text transition-colors"
            >
              Reference
            </Link>
            {primaryResource && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-epic-text-muted" />
                <span className="text-epic-text font-medium">
                  {primaryResource}
                </span>
              </>
            )}
            <ChevronRight className="w-3.5 h-3.5 text-epic-text-muted" />
            <code className="font-mono text-epic-text-muted">
              {operationId}
            </code>
          </div>

          {selectedProjectId && (
            <Link
              className="inline-flex items-center gap-1.5 text-xs font-medium text-epic-accent hover:text-epic-accent-hover transition-colors"
              to="/alerts"
              search={{ endpoint: operationId }}
            >
              <Bell className="w-3.5 h-3.5" />
              Project alerts for this endpoint
            </Link>
          )}
        </div>

        {summary && (
          <h2 className="text-xl font-bold tracking-tight text-white">
            {summary}
          </h2>
        )}

        {/* Method + Path Copy Pill */}
        <div className="flex items-center gap-2.5 rounded-lg border border-epic-border bg-epic-bg px-3 py-2">
          <span
            className={`text-xs font-mono font-bold px-2 py-0.5 rounded border shrink-0 ${methodBadgeStyles(
              method,
            )}`}
          >
            {method}
          </span>
          <code className="text-sm font-mono text-epic-text break-all flex-1">
            {path}
          </code>
          <button
            type="button"
            onClick={copyPath}
            aria-label="Copy endpoint path"
            className="inline-flex items-center gap-1 text-xs text-epic-text-muted hover:text-epic-text px-2 py-1 rounded hover:bg-epic-elevated transition-colors cursor-pointer shrink-0"
          >
            {copiedPath ? (
              <>
                <Check className="w-3.5 h-3.5 text-epic-success" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy
              </>
            )}
          </button>
        </div>

        {/* Status & Scope Badges */}
        {current && details ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Tag tone={liveOperation ? "success" : "warning"}>
              {liveOperation
                ? "Present in deployed contract"
                : "Reference build snapshot; deployment not verified"}
            </Tag>
            {scope && (
              <Tag tone="neutral">
                <ShieldCheck className="w-3 h-3 text-epic-accent" />
                Scope: <span className="font-mono text-epic-text">{scope}</span>
              </Tag>
            )}
            {isPublic && <Tag tone="accent">Public · No API key required</Tag>}
            {!liveOperation && (
              <span className="text-xs text-epic-warning">
                Try it is disabled until deployed.
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-epic-warning">
            This operation is absent from the deployed contract. Merged history
            remains available; Try it is disabled.
          </p>
        )}
      </div>

      {/* Focused Tabs: Contract, Try it, History */}
      {current && details ? (
        <Tabs key={operationId} defaultSelectedKey="contract">
          <TabList aria-label="Endpoint sections">
            <Tab id="contract">
              <span className="inline-flex items-center gap-2">
                <BookOpen className="w-4 h-4" />
                Contract & Schema
              </span>
            </Tab>
            {liveOperation && document && (
              <Tab id="try">
                <span className="inline-flex items-center gap-2">
                  <Terminal className="w-4 h-4" />
                  Try it Console
                </span>
              </Tab>
            )}
            <Tab id="history">
              <span className="inline-flex items-center gap-2">
                <HistoryIcon className="w-4 h-4" />
                Change History
                {historyRecords.length > 0 && (
                  <span className="text-[11px] font-mono px-1.5 py-0.2 rounded-full bg-epic-elevated text-epic-text">
                    {historyRecords.length}
                  </span>
                )}
              </span>
            </Tab>
          </TabList>

          <TabPanel id="contract">
            <Suspense
              fallback={
                <div className="rounded-xl border border-epic-border bg-epic-surface p-8 text-sm text-epic-text-muted">
                  Loading API schemas…
                </div>
              }
            >
              <ScalarReference key={operationId} document={details} />
            </Suspense>
          </TabPanel>

          {liveOperation && document && (
            <TabPanel id="try">
              <TryOperation
                key={operationId}
                operation={liveOperation}
                document={document}
                consoleSession={consoleSession}
                endConsoleSession={endConsoleSession}
              />
            </TabPanel>
          )}

          <TabPanel id="history">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-semibold text-white">
                    Endpoint history
                  </h3>
                  <p className="text-xs text-epic-text-muted mt-0.5">
                    Recorded dates are not deployment dates.
                  </p>
                </div>
                {selectedProjectId && (
                  <Link
                    className={buttonStyles({
                      variant: "secondary",
                      size: "sm",
                    })}
                    to="/alerts"
                    search={{ endpoint: operationId }}
                  >
                    Project alerts for this endpoint
                  </Link>
                )}
              </div>
              <EndpointHistory
                entries={historyRecords}
                operationId={operationId}
              />
            </div>
          </TabPanel>
        </Tabs>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-white">
                Endpoint history
              </h3>
              <p className="text-xs text-epic-text-muted mt-0.5">
                Recorded dates are not deployment dates.
              </p>
            </div>
          </div>
          <EndpointHistory entries={historyRecords} operationId={operationId} />
        </div>
      )}
    </div>
  );
}

function TryOperation({
  operation,
  document,
  consoleSession,
  endConsoleSession,
}: {
  operation: Operation;
  document: ApiDocument;
  consoleSession: ConsoleSession | null;
  endConsoleSession: () => void;
}) {
  const [key, setKey] = useState("");
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<Record<string, string>>({});
  const [body, setBody] = useState("");
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Credential changes must abort requests and clear results from the previous session.
  useEffect(() => {
    abort.current?.abort();
    setKey("");
    setResult(null);
    setBusy(false);
  }, [consoleSession]);
  useEffect(() => {
    const clear = () => {
      abort.current?.abort();
      setKey("");
      setResult(null);
      setBusy(false);
    };
    window.addEventListener("egdata:clear-credentials", clear);
    return () => {
      abort.current?.abort();
      window.removeEventListener("egdata:clear-credentials", clear);
    };
  }, []);

  const params = [
    ...(document.paths[operation.path]?.parameters ?? []),
    ...(operation.operation.parameters ?? []),
  ]
    .map((p) => {
      if (!("$ref" in p)) return p;
      const paramName = p.$ref.split("/").at(-1);
      return paramName
        ? document.components?.parameters?.[paramName]
        : undefined;
    })
    .filter((p): p is OpenAPIV3.ParameterObject => !!p && !("$ref" in p));

  const pathParams = params.filter((p) => p.in === "path");
  const queryParams = params.filter((p) => p.in === "query");

  async function run() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await executeOperation(
          operation,
          consoleSession ? "" : key,
          parameters,
          query,
          body,
          controller.signal,
          consoleSession ?? undefined,
        ),
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "Request failed");
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function copyCurl() {
    void navigator.clipboard.writeText(
      redactedSnippet(operation, parameters, query, body),
    );
    setCopiedCurl(true);
    notify({ title: "Copied redacted cURL snippet", tone: "info" });
    setTimeout(() => setCopiedCurl(false), 1800);
  }

  return (
    <div className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-white">Try it</h3>
        <p className="text-xs text-epic-text-muted leading-relaxed">
          {consoleSession
            ? "Using this project’s temporary console session."
            : "Or paste your own key; stored hashes cannot recover existing secrets."}{" "}
          The credential stays in this page’s memory and clears on logout or
          project change. Requests use your normal permissions and quotas and
          count toward endpoint usage.
        </p>
      </div>

      {/* Credentials */}
      {!consoleSession && (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-epic-text">
            Your API key
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-lpignore="true"
            placeholder="egk_live_…"
            className={`${inputClass} font-mono`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      )}

      {/* Path Parameters */}
      {pathParams.length > 0 && (
        <div className="space-y-3 pt-2 border-t border-epic-border/70">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-epic-text-muted">
            Path Parameters
          </h4>
          <div className="grid sm:grid-cols-2 gap-3">
            {pathParams.map((p) => (
              <ParameterField
                key={`path:${p.name}`}
                param={p}
                value={parameters[p.name] ?? ""}
                onChange={(val) =>
                  setParameters((old) => ({ ...old, [p.name]: val }))
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Query Parameters */}
      {queryParams.length > 0 && (
        <div className="space-y-3 pt-2 border-t border-epic-border/70">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-epic-text-muted">
            Query Parameters
          </h4>
          <div className="grid sm:grid-cols-2 gap-3">
            {queryParams.map((p) => (
              <ParameterField
                key={`query:${p.name}`}
                param={p}
                value={query[p.name] ?? ""}
                onChange={(val) =>
                  setQuery((old) => ({ ...old, [p.name]: val }))
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Request Body */}
      {operation.operation.requestBody && (
        <label className="block space-y-1.5 pt-2 border-t border-epic-border/70">
          <span className="text-xs font-semibold uppercase tracking-wider text-epic-text-muted block">
            JSON Request Body
          </span>
          <textarea
            rows={6}
            placeholder="{}"
            className={`${inputClass} font-mono text-xs`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      )}

      {/* Action Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        <Button
          variant="primary"
          isDisabled={busy || !executable(operation)}
          onPress={() => void run()}
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          {busy ? "Sending…" : "Send request"}
        </Button>

        <Button variant="secondary" onPress={copyCurl}>
          {copiedCurl ? (
            <Check className="w-3.5 h-3.5 text-epic-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
          Copy redacted cURL
        </Button>

        <Button
          variant="quiet"
          onPress={() => {
            endConsoleSession();
            abort.current?.abort();
            setKey("");
            setResult(null);
            setBusy(false);
          }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Clear credentials
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-epic-warning/30 bg-epic-warning/10 px-3.5 py-2.5 text-xs text-epic-warning"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && <ResponsePreview result={result} />}
    </div>
  );
}

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: OpenAPIV3.ParameterObject;
  value: string;
  onChange: (next: string) => void;
}) {
  const fieldId = useId();
  const schema =
    param.schema && !("$ref" in param.schema) ? param.schema : undefined;
  const enumValues = schema?.enum?.map(String);
  const defaultPlaceholder =
    schema?.default !== undefined
      ? `Default: ${String(schema.default)}`
      : schema?.type
        ? String(schema.type)
        : "";

  return (
    <div className="space-y-1">
      <label
        htmlFor={fieldId}
        className="flex items-center justify-between gap-2 text-xs cursor-pointer"
      >
        <span className="font-mono font-medium text-epic-text">
          {param.name}
          {param.required && (
            <span className="text-epic-danger ml-1" title="Required">
              *
            </span>
          )}
        </span>
        {schema?.type && (
          <span className="text-[11px] font-mono text-epic-text-muted">
            {schema.type}
          </span>
        )}
      </label>

      {enumValues && enumValues.length > 0 ? (
        <select
          id={fieldId}
          className={inputClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {defaultPlaceholder ? `(${defaultPlaceholder})` : "Any"}
          </option>
          {enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : schema?.type === "boolean" ? (
        <select
          id={fieldId}
          className={inputClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {defaultPlaceholder ? `(${defaultPlaceholder})` : "Unset"}
          </option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          id={fieldId}
          className={inputClass}
          placeholder={defaultPlaceholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {param.description && (
        <span className="block text-[11px] text-epic-text-muted leading-snug line-clamp-2">
          {param.description}
        </span>
      )}
    </div>
  );
}

function ResponsePreview({ result }: { result: TryResult }) {
  const [url, setUrl] = useState("");
  const [copiedBody, setCopiedBody] = useState(false);

  useEffect(() => {
    if (!result.blob) return;
    const next = URL.createObjectURL(result.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [result]);

  const statusTone =
    result.status >= 200 && result.status < 300
      ? "success"
      : result.status >= 400
        ? "danger"
        : "warning";

  function copyResponseBody() {
    if (!result.text) return;
    void navigator.clipboard.writeText(result.text);
    setCopiedBody(true);
    notify({ title: "Copied response body", tone: "info" });
    setTimeout(() => setCopiedBody(false), 1800);
  }

  return (
    <div className="space-y-3 pt-3 border-t border-epic-border">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <Tag tone={statusTone}>HTTP {result.status}</Tag>
          <span className="text-epic-text-muted">{result.duration} ms</span>
          <span className="text-epic-text-muted">·</span>
          <span className="text-epic-text-muted">{result.contentType}</span>
        </div>

        {result.text !== undefined && (
          <Button variant="secondary" size="sm" onPress={copyResponseBody}>
            {copiedBody ? (
              <Check className="w-3.5 h-3.5 text-epic-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            Copy response
          </Button>
        )}
      </div>

      <details className="rounded-lg border border-epic-border bg-epic-bg/60 text-xs">
        <summary className="px-3 py-2 cursor-pointer select-none text-epic-text-muted hover:text-epic-text font-medium">
          Response headers ({Object.keys(result.headers).length})
        </summary>
        <pre className="overflow-auto text-xs p-3 border-t border-epic-border font-mono text-epic-text-muted">
          {JSON.stringify(result.headers, null, 2)}
        </pre>
      </details>

      {result.text !== undefined && (
        <pre className="overflow-auto max-h-[32rem] whitespace-pre-wrap break-all text-xs font-mono bg-epic-bg border border-epic-border rounded-lg p-4 text-epic-text">
          {result.text}
        </pre>
      )}

      {result.kind === "image" && url && (
        <img
          src={url}
          alt="API binary preview"
          className="max-w-full rounded-lg border border-epic-border"
        />
      )}

      {result.blob && url && (
        <a
          className={buttonStyles({ variant: "secondary", size: "sm" })}
          download="api-response"
          href={url}
        >
          Download {result.kind} response ({result.blob.size} bytes)
        </a>
      )}
    </div>
  );
}
