import { Link } from "@tanstack/react-router";
import { AlertTriangle, CalendarClock, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type AccountMonthlyQuotaStatus, dashboardClient } from "../../lib/api";
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

export function MonthlyQuotaPanel({
  showLimitLink = true,
}: {
  showLimitLink?: boolean;
}) {
  const { projects, selectedProject } = useDashboardAuth();
  const [monthly, setMonthly] = useState<AccountMonthlyQuotaStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const hasFreeProject = projects.some((p) => p.tier === "free");
  const selectedIsPaid =
    selectedProject !== null && selectedProject.tier !== "free";

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const res = await dashboardClient.getMonthlyQuota(signal);
      if (!signal?.aborted) setMonthly(res.monthly);
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!hasFreeProject && selectedIsPaid && !monthly?.used) {
    return (
      <section className="rounded-xl border border-epic-border bg-epic-surface p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">
              Monthly Free Allowance
            </h2>
            <Tag tone="success">Exempt · Paid tier</Tag>
          </div>
          <p className="text-xs text-epic-text-muted">
            Paid projects ({selectedProject?.tier}) are exempt from the
            100,000-request monthly free-account cap and retain their project
            tier limits.
          </p>
        </div>
      </section>
    );
  }

  const notice = monthly ? monthlyNoticeFor(monthly) : null;
  const barColor =
    notice?.level === "exhausted"
      ? "bg-epic-danger"
      : notice?.level === "critical" || notice?.level === "warning"
        ? "bg-epic-warning"
        : "bg-epic-accent";

  return (
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

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-epic-danger/30 bg-epic-bg p-3 flex flex-wrap items-center justify-between gap-3 text-xs text-epic-danger"
        >
          <span>{error}</span>
          <Button size="sm" variant="secondary" onPress={() => void load()}>
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
              <span>Resets first day of each calendar month at 00:00 UTC</span>
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
  );
}
