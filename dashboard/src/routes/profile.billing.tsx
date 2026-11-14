import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  ReceiptText,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, buttonStyles } from "../components/ui/Button";
import { Badge, Tag } from "../components/ui/Controls";
import { Dialog, Heading, Modal } from "../components/ui/Modal";
import { Form, TextField } from "../components/ui/TextField";
import { notify } from "../components/ui/Toast";
import {
  type BillingPlansResponse,
  type BillingPurchaseReceipt,
  type BillingWithdrawalRecord,
  dashboardClient,
  type ProjectBillingSummaryResponse,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/profile/billing")({
  component: ProfileBillingPage,
});

function formatEur(cents: number, currency = "eur") {
  return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

function formatDate(isoOrEpoch: string | number) {
  return new Date(isoOrEpoch).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function downloadReceiptJson(receipt: BillingPurchaseReceipt) {
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

function ProfileBillingPage() {
  const { projects, account, paidPlansEnabled, refreshSession } =
    useDashboardAuth();
  const [plansData, setPlansData] = useState<BillingPlansResponse | null>(null);
  const [summaries, setSummaries] = useState<ProjectBillingSummaryResponse[]>(
    [],
  );
  const [receipts, setReceipts] = useState<BillingPurchaseReceipt[]>([]);
  const [withdrawals, setWithdrawals] = useState<BillingWithdrawalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [ackByProject, setAckByProject] = useState<Record<string, boolean>>({});

  const [cancelTarget, setCancelTarget] =
    useState<ProjectBillingSummaryResponse | null>(null);
  const [withdrawTarget, setWithdrawTarget] =
    useState<ProjectBillingSummaryResponse | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");

  const [checkoutBanner] = useState(() => {
    if (typeof window === "undefined") return null;
    const status = new URLSearchParams(window.location.search).get("checkout");
    return status === "success" || status === "canceled" ? status : null;
  });

  const loadAll = useCallback(
    async (signal?: AbortSignal) => {
      if (!paidPlansEnabled) {
        setLoading(false);
        return;
      }
      setError("");
      try {
        const [plansRes, receiptsRes, projectSummaries] = await Promise.all([
          dashboardClient.getBillingPlans(),
          dashboardClient.getBillingReceipts(signal),
          Promise.all(
            projects.map((p) =>
              dashboardClient.getProjectBilling(p.id, signal),
            ),
          ),
        ]);
        if (signal?.aborted) return;
        setPlansData(plansRes);
        setReceipts(receiptsRes.receipts);
        setWithdrawals(receiptsRes.withdrawals);
        setSummaries(projectSummaries);
      } catch (err) {
        if (!signal?.aborted) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not load billing details.",
          );
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [paidPlansEnabled, projects],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void loadAll(controller.signal);
    return () => controller.abort();
  }, [loadAll]);

  const activeReceiptByProject = useMemo(() => {
    const map = new Map<string, BillingPurchaseReceipt>();
    const now = Date.now();
    for (const rcpt of receipts) {
      if (rcpt.withdrawal_expires_at > now && !map.has(rcpt.project_id)) {
        map.set(rcpt.project_id, rcpt);
      }
    }
    return map;
  }, [receipts]);

  async function handleOpenPortal() {
    setBusyKey("portal");
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
      setBusyKey(null);
    }
  }

  async function handleCheckout(projectId: string, planId: "pro" | "scale") {
    if (!plansData) return;
    if (!ackByProject[projectId]) {
      notify({
        title: "Confirmation required",
        description:
          "Please confirm the EUR VAT-inclusive pricing, monthly renewal terms, and 14-day withdrawal notice first.",
        tone: "info",
      });
      return;
    }
    setBusyKey(`checkout:${projectId}:${planId}`);
    try {
      const res = await dashboardClient.startBillingCheckout({
        projectId,
        planId,
        termsVersion: plansData.termsVersion,
        withdrawalAcknowledged: true,
      });
      if (res.checkoutUrl) {
        window.location.assign(res.checkoutUrl);
        return;
      }
      notify({
        title: "Checkout session already pending",
        description:
          "Complete the existing Stripe Checkout session or refresh billing status shortly.",
        tone: "info",
      });
      await loadAll();
    } catch (err) {
      notify({
        title: "Checkout could not start",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function handleChangePlan(
    projectId: string,
    targetPlanId: "free" | "pro" | "scale",
  ) {
    setBusyKey(`change:${projectId}:${targetPlanId}`);
    try {
      const res = await dashboardClient.changeSubscriptionPlan({
        projectId,
        targetPlanId,
      });
      setCancelTarget(null);
      await Promise.all([refreshSession(), loadAll()]);
      notify({
        title:
          targetPlanId === "free"
            ? "Subscription cancellation scheduled"
            : res.scheduledForPeriodEnd
              ? "Downgrade scheduled for period end"
              : "Subscription upgraded",
        description: res.scheduledForPeriodEnd
          ? "Your current plan capacity remains active until the end of this billing period."
          : "Higher capacity is active immediately with consumed period usage preserved.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Plan change failed",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCancelPendingCheckout(projectId: string) {
    setBusyKey(`cancel_pending:${projectId}`);
    try {
      const res = await dashboardClient.cancelPendingBillingCheckout(projectId);
      await loadAll();
      notify({
        title: res.alreadyCompleted
          ? "Subscription already completed"
          : "Pending checkout canceled",
        description: res.alreadyCompleted
          ? "Your payment completed and subscription status has been refreshed."
          : "You can start a fresh checkout whenever you're ready.",
        tone: res.alreadyCompleted ? "success" : "info",
      });
    } catch (err) {
      notify({
        title: "Could not cancel pending checkout",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function handleWithdrawalSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!withdrawTarget) return;
    setBusyKey(`withdraw:${withdrawTarget.project.id}`);
    try {
      const res = await dashboardClient.requestWithdrawal({
        projectId: withdrawTarget.project.id,
        reason: withdrawReason.trim() || undefined,
      });
      setWithdrawTarget(null);
      setWithdrawReason("");
      await Promise.all([refreshSession(), loadAll()]);
      notify({
        title: "Refund and cancellation processed",
        description: `${res.requestKind === "statutory_withdrawal" ? "14-day statutory withdrawal" : "Refund"} completed (${res.status}).`,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Refund request failed",
        description: err instanceof Error ? err.message : "Contact support.",
        tone: "danger",
      });
    } finally {
      setBusyKey(null);
    }
  }

  if (!paidPlansEnabled) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Billing &amp; subscriptions
          </h1>
          <p className="text-sm text-epic-text-muted max-w-2xl leading-relaxed">
            Self-service paid plans and Stripe billing are currently paused.
          </p>
        </div>
        <div className="rounded-2xl border border-epic-border bg-epic-surface p-6 space-y-4">
          <p className="text-sm text-epic-text">
            If your integration requires higher rate limits or additional
            projects while paid plans are paused, submit a manual review request
            on the Rate Limits page.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <Link
              to="/limits"
              className={buttonStyles({ variant: "primary", size: "sm" })}
            >
              Rate limits &amp; quota requests
            </Link>
            <Link
              to="/profile"
              className={buttonStyles({ variant: "secondary", size: "sm" })}
            >
              Back to profile
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Billing &amp; subscriptions
          </h1>
          <p className="text-sm text-epic-text-muted max-w-2xl leading-relaxed">
            Manage plans across your projects: upgrade or downgrade tiers,
            cancel renewals, submit 14-day withdrawal requests, or open the
            Stripe Billing Portal for payment methods and downloadable invoices.
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Link
            to="/profile/receipts"
            className={buttonStyles({ variant: "secondary", size: "sm" })}
          >
            <ReceiptText className="w-4 h-4" aria-hidden="true" />
            Purchase &amp; agreement receipts
          </Link>
          <Button
            variant="primary"
            size="sm"
            isPending={busyKey === "portal"}
            onPress={() => void handleOpenPortal()}
          >
            <CreditCard className="w-4 h-4" aria-hidden="true" />
            Stripe Billing Portal &amp; Invoices
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {checkoutBanner === "success" && (
        <div className="rounded-xl border border-epic-success/40 bg-epic-success/10 p-4 text-sm text-epic-text flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-epic-success shrink-0" />
          <span>
            Checkout completed. Your subscription activation is synced via
            Stripe webhooks and usually appears within seconds.
          </span>
        </div>
      )}

      {checkoutBanner === "canceled" && (
        <div className="rounded-xl border border-epic-border bg-epic-surface p-4 text-sm text-epic-text-muted">
          Checkout was canceled before payment. Your project plans remain
          unchanged.
        </div>
      )}

      {account?.enabled && !account.eligible && (
        <div className="rounded-xl border border-epic-warning/40 bg-epic-warning/10 p-4 text-sm flex flex-wrap items-center justify-between gap-3">
          <p className="text-epic-text">
            Complete developer onboarding (email verification &amp; Developer
            Terms) to start or modify paid subscriptions. Billing Portal and
            receipts remain accessible.
          </p>
          <Link
            to="/profile/agreements"
            className={buttonStyles({ variant: "secondary", size: "sm" })}
          >
            Finish setup
          </Link>
        </div>
      )}

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-epic-danger/30 bg-epic-surface p-6 space-y-3"
        >
          <p className="text-sm text-epic-danger">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              setLoading(true);
              void loadAll();
            }}
          >
            Retry
          </Button>
        </div>
      ) : loading ? (
        <output className="block rounded-xl border border-epic-border bg-epic-surface p-8 text-sm text-epic-text-muted">
          Loading project subscriptions and billing history…
        </output>
      ) : summaries.length === 0 ? (
        <div className="rounded-2xl border border-epic-border bg-epic-surface p-8 text-sm text-epic-text-muted">
          You have no active projects yet. Create a project in the dashboard to
          subscribe to a paid plan.
        </div>
      ) : (
        <div className="space-y-4">
          {summaries.map((summary) => {
            const sub =
              summary.subscription &&
              summary.subscription.status !== "incomplete_expired"
                ? summary.subscription
                : null;
            const ent = summary.entitlement;
            const isLiveSub = Boolean(
              sub && ["active", "trialing", "past_due"].includes(sub.status),
            );
            const isManualGrant =
              ent.grantSource === "manual" ||
              ent.grantSource === "grandfathered";
            const withdrawalReceipt = activeReceiptByProject.get(
              summary.project.id,
            );
            const canChange = account?.eligible !== false;

            return (
              <section
                key={summary.project.id}
                aria-label={`Billing for ${summary.project.name}`}
                className="rounded-2xl border border-epic-border bg-epic-surface p-6 space-y-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2 className="text-lg font-semibold text-white">
                        {summary.project.name}
                      </h2>
                      <Tag
                        tone={
                          ent.tier === "free"
                            ? "neutral"
                            : ent.tier === "pro"
                              ? "success"
                              : "accent"
                        }
                      >
                        {ent.tier.toUpperCase()} PLAN
                      </Tag>
                      {sub && (
                        <Badge
                          tone={
                            sub.status === "active"
                              ? "success"
                              : sub.status === "past_due" ||
                                  sub.status === "trialing"
                                ? "warning"
                                : sub.status === "canceled" ||
                                    sub.status === "unpaid"
                                  ? "danger"
                                  : "neutral"
                          }
                        >
                          {sub.status}
                        </Badge>
                      )}
                      {sub?.cancelAtPeriodEnd && (
                        <Badge tone="warning">Cancels at period end</Badge>
                      )}
                    </div>
                    <p className="font-mono text-xs text-epic-text-muted">
                      {summary.project.id} · {ent.rpmLimit.toLocaleString()}{" "}
                      req/min
                      {ent.periodAllowance
                        ? ` · ${ent.periodAllowance.toLocaleString()} req / ${
                            ent.periodType === "billing_period"
                              ? "billing period"
                              : "UTC month"
                          }`
                        : ""}
                    </p>
                  </div>

                  {(summary.usage || summary.dailyUsage) && (
                    <div className="flex flex-wrap gap-6 text-right text-xs">
                      {summary.dailyUsage && (
                        <div>
                          <div className="text-epic-text-muted">
                            Daily usage (initial{" "}
                            {plansData?.initialPeriodDailyLimitDays ?? 14}d cap)
                          </div>
                          <div className="font-mono text-sm text-white tabular-nums">
                            {summary.dailyUsage.used.toLocaleString()} /{" "}
                            {summary.dailyUsage.allowance.toLocaleString()}
                          </div>
                        </div>
                      )}
                      {summary.usage && (
                        <div>
                          <div className="text-epic-text-muted">
                            Period usage
                          </div>
                          <div className="font-mono text-sm text-white tabular-nums">
                            {summary.usage.used.toLocaleString()} /{" "}
                            {summary.usage.allowance.toLocaleString()}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {sub && sub.status === "checkout_pending" && (
                  <div className="rounded-xl border border-epic-border bg-epic-bg/40 p-4 text-xs flex flex-wrap items-center justify-between gap-3">
                    <span className="text-epic-text-muted">
                      Pending Stripe Checkout for{" "}
                      <strong className="font-mono text-white">
                        {sub.planVersionId}
                      </strong>{" "}
                      (payment not completed yet). Click Subscribe below to
                      resume or switch plans.
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      isPending={
                        busyKey === `cancel_pending:${summary.project.id}`
                      }
                      onPress={() =>
                        void handleCancelPendingCheckout(summary.project.id)
                      }
                    >
                      Cancel pending checkout
                    </Button>
                  </div>
                )}

                {sub && sub.status !== "checkout_pending" && (
                  <div className="rounded-xl border border-epic-border bg-epic-bg/40 p-4 text-xs space-y-1.5">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-epic-text-muted">
                      <span>
                        Plan version:{" "}
                        <strong className="font-mono text-white">
                          {sub.planVersionId}
                        </strong>
                      </span>
                      <span>
                        Billing period:{" "}
                        <strong className="text-white">
                          {formatDate(sub.currentPeriodStart)} →{" "}
                          {formatDate(sub.currentPeriodEnd)}
                        </strong>
                      </span>
                      {sub.pendingPlanVersionId && (
                        <span className="text-epic-warning">
                          Scheduled change at period end:{" "}
                          <strong className="font-mono">
                            {sub.pendingPlanVersionId}
                          </strong>
                        </span>
                      )}
                    </div>
                    {sub.graceUntil && (
                      <p className="text-epic-warning flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        Payment past due. Update your payment method in the
                        Stripe Billing Portal before{" "}
                        {formatDate(sub.graceUntil)} to avoid reverting to Free.
                      </p>
                    )}
                    {sub.disputeStatus !== "none" && (
                      <p className="text-epic-danger">
                        Dispute status: {sub.disputeStatus}
                      </p>
                    )}
                    {sub.refundedEurCents > 0 && (
                      <p className="text-epic-text-muted">
                        Refunded: {formatEur(sub.refundedEurCents)} (
                        {sub.refundStatus})
                      </p>
                    )}
                  </div>
                )}

                {isManualGrant && (
                  <div className="rounded-xl border border-epic-accent/30 bg-epic-accent/5 p-3.5 text-xs text-epic-text">
                    This project has an active{" "}
                    <strong>{ent.grantSource}</strong> capacity grant (
                    {ent.rpmLimit.toLocaleString()} req/min
                    {ent.reason ? ` · ${ent.reason}` : ""}). Contact support to
                    modify custom grants.
                  </div>
                )}

                {!isLiveSub && !isManualGrant && plansData && (
                  <div className="space-y-3 pt-1">
                    {summary.selfServeCheckoutBlocked ? (
                      <div className="rounded-xl border border-epic-warning/40 bg-epic-warning/10 p-3.5 text-xs text-epic-text">
                        Self-serve paid checkout is unavailable on this account
                        because a previous {plansData.withdrawalWindowDays}-day
                        statutory withdrawal refund was already issued. Use{" "}
                        <Link
                          to="/limits"
                          className="underline text-epic-accent font-medium"
                        >
                          Request Manual / Custom Limits
                        </Link>{" "}
                        to request manual onboarding.
                      </div>
                    ) : (
                      <label className="flex items-start gap-2.5 rounded-xl border border-epic-border bg-epic-bg/60 p-3.5 text-xs text-epic-text-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(ackByProject[summary.project.id])}
                          onChange={(e) =>
                            setAckByProject((prev) => ({
                              ...prev,
                              [summary.project.id]: e.target.checked,
                            }))
                          }
                          className="mt-0.5 rounded border-epic-border"
                        />
                        <span>
                          I confirm monthly recurring billing in EUR (VAT
                          included for consumers), hard request caps with an
                          initial {plansData.initialPeriodDailyLimitDays}-day
                          daily pacing limit, and expressly request immediate
                          API access during the{" "}
                          <strong className="text-epic-text">
                            {plansData.withdrawalWindowDays}-day statutory
                            withdrawal right
                          </strong>{" "}
                          with time-based{" "}
                          <strong className="text-epic-text">
                            pro-rata deduction
                          </strong>{" "}
                          if withdrawn early (once per account).
                        </span>
                      </label>
                    )}
                    <div className="flex flex-wrap gap-2.5">
                      {plansData.plans
                        .filter((p) => p.selfServePurchasable)
                        .map((plan) => (
                          <Button
                            key={plan.versionId}
                            variant={
                              plan.planId === "scale" ? "secondary" : "primary"
                            }
                            size="sm"
                            isDisabled={
                              !canChange || summary.selfServeCheckoutBlocked
                            }
                            isPending={
                              busyKey ===
                              `checkout:${summary.project.id}:${plan.planId}`
                            }
                            onPress={() =>
                              void handleCheckout(
                                summary.project.id,
                                plan.planId as "pro" | "scale",
                              )
                            }
                          >
                            Subscribe to {plan.displayName} (EUR{" "}
                            {(plan.priceEurCents / 100).toFixed(0)}/mo
                            {plan.initialDailyLimit
                              ? ` · ${plan.initialDailyLimit.toLocaleString()}/day first ${plansData.initialPeriodDailyLimitDays}d`
                              : ""}
                            )
                          </Button>
                        ))}
                    </div>
                  </div>
                )}

                {isLiveSub && sub && (
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-epic-border">
                    <div className="flex flex-wrap gap-2.5">
                      {ent.planId === "pro" && (
                        <Button
                          variant="primary"
                          size="sm"
                          isDisabled={!canChange}
                          isPending={
                            busyKey === `change:${summary.project.id}:scale`
                          }
                          onPress={() =>
                            void handleChangePlan(summary.project.id, "scale")
                          }
                        >
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          Upgrade to Scale (prorated)
                        </Button>
                      )}
                      {ent.planId === "scale" &&
                        sub.pendingPlanVersionId !== "pro-v1" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            isDisabled={!canChange}
                            isPending={
                              busyKey === `change:${summary.project.id}:pro`
                            }
                            onPress={() =>
                              void handleChangePlan(summary.project.id, "pro")
                            }
                          >
                            <ArrowDownRight className="w-3.5 h-3.5" />
                            Downgrade to Pro (at period end)
                          </Button>
                        )}
                      {!sub.cancelAtPeriodEnd && (
                        <Button
                          variant="secondary"
                          size="sm"
                          isDisabled={!canChange}
                          onPress={() => setCancelTarget(summary)}
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Cancel subscription
                        </Button>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      {summary.withdrawalEligible ? (
                        <>
                          {(summary.withdrawalExpiresAt ||
                            withdrawalReceipt) && (
                            <span className="text-xs text-epic-text-muted">
                              14-day withdrawal open until{" "}
                              {formatDate(
                                summary.withdrawalExpiresAt ??
                                  withdrawalReceipt?.withdrawal_expires_at ??
                                  0,
                              )}
                            </span>
                          )}
                          <Button
                            variant="destructive"
                            size="sm"
                            onPress={() => {
                              setWithdrawReason("");
                              setWithdrawTarget(summary);
                            }}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            14-day Withdrawal / Pro-Rata Refund
                          </Button>
                        </>
                      ) : (
                        <span className="text-xs text-epic-text-muted">
                          14-day withdrawal window ended
                          {summary.withdrawalExpiresAt
                            ? ` (${formatDate(summary.withdrawalExpiresAt)})`
                            : ""}
                          . Use Cancel subscription to stop renewals.
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {!loading && (receipts.length > 0 || withdrawals.length > 0) && (
        <section
          aria-label="Recent purchase receipts"
          className="rounded-2xl border border-epic-border bg-epic-surface p-6 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-epic-accent" />
                Recent Purchase Receipts &amp; Refunds
              </h2>
              <p className="text-xs text-epic-text-muted mt-0.5">
                Download your egdata purchase records here or open the Stripe
                Billing Portal for official VAT invoices.
              </p>
            </div>
            <Link
              to="/profile/receipts"
              className={buttonStyles({ variant: "quiet", size: "sm" })}
            >
              View all receipts
            </Link>
          </div>

          <div className="divide-y divide-epic-border rounded-xl border border-epic-border overflow-hidden">
            {receipts.slice(0, 5).map((rcpt) => (
              <div
                key={rcpt.id}
                className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs bg-epic-bg/30"
              >
                <div className="space-y-0.5">
                  <div className="font-medium text-white">
                    {rcpt.project_name ?? rcpt.project_id} ·{" "}
                    <span className="font-mono">{rcpt.plan_version_id}</span> ·{" "}
                    {formatEur(rcpt.price_eur_cents, rcpt.currency)} (VAT incl.)
                  </div>
                  <div className="text-epic-text-muted font-mono">
                    {rcpt.id} · {formatDate(rcpt.accepted_at)}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => downloadReceiptJson(rcpt)}
                >
                  <Download className="w-3.5 h-3.5" />
                  Download JSON
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Cancel Confirmation Modal */}
      <Modal
        isOpen={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busyKey) setCancelTarget(null);
        }}
        size="md"
      >
        <Dialog>
          <Heading slot="title" className="text-lg font-semibold mb-2">
            Cancel subscription · {cancelTarget?.project.name}
          </Heading>
          <p className="text-sm text-epic-text-muted leading-relaxed mb-5">
            Your subscription will remain active until{" "}
            <strong className="text-white">
              {cancelTarget?.subscription
                ? formatDate(cancelTarget.subscription.currentPeriodEnd)
                : "the end of the billing period"}
            </strong>
            , after which this project reverts to the Free plan. No further
            monthly renewals will be charged.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              isDisabled={Boolean(busyKey)}
              onPress={() => setCancelTarget(null)}
            >
              Keep subscription
            </Button>
            <Button
              variant="destructive"
              isPending={
                Boolean(cancelTarget) &&
                busyKey === `change:${cancelTarget?.project.id}:free`
              }
              onPress={() => {
                if (cancelTarget) {
                  void handleChangePlan(cancelTarget.project.id, "free");
                }
              }}
            >
              Confirm cancellation at period end
            </Button>
          </div>
        </Dialog>
      </Modal>

      {/* Withdrawal / Refund Modal */}
      <Modal
        isOpen={withdrawTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busyKey) setWithdrawTarget(null);
        }}
        size="md"
      >
        <Dialog>
          <Form onSubmit={handleWithdrawalSubmit}>
            <Heading slot="title" className="text-lg font-semibold">
              Withdrawal &amp; refund · {withdrawTarget?.project.name}
            </Heading>
            <p className="text-sm text-epic-text-muted leading-relaxed">
              Submitting a withdrawal cancels the subscription immediately and
              issues a time-based pro-rata refund via Stripe for remaining
              unused time within the 14-day statutory withdrawal window. Paid
              capacity reverts to Free right away, and self-serve paid checkouts
              are disabled for this account afterward.
            </p>
            <TextField
              label="Reason (optional)"
              value={withdrawReason}
              onChange={setWithdrawReason}
              maxLength={500}
              placeholder="No longer needed"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                isDisabled={Boolean(busyKey)}
                onPress={() => setWithdrawTarget(null)}
              >
                Keep subscription
              </Button>
              <Button
                type="submit"
                variant="destructive"
                isPending={
                  Boolean(withdrawTarget) &&
                  busyKey === `withdraw:${withdrawTarget?.project.id}`
                }
              >
                Confirm withdrawal &amp; refund
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>
    </div>
  );
}
