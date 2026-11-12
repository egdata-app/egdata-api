import { useEffect, useState } from "react";
import type { AdminAuditEntry } from "../../worker/admin-types";
import { dashboardClient } from "../lib/api";
import { AdminPagination, adminDate } from "./AdminShared";
import { Button } from "./ui/Button";

export function AdminAudit({
  projectId = "",
  owner = "",
}: {
  projectId?: string;
  owner?: string;
}) {
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState<{
    rows: AdminAuditEntry[];
    hasMore: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers an explicit retry.
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError("");
    void dashboardClient
      .getAdminAudit(projectId, owner, offset, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : "Could not load history.",
          );
      });
    return () => controller.abort();
  }, [projectId, owner, offset, version]);
  return (
    <div className="space-y-4">
      {error ? (
        <div>
          <p role="alert">{error}</p>
          <Button onPress={() => setVersion((value) => value + 1)}>
            Retry
          </Button>
        </div>
      ) : !page ? (
        <output>Loading history...</output>
      ) : (
        <>
          {page.rows.length === 0 && <p>No recorded changes yet.</p>}
          {page.rows.map((entry) => (
            <article
              key={entry.sequence}
              className="border border-epic-border rounded-lg p-3 space-y-2 text-sm"
            >
              <div className="font-semibold">
                {entry.action} · {adminDate(entry.createdAt)}
              </div>
              <p className="text-xs text-epic-text-muted break-all">
                Actor: {entry.actorId} · {entry.targetType}: {entry.targetId} ·
                Owner: {entry.ownerId}
              </p>
              <p className="whitespace-pre-wrap">{entry.reason}</p>
              <details>
                <summary className="cursor-pointer text-epic-accent">
                  Before / after
                </summary>
                <pre className="text-xs whitespace-pre-wrap break-all mt-2">
                  {JSON.stringify(
                    { before: entry.before, after: entry.after },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </article>
          ))}
          <AdminPagination
            offset={offset}
            hasMore={page.hasMore}
            onChange={setOffset}
          />
        </>
      )}
    </div>
  );
}
