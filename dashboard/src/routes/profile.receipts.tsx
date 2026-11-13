import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Check,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Printer,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, buttonStyles } from "../components/ui/Button";
import { Badge } from "../components/ui/Controls";
import { notify } from "../components/ui/Toast";
import {
  type BillingPurchaseReceipt,
  type BillingWithdrawalRecord,
  type DeveloperReceipt,
  dashboardClient,
} from "../lib/api";
import { renderMarkdown } from "../lib/docs/markdown";

export const Route = createFileRoute("/profile/receipts")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { receipt?: string; tab?: "billing" | "agreements" } => ({
    receipt: typeof search.receipt === "string" ? search.receipt : undefined,
    tab:
      search.tab === "billing" || search.tab === "agreements"
        ? search.tab
        : undefined,
  }),
  component: ReceiptsPage,
});

function formatEur(cents: number, currency = "eur") {
  return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

function downloadPurchaseReceipt(receipt: BillingPurchaseReceipt) {
  const payload = {
    receiptId: receipt.id,
    projectId: receipt.project_id,
    projectName: receipt.project_name,
    subscriptionId: receipt.subscription_id,
    stripeCheckoutSessionId: receipt.stripe_checkout_session_id,
    planVersionId: receipt.plan_version_id,
    amount: formatEur(receipt.price_eur_cents, receipt.currency),
    priceEurCents: receipt.price_eur_cents,
    currency: receipt.currency,
    vatIncluded: receipt.vat_included === 1,
    termsVersion: receipt.terms_version,
    actionType: receipt.action_type,
    acceptedAtUtc: new Date(receipt.accepted_at).toISOString(),
    withdrawalWindowExpiresAtUtc: new Date(
      receipt.withdrawal_expires_at,
    ).toISOString(),
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `egdata-purchase-receipt-${receipt.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

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
  const { receipt: requested, tab: requestedTab } = Route.useSearch();
  const [receipts, setReceipts] = useState<DeveloperReceipt[] | null>(null);
  const [billingReceipts, setBillingReceipts] = useState<
    BillingPurchaseReceipt[] | null
  >(null);
  const [withdrawals, setWithdrawals] = useState<BillingWithdrawalRecord[]>([]);
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<string | null>(
    null,
  );
  const [manualTab, setManualTab] = useState<"billing" | "agreements" | null>(
    requested ? "agreements" : (requestedTab ?? null),
  );
  const [openingPortal, setOpeningPortal] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit user-triggered reload key.
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setReceipts(null);
    setBillingReceipts(null);
    void Promise.all([
      dashboardClient.getAgreementReceipts(controller.signal),
      dashboardClient
        .getBillingReceipts(controller.signal)
        .catch(() => ({ receipts: [], withdrawals: [] })),
    ])
      .then(([agreementRes, billingRes]) => {
        if (controller.signal.aborted) return;
        setReceipts(agreementRes.acceptances);
        setBillingReceipts(billingRes.receipts);
        setWithdrawals(billingRes.withdrawals);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Could not load receipts.",
          );
        }
      });
    return () => controller.abort();
  }, [retry]);

  const activeTab: "billing" | "agreements" =
    manualTab ??
    (requested
      ? "agreements"
      : billingReceipts &&
          (billingReceipts.length > 0 || withdrawals.length > 0)
        ? "billing"
        : "agreements");

  const receipt = requested
    ? receipts?.find((item) => item.receipt_id === requested)
    : receipts?.[0];

  const purchaseReceipt = useMemo(() => {
    if (!billingReceipts || billingReceipts.length === 0) return null;
    if (selectedPurchaseId) {
      return (
        billingReceipts.find((r) => r.id === selectedPurchaseId) ??
        billingReceipts[0]
      );
    }
    return billingReceipts[0];
  }, [billingReceipts, selectedPurchaseId]);

  useEffect(() => {
    const targetId =
      activeTab === "billing" ? purchaseReceipt?.id : receipt?.receipt_id;
    if (!targetId) return;
    const previousTitle = document.title;
    document.title = `egdata-receipt-${targetId}`;
    return () => {
      document.title = previousTitle;
    };
  }, [activeTab, purchaseReceipt, receipt]);

  async function openPortal() {
    setOpeningPortal(true);
    try {
      const portal = await dashboardClient.createBillingPortal(
        window.location.href,
      );
      window.location.assign(portal.url);
    } catch (err) {
      notify({
        title: "Could not open Billing Portal",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
      setOpeningPortal(false);
    }
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Receipts</h1>
          <p className="text-sm text-epic-text-muted leading-relaxed">
            Printable and downloadable records for your paid-plan purchases,
            withdrawal requests, and Developer Terms acceptances.
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Link
            to="/profile/billing"
            className={buttonStyles({ variant: "secondary", size: "sm" })}
          >
            Manage subscriptions
          </Link>
          <Button
            variant="secondary"
            size="sm"
            isPending={openingPortal}
            onPress={() => void openPortal()}
          >
            <CreditCard className="h-4 w-4" aria-hidden="true" />
            Stripe Invoices (Portal)
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Receipt categories"
        className="mb-6 flex flex-wrap gap-2 print:hidden"
      >
        <Button
          variant={activeTab === "billing" ? "primary" : "secondary"}
          size="sm"
          onPress={() => setManualTab("billing")}
        >
          Purchase &amp; Billing ({billingReceipts?.length ?? 0})
        </Button>
        <Button
          variant={activeTab === "agreements" ? "primary" : "secondary"}
          size="sm"
          onPress={() => setManualTab("agreements")}
        >
          Agreement Receipts ({receipts?.length ?? 0})
        </Button>
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
      ) : !receipts || !billingReceipts ? (
        <output className="text-epic-text-muted">Loading receipts…</output>
      ) : activeTab === "billing" ? (
        <div className="space-y-8">
          {!purchaseReceipt ? (
            <section className="rounded-2xl border border-epic-border bg-epic-surface p-8 space-y-4">
              <CreditCard
                className="h-8 w-8 text-epic-text-muted"
                aria-hidden="true"
              />
              <h2 className="text-xl font-semibold">
                No purchase receipts yet
              </h2>
              <p className="text-sm text-epic-text-muted">
                When you subscribe to Pro or Scale, each checkout confirmation
                receipt and refund record appears here alongside your Stripe
                invoices.
              </p>
              <Link
                to="/profile/billing"
                className={buttonStyles({ variant: "secondary" })}
              >
                View plans &amp; billing
              </Link>
            </section>
          ) : (
            <>
              {billingReceipts.length > 1 && (
                <nav
                  aria-label="Purchase receipt history"
                  className="flex flex-wrap gap-2 print:hidden"
                >
                  {billingReceipts.map((item) => (
                    <Button
                      key={item.id}
                      variant={
                        purchaseReceipt.id === item.id ? "primary" : "secondary"
                      }
                      size="sm"
                      onPress={() => setSelectedPurchaseId(item.id)}
                    >
                      {item.project_name ?? item.project_id} ·{" "}
                      {item.plan_version_id} ·{" "}
                      {new Date(item.accepted_at).toLocaleDateString()}
                    </Button>
                  ))}
                </nav>
              )}

              <div className="flex flex-wrap gap-3 print:hidden">
                <Button onPress={() => window.print()}>
                  <Printer className="h-4 w-4" aria-hidden="true" /> Print /
                  Save as PDF
                </Button>
                <Button
                  variant="secondary"
                  onPress={() => downloadPurchaseReceipt(purchaseReceipt)}
                >
                  <Download className="h-4 w-4" aria-hidden="true" /> Download
                  JSON receipt
                </Button>
              </div>

              <article
                key={purchaseReceipt.id}
                aria-label="Purchase receipt"
                className="agreement-receipt rounded-2xl border border-epic-border bg-epic-surface p-5 sm:p-8 space-y-6"
              >
                <header className="space-y-3 border-b border-epic-border pb-6">
                  <p className="text-xs font-semibold uppercase tracking-widest text-epic-accent">
                    egdata Developers · Purchase Receipt
                  </p>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    Subscription checkout record
                  </h2>
                  <p className="flex items-center gap-2 text-sm text-epic-success">
                    <ShieldCheck
                      className="h-5 w-5 shrink-0"
                      aria-hidden="true"
                    />
                    {formatEur(
                      purchaseReceipt.price_eur_cents,
                      purchaseReceipt.currency,
                    )}{" "}
                    (
                    {purchaseReceipt.vat_included
                      ? "VAT included"
                      : "Excl. VAT"}
                    ) · {purchaseReceipt.plan_version_id}
                  </p>
                </header>

                <dl className="grid gap-5 sm:grid-cols-2 text-sm">
                  <div>
                    <dt className="text-epic-text-muted mb-1">Receipt ID</dt>
                    <dd className="font-mono text-xs break-all select-all">
                      {purchaseReceipt.id}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-epic-text-muted mb-1">
                      Recorded at (UTC)
                    </dt>
                    <dd>
                      <time
                        dateTime={new Date(
                          purchaseReceipt.accepted_at,
                        ).toISOString()}
                      >
                        {new Date(purchaseReceipt.accepted_at)
                          .toISOString()
                          .replace("T", " ")
                          .replace(/\.\d+Z$/, " UTC")}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-epic-text-muted mb-1">Project</dt>
                    <dd className="text-xs">
                      <span className="font-medium">
                        {purchaseReceipt.project_name ??
                          purchaseReceipt.project_id}
                      </span>{" "}
                      <span className="font-mono text-epic-text-muted">
                        ({purchaseReceipt.project_id})
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-epic-text-muted mb-1">
                      Plan &amp; billing cadence
                    </dt>
                    <dd className="font-mono text-xs">
                      {purchaseReceipt.plan_version_id} · monthly recurring
                    </dd>
                  </div>
                  <div>
                    <dt className="text-epic-text-muted mb-1">Terms version</dt>
                    <dd className="font-mono text-xs">
                      {purchaseReceipt.terms_version}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-epic-text-muted mb-1">
                      14-day withdrawal window expires
                    </dt>
                    <dd className="text-xs">
                      {new Date(purchaseReceipt.withdrawal_expires_at)
                        .toISOString()
                        .replace("T", " ")
                        .replace(/\.\d+Z$/, " UTC")}
                    </dd>
                  </div>
                  {purchaseReceipt.stripe_checkout_session_id && (
                    <div className="sm:col-span-2">
                      <dt className="text-epic-text-muted mb-1">
                        Stripe checkout session
                      </dt>
                      <dd className="font-mono text-xs break-all select-all">
                        {purchaseReceipt.stripe_checkout_session_id}
                      </dd>
                    </div>
                  )}
                </dl>

                <footer className="text-xs leading-relaxed text-epic-text-muted border-t border-epic-border pt-5">
                  Official Stripe VAT invoices are available anytime in the
                  Stripe Billing Portal. Questions?{" "}
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

          {withdrawals.length > 0 && (
            <section
              aria-label="Withdrawal and refund records"
              className="rounded-2xl border border-epic-border bg-epic-surface p-6 space-y-4 print:hidden"
            >
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-epic-accent" />
                Withdrawals &amp; Refunds
              </h2>
              <div className="divide-y divide-epic-border rounded-xl border border-epic-border overflow-hidden">
                {withdrawals.map((w) => (
                  <div key={w.id} className="p-4 text-xs space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-white">
                        {w.request_kind} ·{" "}
                        {formatEur(
                          w.refunded_amount_cents ||
                            w.requested_amount_cents ||
                            0,
                        )}
                      </span>
                      <Badge
                        tone={
                          w.status.startsWith("refunded")
                            ? "success"
                            : w.status === "failed" || w.status === "denied"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {w.status}
                      </Badge>
                    </div>
                    <p className="text-epic-text-muted">
                      {w.project_name ?? w.project_id} ·{" "}
                      {new Date(w.created_at).toLocaleString()}
                      {w.stripe_refund_id ? ` · ${w.stripe_refund_id}` : ""}
                    </p>
                    {w.reason && <p className="text-epic-text">{w.reason}</p>}
                    {w.resolution_note && (
                      <p className="text-epic-text-muted">
                        {w.resolution_note}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
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
