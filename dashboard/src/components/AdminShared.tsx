import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
  placeholder = "Name, ID, or owner",
  children,
}: {
  onSearch: (value: string) => void;
  reload: () => void;
  loading: boolean;
  placeholder?: string;
  children?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-epic-border">
      <Form
        role="search"
        className="flex flex-row flex-wrap items-center gap-2 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(search.trim());
        }}
      >
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search
            aria-hidden="true"
            className="absolute left-3 top-2.5 w-4 h-4 text-epic-text-muted pointer-events-none"
          />
          <TextField
            aria-label={placeholder}
            value={search}
            onChange={setSearch}
            placeholder={placeholder}
            className="[&_input]:pl-9 [&_input]:pr-9"
          />
          {search && (
            <Button
              variant="icon"
              aria-label="Clear search"
              className="absolute right-1 top-0.5"
              onPress={() => {
                setSearch("");
                onSearch("");
              }}
            >
              <X aria-hidden="true" className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </Form>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <Button variant="secondary" onPress={reload} isDisabled={loading}>
          <RefreshCw
            aria-hidden="true"
            className={`w-3.5 h-3.5 ${loading ? "motion-safe:animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>
    </div>
  );
}

export function AdminPagination({
  offset,
  hasMore,
  onChange,
  count,
  loading = false,
}: {
  offset: number;
  hasMore: boolean;
  onChange: (offset: number) => void;
  count?: number;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-epic-text-muted">
      <span aria-live="polite">
        {loading
          ? "Updating…"
          : count === undefined
            ? "25 rows per page"
            : count
              ? `Rows ${offset + 1}–${offset + count} · 25 per page`
              : "0 rows"}
      </span>
      <div className="flex items-center gap-2">
        <span className="mr-2 tabular-nums">
          Page {Math.floor(offset / 25) + 1}
        </span>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Previous page"
          isDisabled={offset === 0 || loading}
          onPress={() => onChange(Math.max(0, offset - 25))}
        >
          <ChevronLeft aria-hidden="true" className="w-4 h-4" />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Next page"
          isDisabled={!hasMore || loading}
          onPress={() => onChange(offset + 25)}
        >
          <ChevronRight aria-hidden="true" className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

export function AdminUsageNote({ usage }: { usage: AdminUsage }) {
  return (
    <div className="flex items-start gap-2 text-[11px] leading-relaxed text-epic-text-muted">
      <Clock3 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <p>
        <span className="text-epic-text">Last 24 hours</span> · Ending{" "}
        {new Date(usage.end).toLocaleString()}.{" "}
        {usage.source === "unavailable"
          ? "Usage is unavailable. Refresh to retry; management controls remain available."
          : usage.source === "local_buffer"
            ? "Local buffer only; not complete production history."
            : "Analytics Engine estimates; includes legacy and v1 traffic. This is request volume, not the live minute quota balance."}
      </p>
    </div>
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
