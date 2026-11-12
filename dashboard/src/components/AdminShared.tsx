import { useEffect, useState } from "react";
import type { AdminPage, AdminUsage } from "../../worker/admin-types";
import { Button } from "./ui/Button";
import { Form, TextField } from "./ui/TextField";

export function useAdminPage<T>(
  load: (signal: AbortSignal) => Promise<AdminPage<T>>,
) {
  const [page, setPage] = useState<AdminPage<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers manual refresh after mutations and retries.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage(null);
    void load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : "Could not load records.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, version]);
  return {
    page,
    loading,
    error,
    reload: () => setVersion((value) => value + 1),
  };
}

export function AdminToolbar({
  onSearch,
  reload,
  loading,
}: {
  onSearch: (value: string) => void;
  reload: () => void;
  loading: boolean;
}) {
  const [search, setSearch] = useState("");
  return (
    <Form
      className="flex flex-row flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(search.trim());
      }}
    >
      <TextField
        label="Search"
        value={search}
        onChange={setSearch}
        placeholder="Name, ID, or owner"
        className="flex-1 min-w-56"
      />
      <Button type="submit" variant="secondary">
        Search
      </Button>
      <Button variant="secondary" onPress={reload} isDisabled={loading}>
        Refresh
      </Button>
    </Form>
  );
}

export function AdminPagination({
  offset,
  hasMore,
  onChange,
}: {
  offset: number;
  hasMore: boolean;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-3 text-sm text-epic-text-muted">
      <Button
        variant="secondary"
        isDisabled={offset === 0}
        onPress={() => onChange(Math.max(0, offset - 25))}
      >
        Previous
      </Button>
      <span>Page {Math.floor(offset / 25) + 1}</span>
      <Button
        variant="secondary"
        isDisabled={!hasMore}
        onPress={() => onChange(offset + 25)}
      >
        Next
      </Button>
    </div>
  );
}

export function AdminUsageNote({ usage }: { usage: AdminUsage }) {
  return (
    <p className="text-xs text-epic-text-muted">
      Usage: last 24 hours, ending {new Date(usage.end).toLocaleString()}.{" "}
      {usage.source === "unavailable"
        ? "Usage is unavailable. Refresh to retry; management controls remain available."
        : usage.source === "local_buffer"
          ? "Local buffer only; not complete production history."
          : "Analytics Engine estimates; includes legacy and v1 traffic. This is request volume, not the live minute quota balance."}
    </p>
  );
}

export function usageNumber(
  usage: AdminUsage,
  id: string,
  field: "requests" | "rateLimited" | "errors",
) {
  return usage.byId[id]?.[field].toLocaleString() ?? "Unavailable";
}

export function adminDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}
