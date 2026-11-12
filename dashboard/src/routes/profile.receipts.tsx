import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Download, FileText, Printer, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, buttonStyles } from "../components/ui/Button";
import { type DeveloperReceipt, dashboardClient } from "../lib/api";
import { renderMarkdown } from "../lib/docs/markdown";

export const Route = createFileRoute("/profile/receipts")({
  validateSearch: (search: Record<string, unknown>): { receipt?: string } => ({
    receipt: typeof search.receipt === "string" ? search.receipt : undefined,
  }),
  component: ReceiptsPage,
});

function ReceiptDocument({
  document,
  kind,
}: {
  document: DeveloperReceipt["terms"];
  kind: "terms" | "privacy";
}) {
  const [expanded, setExpanded] = useState(false);
  const rendered = useMemo(
    () => renderMarkdown(document.body),
    [document.body],
  );
  return (
    <section className="receipt-document rounded-xl border border-epic-border overflow-hidden">
      <div className="p-5 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold">
              {kind === "terms" ? "Developer Terms" : "Privacy Notice"}
            </h3>
            <p className="text-sm text-epic-text-muted">
              Version {document.version}
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${kind === "terms" ? "bg-epic-success/10 text-epic-success" : "bg-epic-accent-muted text-epic-accent"}`}
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {kind === "terms" ? "Accepted" : "Provided for information"}
          </span>
        </div>
        {kind === "privacy" && (
          <p className="text-sm leading-relaxed text-epic-text-muted">
            This notice was provided alongside the accepted terms. This record
            is not evidence of privacy or marketing consent.
          </p>
        )}
        <div className="flex flex-wrap gap-3 print:hidden">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={expanded}
            aria-controls={`receipt-${kind}-body`}
            onPress={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide document" : "Read full document"}
          </Button>
          <a
            href={`/${kind}/${encodeURIComponent(document.version)}`}
            download
            className={buttonStyles({ variant: "quiet", size: "sm" })}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Save
            original text
          </a>
        </div>
        <details className="receipt-hash text-xs text-epic-text-muted">
          <summary className="cursor-pointer">
            Document fingerprint (SHA-256)
          </summary>
          <p className="break-all font-mono select-all mt-2">
            {document.sha256}
          </p>
        </details>
        <p className="hidden print:block text-xs break-all font-mono">
          SHA-256: {document.sha256}
        </p>
      </div>
      <div
        id={`receipt-${kind}-body`}
        className={`${expanded ? "" : "hidden"} print:block border-t border-epic-border p-5 sm:p-6`}
      >
        <div
          className="docs-markdown legal-markdown"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes raw HTML and validates link protocols.
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      </div>
    </section>
  );
}

function ReceiptsPage() {
  const { receipt: requested } = Route.useSearch();
  const [receipts, setReceipts] = useState<DeveloperReceipt[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit user-triggered reload key.
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setReceipts(null);
    void dashboardClient
      .getAgreementReceipts(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReceipts(result.acceptances);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : "Could not load receipts.",
          );
      });
    return () => controller.abort();
  }, [retry]);
  const receipt = requested
    ? receipts?.find((item) => item.receipt_id === requested)
    : receipts?.[0];
  useEffect(() => {
    if (!receipt) return;
    const previousTitle = document.title;
    document.title = `egdata-receipt-${receipt.receipt_id}`;
    return () => {
      document.title = previousTitle;
    };
  }, [receipt]);
  return (
    <>
      <div className="mb-8 space-y-3 print:hidden">
        <h1 className="text-3xl font-semibold tracking-tight">
          Agreement receipts
        </h1>
        <p className="text-sm text-epic-text-muted leading-relaxed">
          Your record of the terms you accepted and the privacy notice provided
          at the time. Each receipt stays tied to its original event.
        </p>
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-epic-danger/30 p-6 space-y-4"
        >
          <p>{error}</p>
          <Button variant="secondary" onPress={() => setRetry(retry + 1)}>
            Try again
          </Button>
        </div>
      ) : !receipts ? (
        <output className="text-epic-text-muted">Loading receipts…</output>
      ) : !receipt ? (
        <section className="rounded-2xl border border-epic-border bg-epic-surface p-8 space-y-4">
          <FileText
            className="h-8 w-8 text-epic-text-muted"
            aria-hidden="true"
          />
          <h2 className="text-xl font-semibold">
            {requested ? "Receipt not found" : "No receipts yet"}
          </h2>
          <p className="text-sm text-epic-text-muted">
            {requested
              ? "This receipt is not available for your signed-in account."
              : "Your receipt will appear here after you verify your email and accept the Developer Terms."}
          </p>
          <a
            href={requested ? "/profile/receipts" : "/profile/agreements"}
            className={buttonStyles({ variant: "secondary" })}
          >
            {requested ? "View your receipts" : "Go to agreements"}
          </a>
        </section>
      ) : (
        <>
          {receipts.length > 1 && (
            <nav
              aria-label="Receipt history"
              className="mb-6 flex flex-wrap gap-2 print:hidden"
            >
              {receipts.map((item) => (
                <Link
                  key={item.receipt_id}
                  to="/profile/receipts"
                  search={{ receipt: item.receipt_id }}
                  aria-current={
                    receipt.receipt_id === item.receipt_id ? "page" : undefined
                  }
                  className={buttonStyles({
                    variant:
                      receipt.receipt_id === item.receipt_id
                        ? "primary"
                        : "secondary",
                    size: "sm",
                  })}
                >
                  Terms v{item.version} ·{" "}
                  {new Date(item.accepted_at).toLocaleDateString()}
                </Link>
              ))}
            </nav>
          )}
          <div className="mb-5 flex flex-wrap gap-3 print:hidden">
            <Button onPress={() => window.print()}>
              <Printer className="h-4 w-4" aria-hidden="true" /> Print / Save as
              PDF
            </Button>
            <p className="w-full text-xs text-epic-text-muted">
              Choose “Save as PDF” in your browser’s print dialog. The receipt
              and both full documents are included.
            </p>
          </div>
          <article
            key={receipt.receipt_id}
            aria-label="Agreement receipt"
            className="agreement-receipt rounded-2xl border border-epic-border bg-epic-surface p-5 sm:p-8 space-y-6"
          >
            <header className="space-y-3 border-b border-epic-border pb-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-epic-accent">
                egdata Developers · Receipt
              </p>
              <h2 className="text-2xl font-semibold tracking-tight">
                Terms &amp; privacy record
              </h2>
              <p className="flex items-center gap-2 text-sm text-epic-success">
                <ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" />{" "}
                Developer Terms acceptance recorded
              </p>
            </header>
            <dl className="grid gap-5 sm:grid-cols-2 text-sm">
              <div>
                <dt className="text-epic-text-muted mb-1">Receipt ID</dt>
                <dd className="font-mono text-xs break-all select-all">
                  {receipt.receipt_id}
                </dd>
              </div>
              <div>
                <dt className="text-epic-text-muted mb-1">Accepted at (UTC)</dt>
                <dd>
                  <time dateTime={receipt.accepted_at_iso}>
                    {receipt.accepted_at_iso
                      .replace("T", " ")
                      .replace("Z", " UTC")}
                  </time>
                </dd>
              </div>
              <div>
                <dt className="text-epic-text-muted mb-1">Epic account ID</dt>
                <dd className="font-mono text-xs break-all select-all">
                  {receipt.account_id}
                </dd>
              </div>
              <div>
                <dt className="text-epic-text-muted mb-1">
                  Requirement revision
                </dt>
                <dd className="font-mono text-xs break-all select-all">
                  {receipt.requirement_revision}
                </dd>
              </div>
            </dl>
            <ReceiptDocument document={receipt.terms} kind="terms" />
            {receipt.privacy ? (
              <ReceiptDocument document={receipt.privacy} kind="privacy" />
            ) : (
              <section className="rounded-xl border border-epic-border p-6 space-y-2">
                <h3 className="font-semibold">Privacy Notice · not recorded</h3>
                <p className="text-sm leading-relaxed text-epic-text-muted">
                  This older acceptance did not record a privacy notice version.
                  We cannot identify the notice provided at that time from this
                  receipt.
                </p>
              </section>
            )}
            <footer className="text-xs leading-relaxed text-epic-text-muted border-t border-epic-border pt-5">
              These are the documents recorded for this event, even if your
              profile or the current agreements change. Questions?{" "}
              <a
                href="mailto:contact@egdata.app"
                className="text-epic-accent underline"
              >
                contact@egdata.app
              </a>
            </footer>
          </article>
        </>
      )}
    </>
  );
}
