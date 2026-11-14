import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarClock,
  CreditCard,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type AccountMonthlyQuotaStatus,
  dashboardClient,
  type ProjectBillingSummaryResponse,
} from "../../lib/api";
import { useDashboardAuth } from "../../lib/auth-context";
import { Button, buttonStyles } from "../ui/Button";
import { Tag } from "../ui/Controls";

export function monthlyNoticeFor(
  monthly: Pick<AccountMonthlyQuotaStatus, "used" | "allowance" | "resetAt">,
): {
  level: "ok" | "warning" | "critical" | "exhausted";
  percentUsed: number;
  title: string | null;
  message: string | null;
} {
  const percentUsed =
    monthly.allowance > 0
      ? Math.min(100, (monthly.used / monthly.allowance) * 100)
      : 0;
  const resetLabel = `${monthly.resetAt.slice(0, 10)} 00:00 UTC`;
  if (monthly.used >= monthly.allowance) {
    return {
      level: "exhausted",
      percentUsed: 100,
      title: "Monthly free quota exhausted",
      message: `All ${monthly.allowance.toLocaleString()} monthly free-account requests have been used across your free projects, API keys, and console sessions. Free-project requests return HTTP 429 MONTHLY_QUOTA_EXCEEDED until ${resetLabel}.`,
    };
  }
  if (monthly.used >= Math.ceil(monthly.allowance * 0.95)) {
    return {
      level: "critical",
      percentUsed,
      title: "95% of monthly free quota used",
      message: `${(monthly.allowance - monthly.used).toLocaleString()} free-account requests remain before HTTP 429 MONTHLY_QUOTA_EXCEEDED responses begin until ${resetLabel}.`,
    };
  }
  if (monthly.used >= Math.ceil(monthly.allowance * 0.8)) {
    return {
      level: "warning",
      percentUsed,
      title: "80% of monthly free quota used",
      message: `Your free projects share one ${monthly.allowance.toLocaleString()}-request allowance that resets ${resetLabel}. Request higher limits if your integration needs sustained capacity.`,
    };
  }
  return {
    level: "ok",
    percentUsed,
    title: null,
    message: null,
  };
}

function renderPaidProjectSection({
  selectedProject,
  projectBilling,
  showLimitLink,
  loading,
  onRefresh,
}: {
  selectedProject: { id: string; name: string; tier: string };
  projectBilling: ProjectBillingSummaryResponse | null;
  showLimitLink: boolean;
  loading: boolean;
  onRefresh: () => void;
}) {
  const periodUsage =
    projectBilling?.entitlement.periodType === "billing_period"
      ? projectBilling.usage
      : null;
  const periodPercent =
    periodUsage && periodUsage.allowance > 0
      ? Math.min(100, (periodUsage.used / periodUsage.allowance) * 100)
      : 0;
  const periodResetIso =
    periodUsage?.resetAt !== undefined
      ? new Date(periodUsage.resetAt).toISOString().slice(0, 10)
      : null;
  const dailyUsage = projectBilling?.dailyUsage ?? null;
  const dailyPercent =
    dailyUsage && dailyUsage.allowance > 0
      ? Math.min(100, (dailyUsage.used / dailyUsage.allowance) * 100)
      : 0;
  const dailyBarColor =
    dailyUsage && dailyUsage.used >= dailyUsage.allowance
      ? "bg-epic-danger"
      : dailyPercent >= 80
        ? "bg-epic-warning"
        : "bg-epic-accent";
  const dailyUntilLabel = projectBilling?.entitlement.initialDailyLimitUntil
    ? new Date(projectBilling.entitlement.initialDailyLimitUntil)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")
    : null;

  return (
    <section
      aria-label="Project allowance and daily pacing"
      className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-white">
              Project Allowance &amp; Rate Limits ({selectedProject.name})
            </h2>
            <Tag tone="success">
              {selectedProject.tier.toUpperCase()} ·{" "}
              {projectBilling?.entitlement.grantSource === "subscription"
                ? "Paid Subscription"
                : projectBilling?.entitlement.grantSource === "manual" ||
                    projectBilling?.entitlement.grantSource === "grandfathered"
                  ? "Manual / Grandfathered Grant"
                  : "Paid Tier"}
            </Tag>
            {projectBilling?.entitlement.rpmLimit && (
              <Tag tone="neutral">
                {projectBilling.entitlement.rpmLimit.toLocaleString()} req/min
              </Tag>
            )}
          </div>
          <p className="text-xs text-epic-text-muted">
            This project is exempt from the 100,000-request shared free
            calendar-month cap.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            isPending={loading}
            onPress={onRefresh}
          >
            Refresh quota
          </Button>
          {showLimitLink && (
            <Link
              to="/limits"
              className={buttonStyles({ variant: "secondary", size: "sm" })}
            >
              <CreditCard className="w-3.5 h-3.5 text-epic-accent" />
              Manage Plan &amp; Billing
            </Link>
          )}
        </div>
      </div>

      {projectBilling?.entitlement.status === "grace" &&
        projectBilling.subscription?.graceUntil && (
          <div
            role="alert"
            className="rounded-lg border border-epic-warning/40 bg-epic-warning/10 p-3 text-xs text-epic-warning flex flex-wrap items-center justify-between gap-3"
          >
            <span>
              Subscription payment failed. Paid capacity remains active during
              the grace period until{" "}
              {new Date(projectBilling.subscription.graceUntil).toUTCString()}.
            </span>
            <Link
              to="/limits"
              className={buttonStyles({ variant: "primary", size: "sm" })}
            >
              Update payment method
            </Link>
          </div>
        )}

      {periodUsage && (
        <div className="border-t border-epic-border/70 pt-4 space-y-2.5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                Period Used
              </div>
              <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                {periodUsage.used.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                Remaining
              </div>
              <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                {periodUsage.remaining.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                Period Allowance
              </div>
              <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                {periodUsage.allowance.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted flex items-center gap-1">
                <CalendarClock className="w-3 h-3" />
                Billing Period Reset
              </div>
              <div className="text-sm font-mono font-semibold text-white mt-1">
                {periodResetIso ?? "Reconciled period"}
              </div>
            </div>
          </div>
          <div className="h-1.5 rounded-full bg-epic-bg overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                periodUsage.status === "exhausted"
                  ? "bg-epic-danger"
                  : periodUsage.status === "critical" ||
                      periodUsage.status === "warning"
                    ? "bg-epic-warning"
                    : "bg-epic-accent"
              }`}
              style={{ width: `${periodPercent}%` }}
            />
          </div>
        </div>
      )}

      {dailyUsage && (
        <div className="border-t border-epic-border/70 pt-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-white">
                Initial 14-Day Daily Cap
              </span>
              <span className="text-[11px] font-mono text-epic-accent">
                {dailyUsage.allowance.toLocaleString()} req / UTC day
              </span>
            </div>
            <span className="text-[11px] text-epic-text-muted">
              {dailyUntilLabel
                ? `Unlocks full monthly quota ${dailyUntilLabel} UTC`
                : "Resets daily at 00:00 UTC"}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                Used Today (UTC)
              </div>
              <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                {dailyUsage.used.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                Remaining Today
              </div>
              <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                {dailyUsage.remaining.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                Daily Limit
              </div>
              <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                {dailyUsage.allowance.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-epic-text-muted flex items-center gap-1">
                <CalendarClock className="w-3 h-3" />
                Next Daily Reset
              </div>
              <div className="text-sm font-mono font-semibold text-white mt-1">
                {dailyUsage.resetAtIso.slice(0, 10)} 00:00Z
              </div>
            </div>
          </div>

          <div className="h-1.5 rounded-full bg-epic-bg overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${dailyBarColor}`}
              style={{ width: `${dailyPercent}%` }}
            />
          </div>
        </div>
      )}

      {(projectBilling?.entitlement.expensivePeriodBudgets ||
        projectBilling?.entitlement.expensiveMinuteLimits) && (
        <div className="border-t border-epic-border/70 pt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[11px] text-epic-text-muted font-mono">
          {projectBilling.entitlement.expensiveMinuteLimits && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-sans uppercase tracking-wider text-[10px]">
                Minute caps:
              </span>
              {Object.entries(
                projectBilling.entitlement.expensiveMinuteLimits,
              ).map(([key, limit]) => (
                <span key={key}>
                  {key}: {limit.toLocaleString()}/min
                </span>
              ))}
            </div>
          )}
          {projectBilling.entitlement.expensivePeriodBudgets && periodUsage && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-sans uppercase tracking-wider text-[10px]">
                Period budgets:
              </span>
              {Object.entries(
                projectBilling.entitlement.expensivePeriodBudgets,
              ).map(([key, cap]) => {
                const usedCount =
                  periodUsage.policyCounts?.[`${key}-period`] ?? 0;
                return (
                  <span key={key}>
                    {key}: {usedCount.toLocaleString()}/{cap.toLocaleString()}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function MonthlyQuotaPanel({
  showLimitLink = true,
  refreshKey = 0,
}: {
  showLimitLink?: boolean;
  refreshKey?: number;
}) {
  const { projects, selectedProject, paidPlansEnabled } = useDashboardAuth();
  const [monthly, setMonthly] = useState<AccountMonthlyQuotaStatus | null>(
    null,
  );
  const [projectBilling, setProjectBilling] =
    useState<ProjectBillingSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const hasFreeProject = projects.some((p) => p.tier === "free");
  const selectedIsPaid =
    paidPlansEnabled &&
    selectedProject !== null &&
    selectedProject.tier !== "free";

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const [monthlyRes, billingRes] = await Promise.all([
          dashboardClient.getMonthlyQuota(signal),
          paidPlansEnabled && selectedProject
            ? dashboardClient
                .getProjectBilling(selectedProject.id, signal)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!signal?.aborted) {
          setMonthly(monthlyRes.monthly);
          setProjectBilling(billingRes);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setError(
            err instanceof Error
              ? err.message
              : "Monthly quota usage is temporarily unavailable.",
          );
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [paidPlansEnabled, selectedProject],
  );

  // Both local and page refresh controls cancel any older in-flight read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and refreshKey trigger quota refreshes.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, revision, refreshKey]);

  useEffect(() => {
    if (!monthly) return;
    // A month can exceed the browser's signed 32-bit timeout limit. Wake early
    // in that case and reschedule from the newly fetched reset timestamp.
    const untilReset = Date.parse(monthly.resetAt) - Date.now();
    const timer = window.setTimeout(
      refresh,
      Math.min(2_147_483_647, untilReset > 0 ? untilReset : 30_000),
    );
    return () => window.clearTimeout(timer);
  }, [monthly, refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  if (selectedIsPaid && selectedProject && !hasFreeProject) {
    return renderPaidProjectSection({
      selectedProject,
      projectBilling,
      showLimitLink,
      loading,
      onRefresh: refresh,
    });
  }

  const notice = monthly ? monthlyNoticeFor(monthly) : null;
  const barColor =
    notice?.level === "exhausted"
      ? "bg-epic-danger"
      : notice?.level === "critical" || notice?.level === "warning"
        ? "bg-epic-warning"
        : "bg-epic-accent";

  return (
    <div className="space-y-4">
      {selectedIsPaid &&
        selectedProject &&
        renderPaidProjectSection({
          selectedProject,
          projectBilling,
          showLimitLink,
          loading,
          onRefresh: refresh,
        })}
      <section
        aria-label="Free account monthly quota"
        className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-white">
                Free Account Monthly Quota
              </h2>
              {selectedIsPaid ? (
                <Tag tone="success">
                  {selectedProject.name} exempt ({selectedProject.tier})
                </Tag>
              ) : (
                <Tag
                  tone={
                    notice?.level === "exhausted"
                      ? "danger"
                      : notice?.level === "critical" ||
                          notice?.level === "warning"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {notice?.level === "exhausted"
                    ? "Exhausted"
                    : notice?.level === "critical"
                      ? "95%+ used"
                      : notice?.level === "warning"
                        ? "80%+ used"
                        : "Shared across free projects"}
                </Tag>
              )}
            </div>
            <p className="text-xs text-epic-text-muted">
              Shared across all free projects, API keys, and console sessions on
              your account. Key rotation, deletion, or project recreation never
              resets this counter.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              isPending={loading}
              onPress={refresh}
            >
              Refresh quota
            </Button>
            {showLimitLink && (
              <Link
                to="/limits"
                className={buttonStyles({ variant: "secondary", size: "sm" })}
              >
                <Sparkles className="w-3.5 h-3.5 text-epic-accent" />
                Request Higher Limits
              </Link>
            )}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-epic-danger/30 bg-epic-bg p-3 flex flex-wrap items-center justify-between gap-3 text-xs text-epic-danger"
          >
            <span>{error}</span>
            <Button size="sm" variant="secondary" onPress={refresh}>
              Retry
            </Button>
          </div>
        )}

        {loading && !monthly && !error && (
          <p className="text-xs text-epic-text-muted">
            Loading monthly allowance…
          </p>
        )}

        {monthly && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-epic-border bg-epic-bg/60 p-3">
                <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                  Used
                </div>
                <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                  {monthly.used.toLocaleString()}
                </div>
              </div>
              <div className="rounded-lg border border-epic-border bg-epic-bg/60 p-3">
                <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                  Remaining
                </div>
                <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                  {monthly.remaining.toLocaleString()}
                </div>
              </div>
              <div className="rounded-lg border border-epic-border bg-epic-bg/60 p-3">
                <div className="text-[11px] uppercase tracking-wider text-epic-text-muted">
                  Monthly Allowance
                </div>
                <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                  {monthly.allowance.toLocaleString()}
                </div>
              </div>
              <div className="rounded-lg border border-epic-border bg-epic-bg/60 p-3">
                <div className="text-[11px] uppercase tracking-wider text-epic-text-muted flex items-center gap-1">
                  <CalendarClock className="w-3 h-3" />
                  Next Reset (UTC)
                </div>
                <div className="text-sm font-mono font-semibold text-white mt-1">
                  {monthly.resetAt.slice(0, 10)} 00:00Z
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="h-2 rounded-full bg-epic-bg overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${barColor}`}
                  style={{ width: `${notice?.percentUsed ?? 0}%` }}
                />
              </div>
              <div className="flex flex-wrap justify-between gap-2 text-[11px] text-epic-text-muted">
                <span>
                  {(notice?.percentUsed ?? 0).toFixed(1)}% of free monthly
                  allowance used
                </span>
                <span>
                  Resets first day of each calendar month at 00:00 UTC
                </span>
              </div>
            </div>

            {notice && notice.level !== "ok" && (
              <div
                role="alert"
                className={`rounded-lg border p-3.5 flex flex-wrap items-start justify-between gap-3 text-xs ${
                  notice.level === "exhausted"
                    ? "border-epic-danger/40 bg-epic-danger/10 text-epic-danger"
                    : "border-epic-warning/40 bg-epic-warning/10 text-epic-warning"
                }`}
              >
                <div className="flex items-start gap-2.5 max-w-3xl">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <div className="font-semibold">{notice.title}</div>
                    <p className="text-epic-text/90 leading-relaxed">
                      {notice.message}
                    </p>
                  </div>
                </div>
                <Link
                  to="/limits"
                  className={buttonStyles({ variant: "primary", size: "sm" })}
                >
                  Request limit increase
                </Link>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
