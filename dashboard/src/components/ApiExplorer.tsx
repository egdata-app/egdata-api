import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { OpenAPIV3 } from "openapi-types";
import { Link } from "@tanstack/react-router";
import { useDashboardAuth } from "../lib/auth-context";
import { useConsoleSession, type ConsoleSession } from "../lib/console-session";
import {
  executable,
  executeOperation,
  operations,
  operationReference,
  redactedSnippet,
  safeDocument,
  type ApiDocument,
  type Operation,
  type TryResult,
} from "../lib/explorer";
import { EndpointHistory, type MergedRecord } from "./EndpointHistory";

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
  "w-full rounded-lg border border-epic-border bg-epic-elevated px-3 py-2 text-sm";

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
  const [resource, setResource] = useState("");
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
  const deployed = useMemo(
    () => (document ? operations(document) : []),
    [document],
  );
  const {
    reference: current,
    deployed: liveOperation,
    document: referenceDocument,
  } = operationReference(operationId, document, snapshot);
  const references = snapshot
    ? operations(snapshot).filter(
        (e) => !deployed.some((d) => d.operationId === e.operationId),
      )
    : [];
  const historical = history.endpoints.find(
    (e) => e.apiVersion === "v1" && e.operationId === operationId,
  );
  const all = [
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
        ...e,
        operation: { summary: e.operationId, tags: ["Merged history"] },
      })),
  ];
  const resources = [
    ...new Set(all.flatMap((e) => e.operation.tags ?? ["Other"])),
  ].sort();
  const visible = all.filter(
    (e) =>
      (!resource || (e.operation.tags ?? []).includes(resource)) &&
      `${e.operationId} ${e.method} ${e.path} ${e.operation.summary ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
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
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">API Reference</h1>
        <p className="text-epic-text-muted mt-2">
          v1 · Deployed contract for requests. Dated histories describe merged
          changes and may be ahead of deployment.
        </p>
      </div>
      <p>
        <a
          className="text-epic-accent"
          href="https://docs.egdata.app/docs/v1-problems"
        >
          Authentication, quotas and Problem Details error standard
        </a>
      </p>
      <section
        aria-label="Console access"
        className="rounded-xl border border-epic-border p-4 space-y-3"
      >
        <h2 className="font-semibold">Try with this project</h2>
        <p className="text-sm text-epic-text-muted">
          Start a 10-minute session for{" "}
          {selectedProject?.name ?? "the selected project"}. It works only in
          the signed-in console. Requests count as API console usage for this
          project, with shared console limits across sessions.
        </p>
        {consoleAccess.session ? (
          <div className="flex items-center gap-4">
            <span role="status">
              Expires in {Math.floor(consoleAccess.remaining / 60)}:
              {String(consoleAccess.remaining % 60).padStart(2, "0")}
            </span>
            <button className="text-epic-accent" onClick={consoleAccess.end}>
              End console session
            </button>
          </div>
        ) : (
          <button
            className="rounded-lg bg-epic-accent text-epic-bg px-4 py-2 disabled:opacity-50"
            disabled={!selectedProject || consoleAccess.busy}
            onClick={() => void consoleAccess.start()}
          >
            {consoleAccess.busy ? "Starting…" : "Start 10-minute session"}
          </button>
        )}
        {consoleAccess.error && (
          <p role="alert" className="text-epic-warning">
            {consoleAccess.error}
          </p>
        )}
      </section>
      <details className="rounded-xl border border-epic-border p-4">
        <summary className="cursor-pointer">Problem Details responses</summary>
        <p className="mt-3">
          Errors use <code>application/problem+json</code> with type, title,
          status, detail, code, requestId, optional instance and field errors.
          Use code for handling and requestId for support. Quota denials return
          429 and Retry-After; an uncertain quota decision returns 503. Response
          errors from admitted requests still count as attempted endpoint use.
        </p>
      </details>
      {error && (
        <p role="alert" className="text-epic-warning">
          {error}
        </p>
      )}
      <div className="grid lg:grid-cols-[280px_1fr] gap-6">
        <aside className="space-y-3">
          <input
            className={inputClass}
            aria-label="Search operations"
            placeholder="Search method, path, resource…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Resource"
            className={inputClass}
            value={resource}
            onChange={(e) => setResource(e.target.value)}
          >
            <option value="">All resources</option>
            {resources.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <nav
            aria-label="Operations"
            className="max-h-[70vh] overflow-auto space-y-1"
          >
            {visible.map((e) => (
              <Link
                key={e.operationId}
                to="/docs/$operationId"
                params={{ operationId: e.operationId }}
                className={`block p-3 rounded-lg hover:bg-epic-hover ${operationId === e.operationId ? "bg-epic-elevated" : ""}`}
              >
                <span className="text-xs font-mono text-epic-accent">
                  {e.method}
                </span>
                <span className="block text-sm break-all">{e.path}</span>
                <span className="text-xs text-epic-text-muted">
                  {e.operation.summary}
                </span>
              </Link>
            ))}
          </nav>
        </aside>
        <section className="min-w-0 space-y-6">
          {!operationId ? (
            <p className="p-8 border border-epic-border rounded-xl">
              Choose an operation to inspect its contract, run a request, and
              review its history.
            </p>
          ) : (
            <>
              <h2 className="text-xl font-semibold break-all">
                {current?.method ?? historical?.method}{" "}
                {current?.path ?? historical?.path ?? operationId}
              </h2>
              {current && details ? (
                <>
                  <p
                    className={
                      liveOperation ? "text-epic-success" : "text-epic-warning"
                    }
                  >
                    {liveOperation
                      ? "Present in deployed contract"
                      : "Reference build snapshot; deployment not verified. Try it is disabled."}{" "}
                    · Scope:{" "}
                    {String(
                      current.operation[
                        "x-egdata-scope" as keyof OpenAPIV3.OperationObject
                      ] ?? "See authentication schema",
                    )}
                  </p>
                  <Suspense fallback={<p>Loading API schemas…</p>}>
                    <ScalarReference key={operationId} document={details} />
                  </Suspense>
                  {liveOperation && document && (
                    <TryOperation
                      key={operationId}
                      operation={liveOperation}
                      document={document}
                      consoleSession={consoleAccess.session}
                      endConsoleSession={consoleAccess.end}
                    />
                  )}
                </>
              ) : (
                <p className="text-epic-warning">
                  This operation is absent from the deployed contract. Merged
                  history remains available; Try it is disabled.
                </p>
              )}
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-xl font-semibold">Endpoint history</h2>
                {selectedProject && (
                  <Link
                    className="text-epic-accent"
                    to="/alerts"
                    search={{ endpoint: operationId }}
                  >
                    Project alerts for this endpoint
                  </Link>
                )}
              </div>
              <p className="text-sm text-epic-text-muted">
                Recorded dates are not deployment dates.
              </p>
              <EndpointHistory
                entries={history.records.filter((r) =>
                  r.record.endpoints.some(
                    (e) =>
                      e.apiVersion === "v1" && e.operationId === operationId,
                  ),
                )}
                operationId={operationId}
              />
            </>
          )}
        </section>
      </div>
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
  const abort = useRef<AbortController | null>(null);
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
    .map((p) =>
      "$ref" in p
        ? document.components?.parameters?.[p.$ref.split("/").at(-1)!]
        : p,
    )
    .filter((p): p is OpenAPIV3.ParameterObject => !!p && !("$ref" in p));
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
  return (
    <div className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-4">
      <h2 className="text-xl font-semibold">Try it</h2>
      <p className="text-sm text-epic-text-muted">
        {consoleSession
          ? "Using this project’s temporary console session."
          : "Or paste your own key; stored hashes cannot recover existing secrets."}{" "}
        The credential stays in this page’s memory and clears on logout or
        project change. Requests use your normal permissions and quotas and
        count toward endpoint usage.
      </p>
      {!consoleSession && (
        <label className="block space-y-1">
          <span>Your API key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-lpignore="true"
            className={inputClass}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      )}
      {params
        .filter((p) => p.in === "path" || p.in === "query")
        .map((p) => (
          <label key={`${p.in}:${p.name}`} className="block space-y-1">
            <span className="text-sm">
              {p.name} ({p.in}){p.required ? " · required" : ""}
            </span>
            <input
              className={inputClass}
              value={(p.in === "path" ? parameters : query)[p.name] ?? ""}
              onChange={(e) =>
                (p.in === "path" ? setParameters : setQuery)((old) => ({
                  ...old,
                  [p.name]: e.target.value,
                }))
              }
            />
          </label>
        ))}
      {operation.operation.requestBody && (
        <label className="block space-y-1">
          <span>JSON request body</span>
          <textarea
            rows={6}
            className={`${inputClass} font-mono`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      )}
      <div className="flex gap-3">
        <button
          className="rounded-lg bg-epic-accent text-epic-bg font-semibold px-4 py-2 disabled:opacity-50"
          disabled={busy || !executable(operation)}
          onClick={() => void run()}
        >
          {busy ? "Sending…" : "Send request"}
        </button>
        <button
          className="rounded-lg border border-epic-border px-4 py-2"
          onClick={() =>
            void navigator.clipboard.writeText(redactedSnippet(operation))
          }
        >
          Copy redacted cURL
        </button>
        <button
          className="text-epic-text-muted"
          onClick={() => {
            endConsoleSession();
            abort.current?.abort();
            setKey("");
            setResult(null);
            setBusy(false);
          }}
        >
          Clear credentials
        </button>
      </div>
      {error && (
        <p role="alert" className="text-epic-warning">
          {error}
        </p>
      )}
      {result && <ResponsePreview result={result} />}
    </div>
  );
}

function ResponsePreview({ result }: { result: TryResult }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!result.blob) return;
    const next = URL.createObjectURL(result.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [result]);
  return (
    <div className="space-y-3">
      <p className="font-mono">
        Status {result.status} · {result.duration} ms · {result.contentType}
      </p>
      <details>
        <summary>Response headers</summary>
        <pre className="overflow-auto text-xs p-3">
          {JSON.stringify(result.headers, null, 2)}
        </pre>
      </details>
      {result.text !== undefined && (
        <pre className="overflow-auto max-h-[32rem] whitespace-pre-wrap break-all text-xs bg-epic-bg rounded-lg p-4">
          {result.text}
        </pre>
      )}
      {result.kind === "image" && url && (
        <img
          src={url}
          alt="API image response"
          className="max-w-full rounded-lg"
        />
      )}
      {result.blob && url && (
        <a className="text-epic-accent" download="api-response" href={url}>
          Download {result.kind} response ({result.blob.size} bytes)
        </a>
      )}
    </div>
  );
}
