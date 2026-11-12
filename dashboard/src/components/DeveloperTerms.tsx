import { Download, ExternalLink, FileText, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import type { DeveloperStatus } from "../lib/api";
import { renderMarkdown } from "../lib/docs/markdown";
import { buttonStyles } from "./ui/Button";

export function DeveloperTerms({ account }: { account: DeveloperStatus }) {
  const { terms, privacy } = account;
  const rendered = useMemo(
    () => renderMarkdown(terms?.body ?? ""),
    [terms?.body],
  );
  if (!terms) return null;
  const sections = rendered.headings.filter((heading) => heading.depth === 2);
  const termsUrl = `/terms/${encodeURIComponent(terms.version)}`;

  return (
    <div className="overflow-hidden rounded-2xl border border-epic-border bg-epic-surface">
      <div className="border-b border-epic-border p-5 sm:p-8 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <span className="inline-flex items-center gap-2 text-xs font-medium text-epic-accent">
              <FileText className="h-4 w-4" aria-hidden="true" /> DEVELOPER
              AGREEMENT
            </span>
            <h3 className="text-xl font-semibold tracking-tight">
              Terms of Service
            </h3>
            <p className="text-xs text-epic-text-muted">
              Version {terms.version} · Published{" "}
              {new Date(terms.published_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </p>
          </div>
          <a
            href={termsUrl}
            download
            className={buttonStyles({ variant: "secondary", size: "sm" })}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Save a copy
          </a>
        </div>
        {sections.length > 0 && (
          <details className="group rounded-xl border border-epic-border bg-epic-bg/50">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              In this agreement{" "}
              <span className="font-normal text-epic-text-muted">
                · {sections.length} sections
              </span>
            </summary>
            <nav
              aria-label="Agreement sections"
              className="grid gap-2 border-t border-epic-border p-4 sm:grid-cols-2"
            >
              {sections.map((heading) => (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  className="text-sm text-epic-text-muted hover:text-epic-accent underline-offset-4 hover:underline"
                >
                  {heading.text}
                </a>
              ))}
            </nav>
          </details>
        )}
      </div>
      <article
        aria-label={`Developer Terms version ${terms.version}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded document reader must be keyboard-scrollable.
        tabIndex={0}
        className="max-h-[65dvh] overflow-y-auto overscroll-contain p-5 sm:p-8 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-epic-accent"
      >
        <div
          className="docs-markdown legal-markdown"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes HTML and restricts link protocols; no raw document HTML is accepted.
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      </article>
      <div className="border-t border-epic-border bg-epic-bg/30 p-5 sm:px-8 space-y-4">
        {privacy && (
          <div className="flex gap-3">
            <ShieldCheck
              className="h-5 w-5 shrink-0 text-epic-text-muted mt-0.5"
              aria-hidden="true"
            />
            <div className="space-y-1 text-sm">
              <a
                href={`/privacy/${encodeURIComponent(privacy.version)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-epic-accent hover:underline"
              >
                Privacy Notice{" "}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
              <p className="text-epic-text-muted leading-relaxed">
                How we handle your data and your privacy rights. Provided for
                your information; accepting the terms is not privacy or
                marketing consent.
              </p>
            </div>
          </div>
        )}
        <details className="text-xs text-epic-text-muted">
          <summary className="cursor-pointer py-1 hover:text-epic-text">
            Document details &amp; version history
          </summary>
          <dl className="mt-3 space-y-1">
            <dt className="font-medium">SHA-256 of the published document</dt>
            <dd className="break-all font-mono leading-relaxed select-all">
              {terms.sha256}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3">
            <a
              href={termsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-epic-accent underline"
            >
              Open original text
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a
              href="/legal/history"
              target="_blank"
              rel="noreferrer"
              className="text-epic-accent underline"
            >
              Published versions
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </details>
      </div>
    </div>
  );
}
