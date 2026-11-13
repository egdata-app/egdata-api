import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Mail,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LimitRequestReviews } from "../components/LimitRequestReviews";
import { Button } from "../components/ui/Button";
import { Tag } from "../components/ui/Controls";
import { Select, SelectItem } from "../components/ui/Select";
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from "../components/ui/TableAndTabs";
import { Form, TextField } from "../components/ui/TextField";
import { notify } from "../components/ui/Toast";
import { MonthlyQuotaPanel } from "../components/usage/MonthlyQuotaPanel";
import {
  type BillingPlansResponse,
  dashboardClient,
  type LimitIncreaseRequestRecord,
  type ProjectBillingSummaryResponse,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/limits")({
  component: RateLimitsPage,
});

const TIER_OPTIONS = [
  { id: "pro", label: "Pro (manual override / custom evaluation)" },
  { id: "scale", label: "Scale (manual override / custom evaluation)" },
  { id: "enterprise", label: "Enterprise (6,000 requests/min)" },
  { id: "custom", label: "Custom limit" },
];

function RateLimitsPage() {
  const { selectedProject, isAdmin, refreshSession } = useDashboardAuth();
  const [contactEmail, setContactEmail] = useState("");
  const [requestedTier, setRequestedTier] = useState<
    "pro" | "scale" | "enterprise" | "custom"
  >("pro");
  const [requestedRpm, setRequestedRpm] = useState("1200");
  const [expectedMonthly, setExpectedMonthly] = useState("1000000");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [useCase, setUseCase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<LimitIncreaseRequestRecord[]>([]);
  const [historyError, setHistoryError] = useState(false);

  const [plansData, setPlansData] = useState<BillingPlansResponse | null>(null);
  const [billingSummary, setBillingSummary] =
    useState<ProjectBillingSummaryResponse | null>(null);
  const [withdrawalAcknowledged, setWithdrawalAcknowledged] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [quotaRefreshKey, setQuotaRefreshKey] = useState(0);
  const [checkoutBanner] = useState(() => {
    if (typeof window === "undefined") return null;
    const status = new URLSearchParams(window.location.search).get("checkout");
    return status === "success" || status === "canceled" ? status : null;
  });
  const canceledSyncStartedRef = useRef(false);

  const loadBilling = useCallback(async () => {
    try {
      const [plansRes, projectRes] = await Promise.all([
        dashboardClient.getBillingPlans(),
        selectedProject
          ? dashboardClient.getProjectBilling(selectedProject.id)
          : Promise.resolve(null),
      ]);
      setPlansData(plansRes);
      setBillingSummary(projectRes);
    } catch {
      // Billing catalog unavailable only in isolated mock environments
    }
  }, [selectedProject]);

  const loadHistory = useCallback(async () => {
    setHistoryError(false);
    try {
      const res = await dashboardClient.getLimitRequests();
      setHistory(res.requests);
    } catch {
      setHistoryError(true);
      notify({
        title: "Could not load request history",
        description: "Reload the page to try again.",
        tone: "danger",
      });
    }
  }, []);

  useEffect(() => {
    const urlProjectId =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("project")
        : null;
    const targetProjectId = urlProjectId || selectedProject?.id;

    if (
      checkoutBanner === "canceled" &&
      targetProjectId &&
      !canceledSyncStartedRef.current
    ) {
      canceledSyncStartedRef.current = true;
      void dashboardClient
        .cancelPendingBillingCheckout(targetProjectId)
        .catch(() => {})
        .finally(() => {
          void Promise.all([loadHistory(), loadBilling()]);
        });
    } else {
      void Promise.all([loadHistory(), loadBilling()]);
    }
    setWebsiteUrl(selectedProject?.websiteUrl ?? "");
  }, [checkoutBanner, loadHistory, loadBilling, selectedProject]);

  async function handleCancelPendingCheckout() {
    if (!selectedProject) return;
    setBillingBusy(true);
    try {
      const res = await dashboardClient.cancelPendingBillingCheckout(
        selectedProject.id,
      );
      await loadBilling();
      notify({
        title: res.alreadyCompleted
          ? "Subscription already completed"
          : "Pending checkout canceled",
        description: res.alreadyCompleted
          ? "Your payment completed and subscription status has been refreshed."
          : "You can start a fresh checkout for Pro or Scale whenever you're ready.",
        tone: res.alreadyCompleted ? "success" : "info",
      });
    } catch (err) {
      notify({
        title: "Could not cancel pending checkout",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
    } finally {
      setBillingBusy(false);
    }
  }

  async function handleCheckout(planId: "pro" | "scale") {
    if (!selectedProject || !plansData) return;
    if (!withdrawalAcknowledged) {
      notify({
        title: "Pre-purchase confirmation required",
        description:
          "Please confirm the EUR VAT-inclusive pricing, monthly recurring terms, and 14-day withdrawal notice first.",
        tone: "info",
      });
      return;
    }
    setBillingBusy(true);
    try {
      const res = await dashboardClient.startBillingCheckout({
        projectId: selectedProject.id,
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
      await loadBilling();
    } catch (err) {
      notify({
        title: "Checkout could not start",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
    } finally {
      setBillingBusy(false);
    }
  }

  async function handleOpenPortal() {
    setBillingBusy(true);
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
      setBillingBusy(false);
    }
  }

  async function handleChangePlan(targetPlanId: "free" | "pro" | "scale") {
    if (!selectedProject) return;
    setBillingBusy(true);
    try {
      const res = await dashboardClient.changeSubscriptionPlan({
        projectId: selectedProject.id,
        targetPlanId,
      });
      await Promise.all([refreshSession(), loadBilling()]);
      setQuotaRefreshKey((value) => value + 1);
      notify({
        title: res.scheduledForPeriodEnd
          ? "Plan change scheduled for period end"
          : "Subscription upgraded",
        description: res.scheduledForPeriodEnd
          ? "Your current capacity stays active until the end of this billing period."
          : "Higher capacity is active immediately. Consumed period usage was preserved.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Plan change failed",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
    } finally {
      setBillingBusy(false);
    }
  }

  async function handleWithdrawal() {
    if (!selectedProject) return;
    setBillingBusy(true);
    try {
      const res = await dashboardClient.requestWithdrawal({
        projectId: selectedProject.id,
        reason: withdrawalReason.trim() || undefined,
      });
      setWithdrawalReason("");
      await Promise.all([refreshSession(), loadBilling()]);
      setQuotaRefreshKey((value) => value + 1);
      notify({
        title: "Refund and cancellation processed",
        description: `${res.requestKind === "statutory_withdrawal" ? "14-day withdrawal" : "Refund"} completed (${res.status}).`,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Refund request failed",
        description: err instanceof Error ? err.message : "Contact support.",
        tone: "danger",
      });
    } finally {
      setBillingBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProject) return;

    setSubmitting(true);
    try {
      const res = await dashboardClient.submitLimitRequest({
        projectId: selectedProject.id,
        contactEmail: contactEmail.trim(),
        requestedTier,
        requestedRpm: Number(requestedRpm),
        expectedMonthlyRequests: Number(expectedMonthly),
        websiteUrl: websiteUrl.trim(),
        useCase: useCase.trim(),
      });

      setUseCase("");
      await loadHistory();
      notify({
        title: "Limit increase request submitted",
        description:
          res.emailDelivery.status === "sent"
            ? "The egdata team has been notified."
            : "Your request has been saved. You can check its status here.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Submission failed",
        description: err instanceof Error ? err.message : "Check form fields",
        tone: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Plans, Rate Limits &amp; Billing
        </h1>
        <p className="text-sm text-epic-text-muted mt-1">
          Self-service monthly plans use fixed EUR consumer pricing (VAT
          included), hard caps, and explicit allowances. Minute ceilings use
          fixed UTC-aligned 60-second windows per project. Billing portal and
          invoices remain available even when quota is exhausted.
        </p>
      </div>

      {checkoutBanner === "success" && (
        <div className="rounded-xl border border-epic-success/40 bg-epic-success/10 p-4 text-xs text-epic-text flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-epic-success shrink-0" />
          <span>
            Checkout completed. Your subscription activation is synced via Stripe
            webhooks and usually appears within seconds.
          </span>
        </div>
      )}

      {checkoutBanner === "canceled" && (
        <div className="rounded-xl border border-epic-border bg-epic-surface p-4 text-xs text-epic-text-muted">
          Checkout was canceled before payment. Your project remains unchanged.
        </div>
      )}

      <MonthlyQuotaPanel showLimitLink={false} refreshKey={quotaRefreshKey} />

      {isAdmin && (
        <LimitRequestReviews
          onReviewed={async () => {
            await Promise.all([refreshSession(), loadHistory(), loadBilling()]);
            setQuotaRefreshKey((value) => value + 1);
          }}
        />
      )}

      {billingSummary?.entitlement.grantSource === "manual" ||
      billingSummary?.entitlement.grantSource === "grandfathered" ? (
        <div className="rounded-xl border border-epic-accent/30 bg-epic-surface p-4 text-xs text-epic-text flex flex-wrap items-center justify-between gap-2">
          <div>
            <strong>Explicit {billingSummary.entitlement.grantSource} grant:</strong>{" "}
            {billingSummary.entitlement.rpmLimit.toLocaleString()} requests/min
            {billingSummary.entitlement.reason
              ? ` · ${billingSummary.entitlement.reason}`
              : ""}
          </div>
          <Tag tone="accent">Non-subscription grant</Tag>
        </div>
      ) : null}

      {/* Commercial Plans Comparison & Self-Service Checkout */}
      {plansData && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-white">
                Monthly Plans (EUR · VAT Included)
              </h2>
              <p className="text-xs text-epic-text-muted">
                Capacity applies to the active project:{" "}
                <strong className="text-epic-text">
                  {selectedProject?.name}
                </strong>
                . Hard caps stop overages automatically with no surprise bills.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              isPending={billingBusy}
              onPress={() => void handleOpenPortal()}
            >
              <CreditCard className="w-3.5 h-3.5" />
              Billing Portal &amp; Invoices
              <ExternalLink className="w-3 h-3" />
            </Button>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {plansData.plans.map((plan) => {
              const isCurrent =
                billingSummary?.entitlement.planId === plan.planId;
              const activeSub = billingSummary?.subscription;
              const hasLiveSub =
                activeSub &&
                ["active", "trialing", "past_due"].includes(activeSub.status);
              return (
                <div
                  key={plan.versionId}
                  className={`rounded-xl p-5 border flex flex-col justify-between gap-4 ${
                    isCurrent
                      ? "bg-epic-surface border-epic-accent/60 shadow-lg shadow-epic-accent/5"
                      : "bg-epic-surface border-epic-border"
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-base font-bold text-white">
                          {plan.displayName}
                        </h3>
                        <div className="text-xl font-bold text-epic-accent mt-0.5">
                          EUR {(plan.priceEurCents / 100).toFixed(0)}
                          <span className="text-xs font-normal text-epic-text-muted">
                            /month {plan.priceEurCents > 0 ? "(VAT incl.)" : ""}
                          </span>
                        </div>
                      </div>
                      {isCurrent && <Tag tone="success">Current</Tag>}
                    </div>

                    <ul className="space-y-1.5 text-xs text-epic-text-muted">
                      <li>
                        •{" "}
                        <strong className="text-epic-text">
                          {plan.periodAllowance.toLocaleString()}
                        </strong>{" "}
                        requests per{" "}
                        {plan.periodType === "calendar_month"
                          ? "UTC calendar month (account-shared)"
                          : "monthly billing period"}
                      </li>
                      <li>
                        •{" "}
                        <strong className="text-epic-text">
                          {plan.rpmLimit}
                        </strong>{" "}
                        global requests/minute
                      </li>
                      {plan.initialDailyLimit !== null && (
                        <li>
                          • Initial {plansData.initialPeriodDailyLimitDays}-day
                          daily cap:{" "}
                          <strong className="text-epic-text">
                            {plan.initialDailyLimit.toLocaleString()}
                          </strong>{" "}
                          requests/UTC day (unpaced quota from Day{" "}
                          {plansData.initialPeriodDailyLimitDays + 1})
                        </li>
                      )}
                      <li>
                        • Budgets: NL Search{" "}
                        {plan.expensivePeriodBudgets["nl-search"].toLocaleString()}
                        , Bulk{" "}
                        {plan.expensivePeriodBudgets.bulk.toLocaleString()}, OG
                        Images{" "}
                        {plan.expensivePeriodBudgets.image.toLocaleString()}
                      </li>
                      <li>• Exhaustion: Hard cap · {plan.supportLevel}</li>
                    </ul>
                  </div>

                  {plan.selfServePurchasable && !hasLiveSub && !isCurrent && (
                    <Button
                      variant="primary"
                      size="sm"
                      isDisabled={Boolean(
                        billingSummary?.selfServeCheckoutBlocked,
                      )}
                      isPending={billingBusy}
                      onPress={() =>
                        void handleCheckout(plan.planId as "pro" | "scale")
                      }
                    >
                      Subscribe to {plan.displayName} (EUR{" "}
                      {(plan.priceEurCents / 100).toFixed(0)}/mo)
                    </Button>
                  )}

                  {plan.selfServePurchasable &&
                    hasLiveSub &&
                    !isCurrent &&
                    plan.planId === "scale" && (
                      <Button
                        variant="primary"
                        size="sm"
                        isPending={billingBusy}
                        onPress={() => void handleChangePlan("scale")}
                      >
                        Upgrade to Scale (prorated)
                      </Button>
                    )}

                  {plan.selfServePurchasable &&
                    hasLiveSub &&
                    !isCurrent &&
                    plan.planId === "pro" && (
                      <Button
                        variant="secondary"
                        size="sm"
                        isPending={billingBusy}
                        onPress={() => void handleChangePlan("pro")}
                      >
                        Downgrade to Pro at period end
                      </Button>
                    )}
                </div>
              );
            })}
          </div>

          {billingSummary?.selfServeCheckoutBlocked &&
            (!billingSummary.subscription ||
              !["active", "trialing", "past_due"].includes(
                billingSummary.subscription.status,
              )) && (
              <div className="rounded-xl border border-epic-warning/40 bg-epic-warning/10 p-3.5 text-xs text-epic-text">
                Self-serve paid checkout is unavailable on this account because
                a previous {plansData.withdrawalWindowDays}-day statutory
                withdrawal refund was already issued. Use the{" "}
                <strong className="text-white">
                  Request Manual / Custom Limits
                </strong>{" "}
                form below to request manual onboarding.
              </div>
            )}

          {(!billingSummary?.subscription ||
            !["active", "trialing", "past_due"].includes(
              billingSummary.subscription.status,
            )) &&
            !billingSummary?.selfServeCheckoutBlocked && (
            <label className="flex items-start gap-2.5 rounded-xl border border-epic-border bg-epic-bg/60 p-3.5 text-xs text-epic-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={withdrawalAcknowledged}
                onChange={(e) => setWithdrawalAcknowledged(e.target.checked)}
                className="mt-0.5 rounded border-epic-border"
              />
              <span>
                I understand subscriptions renew monthly in EUR (VAT included for
                consumers), use hard request caps with an initial{" "}
                <strong className="text-epic-text">
                  {plansData.initialPeriodDailyLimitDays}-day daily pacing cap
                </strong>
                , and can be canceled any time via the Billing Portal. I
                expressly request immediate API access during the{" "}
                <strong className="text-epic-text">
                  {plansData.withdrawalWindowDays}-day statutory withdrawal
                  period
                </strong>{" "}
                and acknowledge that withdrawing early issues a time-based{" "}
                <strong className="text-epic-text">pro-rata refund</strong>{" "}
                deducting elapsed subscription time and disables future
                self-serve checkouts on this account.
              </span>
            </label>
          )}

          {billingSummary?.subscription?.status === "checkout_pending" && (
            <div className="rounded-xl border border-epic-border bg-epic-bg/40 p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Pending Stripe Checkout
                </h3>
                <p className="text-xs text-epic-text-muted mt-0.5">
                  A checkout attempt for{" "}
                  <strong className="font-mono text-epic-text">
                    {billingSummary.subscription.planVersionId}
                  </strong>{" "}
                  has not been paid yet. Click Subscribe above to resume or switch
                  plans, or cancel the pending checkout.
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                isPending={billingBusy}
                onPress={() => void handleCancelPendingCheckout()}
              >
                Cancel pending checkout
              </Button>
            </div>
          )}

          {billingSummary?.subscription &&
            ["active", "trialing", "past_due"].includes(
              billingSummary.subscription.status,
            ) && (
            <div className="rounded-xl border border-epic-border bg-epic-bg/40 p-4 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-epic-accent" />
                    Subscription &amp; Withdrawal Controls
                  </h3>
                  <p className="text-xs text-epic-text-muted mt-0.5">
                    Status:{" "}
                    <strong className="text-epic-text">
                      {billingSummary.subscription.status}
                    </strong>{" "}
                    · Period ends{" "}
                    {billingSummary.subscription.currentPeriodEnd.slice(0, 10)}
                    {billingSummary.subscription.cancelAtPeriodEnd
                      ? " (cancels at period end)"
                      : ""}
                    {billingSummary.subscription.pendingPlanVersionId
                      ? ` · Scheduled change: ${billingSummary.subscription.pendingPlanVersionId}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {["active", "trialing", "past_due"].includes(
                    billingSummary.subscription.status,
                  ) &&
                    !billingSummary.subscription.cancelAtPeriodEnd && (
                      <Button
                        variant="secondary"
                        size="sm"
                        isPending={billingBusy}
                        onPress={() => void handleChangePlan("free")}
                      >
                        Cancel at period end
                      </Button>
                    )}
                </div>
              </div>

              {["active", "trialing", "past_due"].includes(
                billingSummary.subscription.status,
              ) && billingSummary.withdrawalEligible ? (
                <div className="pt-3 border-t border-epic-border flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-56">
                    <TextField
                      label="14-Day Statutory Withdrawal / Pro-Rata Refund (optional reason)"
                      value={withdrawalReason}
                      onChange={setWithdrawalReason}
                      placeholder="Request immediate cancellation & time-based pro-rata refund"
                    />
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    isPending={billingBusy}
                    onPress={() => void handleWithdrawal()}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Request Withdrawal / Pro-Rata Refund
                  </Button>
                </div>
              ) : (
                <p className="pt-3 border-t border-epic-border text-xs text-epic-text-muted">
                  The {plansData.withdrawalWindowDays}-day statutory withdrawal
                  window has ended
                  {billingSummary.withdrawalExpiresAt
                    ? ` (closed ${billingSummary.withdrawalExpiresAt.slice(0, 10)})`
                    : ""}
                  . Use{" "}
                  <strong className="text-epic-text">
                    Cancel at period end
                  </strong>{" "}
                  above to stop future renewals.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <div className="grid lg:grid-cols-5 gap-6 items-start">
        {/* Request Higher Limits Form */}
        <div className="lg:col-span-3 bg-epic-surface border border-epic-border rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Mail className="w-5 h-5 text-epic-accent" />
              <div>
                <h2 className="text-base font-semibold text-white">
                  Request Manual / Custom Limits
                </h2>
                <p className="text-xs text-epic-text-muted">
                  Need additional free projects, enterprise capacity, or
                  separate replication terms? Submit an operator review request.
                </p>
              </div>
            </div>
          </div>

          <Form onSubmit={handleSubmit}>
            <div className="grid sm:grid-cols-2 gap-4">
              <TextField
                label="Contact Email"
                type="email"
                isRequired
                value={contactEmail}
                onChange={setContactEmail}
                placeholder="you@domain.com"
                description="We’ll use this address to follow up on your request."
              />

              <Select
                label="Requested Tier"
                selectedKey={requestedTier}
                onSelectionChange={(k) => {
                  if (!k) return;
                  const val = String(k) as
                    | "pro"
                    | "scale"
                    | "enterprise"
                    | "custom";
                  setRequestedTier(val);
                  if (val === "pro") setRequestedRpm("200");
                  if (val === "scale") setRequestedRpm("600");
                  if (val === "enterprise") setRequestedRpm("6000");
                }}
                items={TIER_OPTIONS}
              >
                {(item) => (
                  <SelectItem id={item.id} textValue={item.label}>
                    {item.label}
                  </SelectItem>
                )}
              </Select>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <TextField
                label="Requested Limit (Requests per Minute)"
                type="number"
                isRequired
                value={requestedRpm}
                onChange={setRequestedRpm}
                placeholder="1200"
              />
              <TextField
                label="Expected Monthly Requests"
                type="number"
                isRequired
                value={expectedMonthly}
                onChange={setExpectedMonthly}
                placeholder="2500000"
              />
            </div>

            <TextField
              label="Project Website / GitHub Repository"
              value={websiteUrl}
              onChange={setWebsiteUrl}
              placeholder="https://github.com/your-org/epic-price-bot"
            />

            <TextField
              label="How are you using the egdata API?"
              multiline
              isRequired
              value={useCase}
              onChange={setUseCase}
              placeholder="What does your app do, which endpoints does it use, and why do you need a higher limit?"
              description="Minimum 20 characters."
            />

            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-epic-text-muted">
                Active project:{" "}
                <strong className="text-epic-text">
                  {selectedProject?.name}
                </strong>
              </span>
              <Button type="submit" isPending={submitting}>
                <Send className="w-4 h-4" />
                Submit Request
              </Button>
            </div>
          </Form>
        </div>

        {/* Previous Requests */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-epic-accent" />
            Request History
          </h2>

          <Table aria-label="Limit request history">
            <TableHeader>
              <Column isRowHeader>Requested Limit</Column>
              <Column>Status</Column>
              <Column>Date</Column>
            </TableHeader>
            <TableBody
              items={history}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  {historyError ? (
                    <>
                      <p>Could not load request history.</p>
                      <Button onPress={() => void loadHistory()}>Retry</Button>
                    </>
                  ) : (
                    "You haven’t requested a higher limit yet."
                  )}
                </div>
              )}
            >
              {(req) => (
                <Row id={req.id}>
                  <Cell>
                    <div className="font-medium text-xs text-epic-text uppercase">
                      {req.requestedTier}
                    </div>
                    <div className="text-[11px] font-mono text-epic-text-muted">
                      {req.requestedRpm.toLocaleString()} requests/min
                    </div>
                  </Cell>
                  <Cell>
                    <Tag
                      tone={
                        req.status === "approved"
                          ? "success"
                          : req.status === "declined"
                            ? "danger"
                            : "accent"
                      }
                    >
                      {req.status}
                    </Tag>
                    {req.reviewNote && (
                      <p className="mt-2 max-w-64 whitespace-pre-wrap break-words text-xs text-epic-text-muted">
                        {req.reviewNote}
                      </p>
                    )}
                  </Cell>
                  <Cell className="text-xs text-epic-text-muted">
                    {new Date(req.createdAt).toLocaleDateString()}
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
