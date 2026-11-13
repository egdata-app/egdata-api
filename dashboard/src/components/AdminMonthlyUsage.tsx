import type { AccountMonthlyQuotaStatus } from "../../worker/types";

export function AdminMonthlyUsage({
  monthly,
  userName,
}: {
  monthly: AccountMonthlyQuotaStatus | null;
  userName: string;
}) {
  if (!monthly) {
    return (
      <span className="text-xs text-epic-text-muted">Usage unavailable</span>
    );
  }

  const percent = Math.min(100, (monthly.used / monthly.allowance) * 100);
  const color =
    monthly.status === "exhausted"
      ? "bg-epic-danger"
      : monthly.status === "warning" || monthly.status === "critical"
        ? "bg-epic-warning"
        : "bg-epic-accent";

  return (
    <div className="min-w-40 space-y-3">
      <div className="flex flex-wrap justify-between gap-2 text-xs tabular-nums">
        <span className="font-mono">
          {monthly.used.toLocaleString()}{" "}
          <span className="text-epic-text-muted">
            / {monthly.allowance.toLocaleString()} requests
          </span>
        </span>
        <span className="text-epic-text-muted">
          {monthly.remaining.toLocaleString()} remaining
        </span>
      </div>
      <div className="relative">
        <div
          role="progressbar"
          aria-label={`Monthly free-tier usage for ${userName}`}
          aria-valuemin={0}
          aria-valuemax={monthly.allowance}
          aria-valuenow={Math.min(monthly.used, monthly.allowance)}
          aria-valuetext={`${monthly.used.toLocaleString()} of ${monthly.allowance.toLocaleString()} requests used`}
          className="h-3 rounded-full bg-epic-bg overflow-hidden"
        >
          <div
            className={`h-full rounded-full ${color}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span
          aria-hidden="true"
          className="absolute right-0 -top-1 -bottom-1 border-l-2 border-dashed border-epic-warning"
        />
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-[11px] text-epic-text-muted">
        <span>
          {percent.toFixed(1)}% used · Resets {monthly.resetAt.slice(0, 10)}{" "}
          00:00 UTC
        </span>
        <span className="text-epic-warning">
          Monthly limit · {monthly.allowance.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
