import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
  Layers,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { findDoc, loadDocSource } from "../lib/docs/catalog";
import {
  parseFrontmatter,
  type RenderedMarkdown,
  renderMarkdown,
} from "../lib/docs/markdown";
import { type DocEntry, problemType } from "../lib/docs/types";
import { DocsSidebar } from "./DocsSidebar";
import { Button, buttonStyles } from "./ui/Button";
import { Tag } from "./ui/Controls";
import { notify } from "./ui/Toast";

export function DocsArticle({ slug }: { slug: string }) {
  const entry = findDoc(slug);
  if (!entry) return <DocsNotFound slug={slug} />;
  return <DocsArticleView key={entry.slug} entry={entry} />;
}

function statusTone(status?: number) {
  if (!status) return "neutral" as const;
  if (status === 429) return "warning" as const;
  return status >= 500 ? "warning" : "danger";
}

function DocsArticleView({ entry }: { entry: DocEntry }) {
  const navigate = useNavigate();
  const articleRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<RenderedMarkdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    loadDocSource(entry)
      .then((source) => {
        if (cancelled) return;
        const parsed = parseFrontmatter(source.markdown);
        setRendered(renderMarkdown(parsed.markdown));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : "Documentation unavailable.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const related = useMemo(
    () =>
      (entry.related ?? [])
        .map((slug) => findDoc(slug))
        .filter((item): item is DocEntry => Boolean(item)),
    [entry.related],
  );

  const operations = entry.operations ?? [];
  const typeUrl = entry.code ? problemType(entry.code) : null;

  function copyTypeUrl() {
    if (!typeUrl) return;
    void navigator.clipboard.writeText(typeUrl);
    setCopied(true);
    notify({ title: "Copied problem type URL", tone: "info" });
    setTimeout(() => setCopied(false), 1800);
  }

  useEffect(() => {
    const element = articleRef.current;
    if (!element) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || (href !== "/docs" && !href.startsWith("/docs/"))) return;
      event.preventDefault();
      const url = new URL(href, window.location.origin);
      void navigate({
        to: url.pathname as never,
        hash: url.hash ? url.hash.slice(1) : undefined,
      });
    };

    element.addEventListener("click", handleClick);
    return () => element.removeEventListener("click", handleClick);
  }, [navigate]);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <details className="rounded-xl border border-epic-border bg-epic-surface lg:hidden">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-epic-text">
          <span className="inline-flex items-center gap-2">
            <Layers className="h-4 w-4 text-epic-accent" />
            Documentation menu
          </span>
        </summary>
        <div className="max-h-[60vh] overflow-hidden border-t border-epic-border">
          <DocsSidebar currentSlug={entry.slug} />
        </div>
      </details>

      <aside className="sticky top-28 hidden h-[calc(100vh-8.5rem)] flex-col overflow-hidden rounded-xl border border-epic-border bg-epic-surface lg:flex">
        <DocsSidebar currentSlug={entry.slug} />
      </aside>

      <article className="min-w-0 space-y-6">
        <div className="space-y-4 border-b border-epic-border pb-5">
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-1.5 text-xs text-epic-text-muted"
          >
            <Link to="/docs" className="hover:text-epic-text">
              API Reference
            </Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <span>{entry.category}</span>
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="text-epic-text">{entry.title}</span>
          </nav>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-white">
                {entry.title}
              </h1>
              {entry.code && entry.status && (
                <Tag tone={statusTone(entry.status)}>HTTP {entry.status}</Tag>
              )}
            </div>
            <p className="max-w-3xl text-sm leading-relaxed text-epic-text-muted">
              {entry.description}
            </p>
          </div>

          {entry.code && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-epic-border bg-epic-surface px-3 py-2 text-xs">
              <code className="rounded border border-epic-border bg-epic-elevated px-2 py-0.5 font-mono font-semibold text-epic-text">
                {entry.code}
              </code>
              <span className="break-all font-mono text-epic-text-muted">
                {typeUrl}
              </span>
              <button
                type="button"
                onClick={copyTypeUrl}
                className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-1 text-epic-text-muted transition-colors hover:bg-epic-elevated hover:text-epic-text"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-epic-success" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy type
                  </>
                )}
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/docs"
              className={buttonStyles({ variant: "secondary", size: "sm" })}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Browse operations
            </Link>
            {entry.slug === "v1-problems" && (
              <Link
                to="/docs/$slug"
                params={{ slug: "problems" }}
                className={buttonStyles({ variant: "secondary", size: "sm" })}
              >
                <BookOpen className="h-3.5 w-3.5" />
                All problem codes
              </Link>
            )}
          </div>
        </div>

        {loading && (
          <div className="rounded-xl border border-epic-border bg-epic-surface p-8 text-sm text-epic-text-muted">
            Loading documentation…
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2.5 rounded-xl border border-epic-warning/30 bg-epic-warning/10 px-4 py-3 text-sm text-epic-warning"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {rendered && rendered.headings.length > 0 && (
          <details className="rounded-xl border border-epic-border bg-epic-surface/60 text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 font-medium text-epic-text-muted hover:text-epic-text">
              <Info className="h-3.5 w-3.5 text-epic-accent" />
              On this page
            </summary>
            <nav className="space-y-1 border-t border-epic-border/60 px-4 py-3">
              {rendered.headings.map((heading) => (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  className={`block text-epic-text-muted hover:text-epic-accent ${
                    heading.depth >= 3 ? "pl-3" : ""
                  }`}
                >
                  {heading.text}
                </a>
              ))}
            </nav>
          </details>
        )}

        <div
          ref={articleRef}
          className="docs-markdown"
          hidden={loading || Boolean(error) || !rendered}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the documentation is repository-owned static content, not user input.
          dangerouslySetInnerHTML={{ __html: rendered?.html ?? "" }}
        />

        {operations.length > 0 && (
          <section className="space-y-2 rounded-xl border border-epic-border bg-epic-surface p-4">
            <h2 className="text-sm font-semibold text-white">
              Operations that return this code
            </h2>
            <div className="flex flex-wrap gap-2">
              {operations.map((operationId) => (
                <Link
                  key={operationId}
                  to="/docs/$slug"
                  params={{ slug: operationId }}
                  className="rounded-md border border-epic-border bg-epic-elevated px-2.5 py-1 font-mono text-xs text-epic-accent transition-colors hover:border-epic-border-hover hover:bg-epic-hover"
                >
                  {operationId}
                </Link>
              ))}
            </div>
          </section>
        )}

        {related.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-white">Related docs</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {related.map((item) => (
                <Link
                  key={`${item.kind}:${item.slug}`}
                  to="/docs/$slug"
                  params={{ slug: item.slug }}
                  className="group rounded-lg border border-epic-border bg-epic-surface p-3 transition-colors hover:border-epic-border-hover hover:bg-epic-elevated/70"
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-medium text-epic-text group-hover:text-epic-accent">
                    {item.title}
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-epic-text-muted" />
                  </span>
                  <span className="mt-0.5 block text-xs text-epic-text-muted">
                    {item.description}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-epic-border pt-4 text-xs text-epic-text-muted">
          <span>
            Found a documentation problem? Include the request ID and problem
            code when contacting support.
          </span>
          <Button
            variant="quiet"
            size="sm"
            onPress={() => {
              void navigate({ to: "/docs" });
            }}
          >
            <BookOpen className="h-3.5 w-3.5" />
            API reference
          </Button>
        </div>
      </article>
    </div>
  );
}

function DocsNotFound({ slug }: { slug: string }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 rounded-xl border border-epic-border bg-epic-surface p-8 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-epic-warning/30 bg-epic-warning/10">
        <AlertTriangle className="h-5 w-5 text-epic-warning" />
      </div>
      <h1 className="text-xl font-semibold text-white">
        Documentation not found
      </h1>
      <p className="text-sm text-epic-text-muted">
        No guide, problem code, or API operation matches{" "}
        <code className="rounded bg-epic-elevated px-1.5 py-0.5 font-mono text-epic-text">
          {slug}
        </code>
        .
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link
          to="/docs"
          className={buttonStyles({ variant: "secondary", size: "sm" })}
        >
          API reference
        </Link>
        <Link
          to="/docs/$slug"
          params={{ slug: "problems" }}
          className={buttonStyles({ variant: "secondary", size: "sm" })}
        >
          Problem codes
        </Link>
      </div>
    </div>
  );
}
