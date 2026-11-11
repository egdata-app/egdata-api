import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  GitCommit,
} from "lucide-react";
import type { ChangeRecord } from "../../worker/change-validation";
import { Tag } from "./ui/Controls";

export type MergedRecord = {
  record: ChangeRecord;
  mergeCommit: string;
  mergedAt: number;
};

export const sourceRepository = "https://github.com/egdata-app/egdata-api";

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

function changeTypeTone(
  type: ChangeRecord["endpoints"][number]["type"],
): "neutral" | "accent" | "success" | "warning" | "danger" {
  switch (type) {
    case "added":
      return "success";
    case "fixed":
      return "accent";
    case "deprecated":
      return "warning";
    case "removed":
    case "security":
      return "danger";
    default:
      return "neutral";
  }
}

export function EndpointHistory({
  entries,
  operationId,
  embedded = false,
}: {
  entries: MergedRecord[];
  operationId?: string;
  embedded?: boolean;
}) {
  return (
    <div className="space-y-4">
      {entries.map(({ record, mergeCommit, mergedAt }) => (
        <article
          key={record.id}
          className={
            embedded
              ? "space-y-4"
              : "rounded-xl border border-epic-border bg-epic-surface p-5 space-y-4"
          }
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="font-semibold text-base text-white">
                {record.title}
              </h3>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-epic-text-muted">
                <span>
                  Recorded{" "}
                  <span className="font-mono text-epic-text">
                    {record.recordedDate}
                  </span>
                </span>
                <span>·</span>
                <span>
                  Merged{" "}
                  <span className="font-mono text-epic-text">
                    {new Date(mergedAt).toISOString()}
                  </span>
                </span>
                <span>·</span>
                <a
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-epic-accent hover:text-epic-accent-hover transition-colors"
                  href={`${sourceRepository}/commit/${mergeCommit}`}
                >
                  <GitCommit className="w-3.5 h-3.5" />
                  {mergeCommit.slice(0, 8)}
                </a>
              </div>
            </div>
            <Tag tone="warning">
              <AlertTriangle className="w-3 h-3" />
              Merged; deployment not verified
            </Tag>
          </div>

          <div className="space-y-3">
            {record.endpoints
              .filter((e) => !operationId || e.operationId === operationId)
              .map((e) => (
                <div
                  key={`${e.apiVersion}:${e.operationId}`}
                  className="rounded-lg border border-epic-border/70 bg-epic-bg/60 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-epic-elevated text-epic-text-muted border border-epic-border">
                        {e.apiVersion}
                      </span>
                      <span
                        className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${methodBadgeStyles(
                          e.method,
                        )}`}
                      >
                        {e.method}
                      </span>
                      <code className="text-xs font-mono text-epic-text break-all">
                        {e.path}
                      </code>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Tag tone={changeTypeTone(e.type)}>{e.type}</Tag>
                      <Tag
                        tone={
                          e.compatibility === "breaking" ? "warning" : "success"
                        }
                      >
                        {e.compatibility === "breaking" ? (
                          <AlertTriangle className="w-3 h-3" />
                        ) : (
                          <CheckCircle2 className="w-3 h-3" />
                        )}
                        {e.compatibility}
                      </Tag>
                    </div>
                  </div>

                  <dl className="grid sm:grid-cols-2 gap-3 text-xs">
                    <div className="rounded-md bg-epic-surface/70 border border-epic-border/60 p-3 space-y-1">
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-epic-text-muted">
                        Before
                      </dt>
                      <dd className="text-epic-text leading-relaxed">
                        {e.before}
                      </dd>
                    </div>
                    <div className="rounded-md bg-epic-surface/70 border border-epic-border/60 p-3 space-y-1">
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-epic-text-muted">
                        After
                      </dt>
                      <dd className="text-epic-text leading-relaxed">
                        {e.after}
                      </dd>
                    </div>
                  </dl>

                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 text-xs pt-0.5">
                    <div>
                      <span className="font-semibold text-epic-text-muted">
                        Client action:{" "}
                      </span>
                      <span className="text-epic-text">{e.clientAction}</span>
                    </div>
                    {e.replacement && (
                      <div>
                        <span className="font-semibold text-epic-text-muted">
                          Replacement:{" "}
                        </span>
                        <code className="font-mono text-epic-accent">
                          {e.replacement}
                        </code>
                      </div>
                    )}
                    {e.schemaFields && (
                      <div>
                        <span className="font-semibold text-epic-text-muted">
                          Schema fields:{" "}
                        </span>
                        <code className="font-mono text-epic-text">
                          {e.schemaFields.join(", ")}
                        </code>
                      </div>
                    )}
                  </div>
                </div>
              ))}
          </div>

          {record.corrects && (
            <p className="text-xs text-epic-text-muted">
              Corrects record{" "}
              <code className="font-mono text-epic-text">
                {record.corrects}
              </code>
              .
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-epic-border/70 text-xs text-epic-text-muted">
            <span className="truncate">
              Verification:{" "}
              <span className="font-mono text-epic-text/90">
                {record.verification.join("; ")}
              </span>
            </span>
            <a
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-epic-accent hover:text-epic-accent-hover transition-colors shrink-0"
              href={`${sourceRepository}/blob/${mergeCommit}/changes/records/${record.id}.json`}
            >
              Source record
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </article>
      ))}
      {!entries.length && (
        <div className="rounded-xl border border-dashed border-epic-border bg-epic-surface/50 py-10 px-4 text-center text-xs text-epic-text-muted">
          No dated merged changes for this endpoint. Undated historical notes
          are excluded.
        </div>
      )}
    </div>
  );
}
