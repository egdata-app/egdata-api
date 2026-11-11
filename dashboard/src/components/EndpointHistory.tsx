import type { ChangeRecord } from "../../worker/change-validation";

export type MergedRecord = {
  record: ChangeRecord;
  mergeCommit: string;
  mergedAt: number;
};

export const sourceRepository = "https://github.com/egdata-app/egdata-api";

export function EndpointHistory({
  entries,
  operationId,
}: {
  entries: MergedRecord[];
  operationId?: string;
}) {
  return (
    <div className="space-y-4">
      {entries.map(({ record, mergeCommit, mergedAt }) => (
        <article
          key={record.id}
          className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-3"
        >
          <h3 className="font-semibold text-lg">{record.title}</h3>
          <p className="text-sm text-epic-text-muted">
            Recorded {record.recordedDate} · Merged{" "}
            {new Date(mergedAt).toISOString()} ·{" "}
            <a
              className="text-epic-accent"
              href={`${sourceRepository}/commit/${mergeCommit}`}
            >
              Commit {mergeCommit.slice(0, 8)}
            </a>
          </p>
          <p className="text-epic-warning font-medium">
            Merged; deployment not verified.
          </p>
          {record.endpoints
            .filter((e) => !operationId || e.operationId === operationId)
            .map((e) => (
              <div
                key={`${e.apiVersion}:${e.operationId}`}
                className="space-y-2 border-t border-epic-border pt-3"
              >
                <p>
                  <code>
                    {e.apiVersion} {e.method} {e.path}
                  </code>{" "}
                  · {e.type} ·{" "}
                  <strong
                    className={
                      e.compatibility === "breaking"
                        ? "text-epic-warning"
                        : "text-epic-success"
                    }
                  >
                    {e.compatibility}
                  </strong>
                </p>
                <p>
                  <strong>Before:</strong> {e.before}
                </p>
                <p>
                  <strong>After:</strong> {e.after}
                </p>
                <p>
                  <strong>Client action:</strong> {e.clientAction}
                </p>
                {e.replacement && <p>Replacement: {e.replacement}</p>}
                {e.schemaFields && (
                  <p>Schema fields: {e.schemaFields.join(", ")}</p>
                )}
              </div>
            ))}
          {record.corrects && <p>Corrects record {record.corrects}.</p>}
          <p className="text-sm text-epic-text-muted">
            Verification: {record.verification.join("; ")}
          </p>
          <a
            className="text-epic-accent text-sm"
            href={`${sourceRepository}/blob/${mergeCommit}/changes/records/${record.id}.json`}
          >
            Source record
          </a>
        </article>
      ))}
      {!entries.length && (
        <p className="text-epic-text-muted">
          No dated merged changes for this endpoint. Undated historical notes
          are excluded.
        </p>
      )}
    </div>
  );
}
