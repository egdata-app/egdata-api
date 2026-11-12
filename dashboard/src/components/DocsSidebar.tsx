import { Link } from "@tanstack/react-router";
import { BookOpen, ChevronRight, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { allDocs, groupDocs } from "../lib/docs/catalog";
import type { DocEntry } from "../lib/docs/types";

function matches(entry: DocEntry, query: string): boolean {
  const haystack = [
    entry.title,
    entry.description,
    entry.code,
    entry.slug,
    entry.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function DocLink({
  entry,
  active,
  onNavigate,
}: {
  entry: DocEntry;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to="/docs/$slug"
      params={{ slug: entry.slug }}
      onClick={onNavigate}
      className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
        active
          ? "bg-epic-accent-muted text-epic-text"
          : "text-epic-text-muted hover:bg-epic-elevated/80 hover:text-epic-text"
      }`}
    >
      {entry.code ? (
        <code
          className={`mt-px shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-4 ${
            entry.kind === "issue"
              ? "border-epic-warning/30 bg-epic-warning/10 text-epic-warning"
              : "border-epic-border bg-epic-elevated text-epic-text/80"
          }`}
        >
          {entry.code}
        </code>
      ) : (
        <BookOpen
          aria-hidden
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-epic-text-muted"
        />
      )}
      <span className="min-w-0">
        <span
          className={`block truncate ${active ? "font-semibold text-epic-text" : ""}`}
        >
          {entry.title}
        </span>
        {entry.kind === "problem" && (
          <span className="block text-[11px] text-epic-text-muted/80">
            HTTP {entry.status}
          </span>
        )}
      </span>
    </Link>
  );
}

export function DocsSidebar({
  currentSlug,
  onNavigate,
}: {
  currentSlug?: string;
  onNavigate?: () => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();

  const groups = useMemo(() => {
    if (!trimmed) return groupDocs(allDocs);
    return groupDocs(allDocs.filter((entry) => matches(entry, trimmed)));
  }, [trimmed]);

  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-epic-border bg-epic-surface/80 p-3">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-epic-text-muted"
          />
          <input
            className="w-full rounded-lg border border-epic-border bg-epic-bg py-1.5 pl-9 pr-8 text-sm text-epic-text transition-colors placeholder:text-epic-text-muted/60 focus:border-epic-accent focus:outline-none"
            aria-label="Search documentation"
            placeholder="Search docs and codes…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear documentation search"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-epic-text-muted hover:text-epic-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <p className="px-0.5 text-[11px] text-epic-text-muted">
          {trimmed
            ? `${total} matching page${total === 1 ? "" : "s"}`
            : `${allDocs.length} guides and codes`}
        </p>
      </div>

      <nav
        aria-label="Documentation"
        className="flex-1 space-y-1 overflow-y-auto p-2"
      >
        {groups.length === 0 ? (
          <div className="space-y-2 px-4 py-10 text-center">
            <p className="text-xs text-epic-text-muted">
              No documentation matches{" "}
              <span className="font-medium text-epic-text">“{query}”</span>.
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="cursor-pointer text-xs text-epic-accent hover:underline"
            >
              Reset search
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.category} className="rounded-lg">
              <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-epic-text-muted">
                {group.category}
              </p>
              <div className="space-y-0.5">
                {group.entries.map((entry) => (
                  <DocLink
                    key={`${entry.kind}:${entry.slug}`}
                    entry={entry}
                    active={entry.slug === currentSlug}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </nav>

      <Link
        to="/docs"
        onClick={onNavigate}
        className="m-2 flex items-center justify-between gap-2 rounded-lg border border-epic-border bg-epic-elevated px-3 py-2 text-xs font-medium text-epic-text transition-colors hover:border-epic-border-hover hover:bg-epic-hover"
      >
        Browse API operations
        <ChevronRight className="h-3.5 w-3.5 text-epic-accent" />
      </Link>
    </div>
  );
}
