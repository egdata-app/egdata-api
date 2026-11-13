import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Coins,
  CreditCard,
  FileCheck2,
  Mail,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AdminUserDetail } from "../../worker/admin-types";
import { AdminAudit } from "../components/AdminAudit";
import { AdminMonthlyUsage } from "../components/AdminMonthlyUsage";
import {
  AdminUsageNote,
  adminDate,
  usageNumber,
} from "../components/AdminShared";
import { AdminKeyCount, AdminLastUsed } from "../components/AdminTable";
import { AdminUserAnalytics } from "../components/AdminUserAnalytics";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Controls";
import { Dialog, Heading, Modal } from "../components/ui/Modal";
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
import { dashboardClient } from "../lib/api";

export const Route = createFileRoute("/admin/users/$userId")({
  component: AdminUserDetailPage,
});

function formatEpoch(value: number | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function formatEur(cents: number, currency = "eur") {
  return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

function subscriptionBadgeTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "trialing" || status === "past_due" || status === "incomplete" || status === "checkout_pending") {
    return "warning";
  }
  if (status === "canceled" || status === "unpaid") return "danger";
  return "neutral";
}

function AdminUserDetailPage() {
  const { userId } = Route.useParams();
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const [creditProjectId, setCreditProjectId] = useState<string | null>(null);
  const [creditScope, setCreditScope] = useState<"period" | "month">("period");
  const [creditAmount, setCreditAmount] = useState("10000");
  const [creditReason, setCreditReason] = useState("");
  const [creditSaving, setCreditSaving] = useState(false);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers manual refresh after mutations and retries.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void dashboardClient
      .getAdminUser(userId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Could not load user.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [userId, version]);

  async function saveLimit(event: React.FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setSaving(true);
    try {
      await dashboardClient.updateAdminUserLimits(
        detail.user.id,
        Number(limit),
        reason,
      );
      setEditing(false);
      reload();
      notify({ title: "Project limit updated", tone: "success" });
    } catch (err) {
      notify({
        title: "Could not update limit",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleReconcileBilling() {
    setReconciling(true);
    try {
      const res = await dashboardClient.reconcileAdminBilling();
      reload();
      notify({
        title: "Billing reconciliation finished",
        description: `Expired grace: ${res.expiredGraceCount}, reconciled: ${res.reconciledCount}.`,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Billing reconciliation failed",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setReconciling(false);
    }
  }

  async function saveCredit(event: React.FormEvent) {
    event.preventDefault();
    if (!creditProjectId) return;
    setCreditSaving(true);
    try {
      await dashboardClient.creditAdminProjectUsage(creditProjectId, {
        adjustmentId: `adj_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        scope: creditScope,
        amount: Number(creditAmount),
        reason: creditReason.trim(),
      });
      setCreditProjectId(null);
      setCreditReason("");
      reload();
      notify({
        title: "Usage credit applied",
        description: `Credited ${Number(creditAmount).toLocaleString()} requests (${creditScope}).`,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not apply usage credit",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setCreditSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/admin/users"
          className="inline-flex items-center gap-1.5 text-sm text-epic-text-muted hover:text-white rounded focus-visible:outline-2 focus-visible:outline-epic-accent focus-visible:outline-offset-4"
        >
          <ArrowLeft aria-hidden="true" className="w-4 h-4" />
          Back to users
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {detail && !detail.user.closedAt && (
            <Button
              variant="secondary"
              size="sm"
              onPress={() => {
                setLimit(String(detail.user.projectLimit));
                setReason("");
                setEditing(true);
              }}
            >
              <SlidersHorizontal aria-hidden="true" className="w-3.5 h-3.5" />
              Edit project limit
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onPress={reload}
            isDisabled={loading}
          >
            <RefreshCw
              aria-hidden="true"
              className={`w-3.5 h-3.5 ${loading ? "motion-safe:animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-epic-danger/40 bg-epic-surface p-6 space-y-3"
        >
          <p className="text-sm text-epic-danger">{error}</p>
          <Button variant="secondary" size="sm" onPress={reload}>
            Retry
          </Button>
        </div>
      ) : loading && !detail ? (
        <output className="block rounded-xl border border-epic-border bg-epic-surface p-8 text-sm text-epic-text-muted">
          Loading user details…
        </output>
      ) : detail ? (
        <>
          <header className="rounded-xl border border-epic-border bg-epic-surface p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-2xl font-bold tracking-tight text-white">
                    {detail.user.displayName}
                  </h1>
                  {Boolean(detail.user.isAdmin) && (
                    <Badge tone="accent">Admin</Badge>
                  )}
                  {detail.user.closedAt ? (
                    <Badge tone="danger">Account closed</Badge>
                  ) : detail.onboarding.eligible ? (
                    <Badge tone="success">Onboarding complete</Badge>
                  ) : (
                    <Badge tone="warning">
                      {detail.onboarding.acceptedCurrent
                        ? "Email verification required"
                        : "Agreement required"}
                    </Badge>
                  )}
                </div>
                <p className="font-mono text-xs text-epic-text-muted break-all">
                  Epic Account ID: {detail.user.id}
                </p>
                {detail.user.email && (
                  <p className="text-sm text-epic-text-muted">
                    Account email: {detail.user.email}
                  </p>
                )}
              </div>
              <Link
                to="/admin/projects"
                search={{ owner: detail.user.id }}
                className="inline-flex items-center gap-1 text-xs text-epic-accent hover:text-epic-accent-hover rounded focus-visible:outline-2 focus-visible:outline-epic-accent focus-visible:outline-offset-4"
              >
                Open in Projects
                <ArrowUpRight aria-hidden="true" className="w-3.5 h-3.5" />
              </Link>
            </div>

            {detail.user.closedAt && (
              <div className="rounded-lg border border-epic-danger/30 bg-epic-danger/10 p-3 text-xs text-epic-text space-y-1">
                <div className="font-semibold text-epic-danger flex items-center gap-1.5">
                  <ShieldAlert aria-hidden="true" className="w-4 h-4" />
                  Account closed on {formatEpoch(detail.user.closedAt)}
                </div>
                {detail.user.purgeAfter && (
                  <p className="text-epic-text-muted">
                    Scheduled purge after {formatEpoch(detail.user.purgeAfter)}
                  </p>
                )}
              </div>
            )}

            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t border-epic-border text-sm">
              <div>
                <dt className="text-xs text-epic-text-muted">Projects</dt>
                <dd className="font-mono tabular-nums mt-0.5 text-white">
                  {detail.user.projectCount} / {detail.user.projectLimit}
                  {detail.user.deletedProjectCount > 0 && (
                    <span className="text-xs text-epic-text-muted ml-1.5">
                      ({detail.user.deletedProjectCount} deleted)
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-epic-text-muted">API keys</dt>
                <dd className="mt-0.5">
                  <AdminKeyCount
                    active={detail.user.activeKeyCount}
                    total={detail.user.keyCount}
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-epic-text-muted">Requests · 24h</dt>
                <dd className="font-mono tabular-nums mt-0.5 text-white">
                  {usageNumber(detail.usage, detail.user.id, "requests")}
                  <span className="text-xs text-epic-text-muted ml-2">
                    ({usageNumber(detail.usage, detail.user.id, "errors")} err)
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-epic-text-muted">Last active</dt>
                <dd className="mt-0.5">
                  <AdminLastUsed value={detail.user.lastUsedAt} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-epic-text-muted">Joined</dt>
                <dd className="text-xs text-epic-text mt-0.5">
                  {adminDate(detail.user.createdAt)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-epic-text-muted">Updated</dt>
                <dd className="text-xs text-epic-text mt-0.5">
                  {adminDate(detail.user.updatedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-epic-text-muted">
                  Preferred language
                </dt>
                <dd className="text-xs text-epic-text mt-0.5">
                  {detail.user.preferredLanguage || "Not set"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-epic-text-muted">
                  Last project created
                </dt>
                <dd className="text-xs text-epic-text mt-0.5">
                  {detail.user.lastProjectCreatedAt
                    ? formatEpoch(detail.user.lastProjectCreatedAt * 1000)
                    : "Never"}
                </dd>
              </div>
            </dl>
            {!detail.user.closedAt &&
              detail.projects.some(
                (project) => !project.deletedAt && project.tier === "free",
              ) && (
                <div className="border-t border-epic-border pt-4 space-y-2">
                  <h2 className="text-sm font-semibold text-white">
                    Monthly free usage
                  </h2>
                  <p className="text-xs text-epic-text-muted">
                    Shared across this user's free projects, API keys, and
                    console sessions.
                  </p>
                  <AdminMonthlyUsage
                    monthly={detail.monthlyQuota}
                    userName={detail.user.displayName}
                  />
                </div>
              )}
          </header>

          {!detail.user.closedAt && (
            <AdminUserAnalytics
              key={detail.user.id}
              userId={detail.user.id}
              monthlyLimit={detail.monthlyQuota?.allowance ?? null}
              refreshKey={version}
            />
          )}

          <section
            aria-label="Agreements and onboarding"
            className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden"
          >
            <div className="p-5 border-b border-epic-border flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <FileCheck2
                    aria-hidden="true"
                    className="w-4 h-4 text-epic-accent"
                  />
                  Agreements &amp; Developer Onboarding
                </h2>
                <p className="text-xs text-epic-text-muted mt-0.5">
                  Current rollout compliance, contact email verification, and
                  recorded agreement acceptances.
                </p>
              </div>
              {detail.onboarding.rolloutEnabled ? (
                detail.onboarding.acceptedCurrent ? (
                  <Badge tone="success">
                    <CheckCircle2 aria-hidden="true" className="w-3 h-3" />
                    Current terms accepted
                  </Badge>
                ) : (
                  <Badge tone="warning">
                    <Clock3 aria-hidden="true" className="w-3 h-3" />
                    Current terms not accepted
                  </Badge>
                )
              ) : (
                <Badge tone="neutral">Legal rollout inactive</Badge>
              )}
            </div>

            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4 border-b border-epic-border text-sm">
              <div className="rounded-lg border border-epic-border bg-epic-bg/40 p-4 space-y-2">
                <div className="text-xs font-medium text-epic-text-muted uppercase tracking-wider">
                  Current Rollout Requirement
                </div>
                {detail.onboarding.rolloutEnabled ? (
                  <dl className="space-y-1.5 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-epic-text-muted">Revision</dt>
                      <dd className="font-mono text-white">
                        {detail.onboarding.revision}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-epic-text-muted">Required terms</dt>
                      <dd className="font-mono text-white">
                        {detail.onboarding.requiredTermsVersion} (
                        {detail.onboarding.requiredTermsEdition})
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-epic-text-muted">Privacy notice</dt>
                      <dd className="font-mono text-white">
                        {detail.onboarding.requiredPrivacyVersion}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-epic-text-muted">Accepted at</dt>
                      <dd className="text-white">
                        {detail.onboarding.acceptedAt
                          ? formatEpoch(detail.onboarding.acceptedAt)
                          : "Not accepted"}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-xs text-epic-text-muted">
                    No active legal rollout configured in{" "}
                    <code>legal_rollout</code>.
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-epic-border bg-epic-bg/40 p-4 space-y-2">
                <div className="text-xs font-medium text-epic-text-muted uppercase tracking-wider flex items-center gap-1.5">
                  <Mail aria-hidden="true" className="w-3.5 h-3.5" />
                  Developer Contact Email
                </div>
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-2">
                    <dt className="text-epic-text-muted">Verified email</dt>
                    <dd className="text-white break-all">
                      {detail.onboarding.contactEmail ?? "None"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-epic-text-muted">Verified at</dt>
                    <dd className="text-white">
                      {detail.onboarding.verifiedAt
                        ? formatEpoch(detail.onboarding.verifiedAt)
                        : "Not verified"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-epic-text-muted">Pending email</dt>
                    <dd className="text-epic-text-muted break-all">
                      {detail.onboarding.pendingEmail ?? "None"}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>

            <Table
              aria-label="Agreement acceptances"
              className="border-0 rounded-none"
            >
              <TableHeader>
                <Column isRowHeader>Terms</Column>
                <Column>Privacy</Column>
                <Column>Revision</Column>
                <Column>Accepted at</Column>
                <Column>Receipt</Column>
                <Column>Status</Column>
              </TableHeader>
              <TableBody
                items={detail.agreements}
                renderEmptyState={() => (
                  <p className="p-6 text-sm text-epic-text-muted text-center">
                    No agreement acceptances recorded for this user.
                  </p>
                )}
              >
                {(item) => (
                  <Row
                    id={`${item.version}-${item.acceptedAt}`}
                    textValue={`${item.version} ${item.edition}`}
                  >
                    <Cell>
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-white">
                          {item.version}{" "}
                          <span className="text-epic-text-muted">
                            ({item.edition})
                          </span>
                        </div>
                        <details className="text-[11px] text-epic-text-muted">
                          <summary className="cursor-pointer">SHA-256</summary>
                          <span className="font-mono break-all select-all">
                            {item.sha256}
                          </span>
                        </details>
                      </div>
                    </Cell>
                    <Cell>
                      <span className="font-mono text-xs text-epic-text-muted">
                        {item.privacyVersion ?? "Not recorded"}
                      </span>
                    </Cell>
                    <Cell>
                      <span className="font-mono text-xs text-epic-text-muted">
                        {item.requirementRevision}
                      </span>
                    </Cell>
                    <Cell>
                      <span className="text-xs text-white">
                        {formatEpoch(item.acceptedAt)}
                      </span>
                    </Cell>
                    <Cell>
                      <span className="font-mono text-xs text-epic-text-muted break-all">
                        {item.receiptId ?? "—"}
                      </span>
                    </Cell>
                    <Cell>
                      {item.retainUntil === null ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="neutral">
                          Retained until {formatEpoch(item.retainUntil)}
                        </Badge>
                      )}
                    </Cell>
                  </Row>
                )}
              </TableBody>
            </Table>
          </section>

          <section
            aria-label="User projects"
            className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden"
          >
            <div className="p-5 border-b border-epic-border flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-white">Projects</h2>
              <span className="text-xs text-epic-text-muted">
                {detail.projects.length} total
              </span>
            </div>
            <Table aria-label="User projects" className="border-0 rounded-none">
              <TableHeader>
                <Column isRowHeader>Project</Column>
                <Column>Tier &amp; RPM</Column>
                <Column>API keys</Column>
                <Column>Last active</Column>
                <Column>Status</Column>
                <Column>Actions</Column>
              </TableHeader>
              <TableBody
                items={detail.projects}
                renderEmptyState={() => (
                  <p className="p-6 text-sm text-epic-text-muted text-center">
                    No projects owned by this user.
                  </p>
                )}
              >
                {(project) => (
                  <Row id={project.id} textValue={project.name}>
                    <Cell>
                      <div>
                        <div className="font-medium text-white">
                          {project.name}
                        </div>
                        <div className="font-mono text-[11px] text-epic-text-muted">
                          {project.id} · /{project.slug}
                        </div>
                      </div>
                    </Cell>
                    <Cell>
                      <div className="flex items-center gap-2">
                        <Badge
                          tone={project.tier === "free" ? "neutral" : "accent"}
                        >
                          {project.tier}
                        </Badge>
                        <span className="font-mono text-xs text-epic-text-muted tabular-nums">
                          {project.effectiveRpm.toLocaleString()} rpm
                        </span>
                      </div>
                    </Cell>
                    <Cell>
                      <AdminKeyCount
                        active={project.activeKeyCount}
                        total={project.keyCount}
                      />
                    </Cell>
                    <Cell>
                      <AdminLastUsed value={project.lastUsedAt} />
                    </Cell>
                    <Cell>
                      {project.deletedAt ? (
                        <Badge tone="danger">Deleted</Badge>
                      ) : (
                        <Badge tone="success">Active</Badge>
                      )}
                    </Cell>
                    <Cell>
                      {!project.deletedAt && (
                        <Button
                          variant="quiet"
                          size="sm"
                          onPress={() => {
                            setCreditProjectId(project.id);
                            setCreditScope(
                              project.tier === "free" ? "month" : "period",
                            );
                            setCreditAmount("10000");
                            setCreditReason("");
                          }}
                        >
                          <Coins aria-hidden="true" className="w-3.5 h-3.5" />
                          Credit usage
                        </Button>
                      )}
                    </Cell>
                  </Row>
                )}
              </TableBody>
            </Table>
          </section>

          <section
            aria-label="Billing, subscriptions, and payments"
            className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden"
          >
            <div className="p-5 border-b border-epic-border flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <CreditCard
                    aria-hidden="true"
                    className="w-4 h-4 text-epic-accent"
                  />
                  Billing, Subscriptions &amp; Payments
                </h2>
                <p className="text-xs text-epic-text-muted mt-0.5">
                  Stripe customer profile, project subscriptions, EUR purchase
                  receipts, withdrawals/refunds, and usage credits.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {detail.billing.customer ? (
                  <Badge
                    tone={
                      detail.billing.customer.environment === "live"
                        ? "success"
                        : "warning"
                    }
                  >
                    Stripe {detail.billing.customer.environment} ·{" "}
                    {detail.billing.customer.stripeCustomerId}
                  </Badge>
                ) : (
                  <Badge tone="neutral">No Stripe customer</Badge>
                )}
                {detail.billing.subscriptions.length > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    isPending={reconciling}
                    onPress={() => void handleReconcileBilling()}
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className={`w-3.5 h-3.5 ${reconciling ? "motion-safe:animate-spin" : ""}`}
                    />
                    Reconcile billing
                  </Button>
                )}
              </div>
            </div>

            {detail.billing.customer && (
              <div className="px-5 py-3 border-b border-epic-border bg-epic-bg/30 flex flex-wrap gap-x-6 gap-y-1 text-xs text-epic-text-muted">
                <span>
                  Customer ID:{" "}
                  <code className="font-mono text-white select-all">
                    {detail.billing.customer.stripeCustomerId}
                  </code>
                </span>
                <span>
                  Billing email:{" "}
                  <span className="text-white">
                    {detail.billing.customer.email ?? "Not recorded"}
                  </span>
                </span>
                <span>
                  Created: {adminDate(detail.billing.customer.createdAt)}
                </span>
              </div>
            )}

            <div className="divide-y divide-epic-border">
              <div>
                <div className="px-5 py-3 border-b border-epic-border flex items-center justify-between text-xs font-medium text-epic-text-muted uppercase tracking-wider">
                  <span>Subscriptions</span>
                  <span>{detail.billing.subscriptions.length} total</span>
                </div>
                <Table
                  aria-label="User subscriptions"
                  className="border-0 rounded-none"
                >
                  <TableHeader>
                    <Column isRowHeader>Project</Column>
                    <Column>Plan</Column>
                    <Column>Status</Column>
                    <Column>Billing period</Column>
                    <Column>Stripe &amp; refunds</Column>
                  </TableHeader>
                  <TableBody
                    items={detail.billing.subscriptions}
                    renderEmptyState={() => (
                      <p className="p-5 text-sm text-epic-text-muted text-center">
                        No subscriptions recorded for this user.
                      </p>
                    )}
                  >
                    {(sub) => (
                      <Row id={sub.id} textValue={sub.projectName ?? sub.projectId}>
                        <Cell>
                          <div>
                            <div className="font-medium text-white">
                              {sub.projectName ?? "Deleted / unknown project"}
                            </div>
                            <div className="font-mono text-[11px] text-epic-text-muted">
                              {sub.projectId}
                            </div>
                          </div>
                        </Cell>
                        <Cell>
                          <div className="space-y-1">
                            <span className="font-mono text-xs text-white">
                              {sub.planVersionId}
                            </span>
                            {sub.pendingPlanVersionId && (
                              <div>
                                <Badge tone="warning">
                                  Pending: {sub.pendingPlanVersionId}
                                </Badge>
                              </div>
                            )}
                          </div>
                        </Cell>
                        <Cell>
                          <div className="flex flex-wrap gap-1.5">
                            <Badge tone={subscriptionBadgeTone(sub.status)}>
                              {sub.status}
                            </Badge>
                            {sub.cancelAtPeriodEnd && (
                              <Badge tone="warning">Cancels at period end</Badge>
                            )}
                            {sub.needsReconcile && (
                              <Badge tone="danger">Needs reconcile</Badge>
                            )}
                            {sub.disputeStatus !== "none" && (
                              <Badge tone="danger">
                                Dispute: {sub.disputeStatus}
                              </Badge>
                            )}
                            {sub.refundStatus !== "none" && (
                              <Badge tone="neutral">
                                Refund: {sub.refundStatus}
                              </Badge>
                            )}
                          </div>
                          {sub.reconcileError && (
                            <p className="text-[11px] text-epic-danger mt-1">
                              {sub.reconcileError}
                            </p>
                          )}
                        </Cell>
                        <Cell>
                          <div className="text-xs text-white space-y-0.5">
                            <div>
                              {formatEpoch(sub.currentPeriodStart)} →{" "}
                              {formatEpoch(sub.currentPeriodEnd)}
                            </div>
                            {sub.graceUntil && (
                              <div className="text-epic-warning">
                                Grace until {formatEpoch(sub.graceUntil)}
                              </div>
                            )}
                            {sub.canceledAt && (
                              <div className="text-epic-text-muted">
                                Canceled {formatEpoch(sub.canceledAt)}
                              </div>
                            )}
                          </div>
                        </Cell>
                        <Cell>
                          <div className="font-mono text-[11px] text-epic-text-muted space-y-0.5">
                            <div className="select-all">
                              {sub.stripeSubscriptionId ?? "No Stripe sub ID"}
                            </div>
                            {sub.lastInvoiceId && (
                              <div>Invoice: {sub.lastInvoiceId}</div>
                            )}
                            {sub.refundedEurCents > 0 && (
                              <div className="text-white">
                                Refunded: {formatEur(sub.refundedEurCents)}
                              </div>
                            )}
                          </div>
                        </Cell>
                      </Row>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div>
                <div className="px-5 py-3 border-b border-epic-border flex items-center justify-between text-xs font-medium text-epic-text-muted uppercase tracking-wider">
                  <span>Payments &amp; Purchase Receipts</span>
                  <span>{detail.billing.receipts.length} total</span>
                </div>
                <Table
                  aria-label="User purchase receipts"
                  className="border-0 rounded-none"
                >
                  <TableHeader>
                    <Column isRowHeader>Receipt</Column>
                    <Column>Project</Column>
                    <Column>Plan</Column>
                    <Column>Amount</Column>
                    <Column>Withdrawal window</Column>
                    <Column>Recorded</Column>
                  </TableHeader>
                  <TableBody
                    items={detail.billing.receipts}
                    renderEmptyState={() => (
                      <p className="p-5 text-sm text-epic-text-muted text-center">
                        No purchase receipts recorded for this user.
                      </p>
                    )}
                  >
                    {(rcpt) => (
                      <Row id={rcpt.id} textValue={rcpt.id}>
                        <Cell>
                          <div className="font-mono text-xs text-white select-all">
                            {rcpt.id}
                          </div>
                          {rcpt.stripeCheckoutSessionId && (
                            <div className="font-mono text-[11px] text-epic-text-muted">
                              {rcpt.stripeCheckoutSessionId}
                            </div>
                          )}
                        </Cell>
                        <Cell>
                          <div className="text-xs text-white">
                            {rcpt.projectName ?? rcpt.projectId}
                          </div>
                          <div className="font-mono text-[11px] text-epic-text-muted">
                            {rcpt.projectId}
                          </div>
                        </Cell>
                        <Cell>
                          <div className="font-mono text-xs text-white">
                            {rcpt.planVersionId}
                          </div>
                          <div className="text-[11px] text-epic-text-muted">
                            {rcpt.actionType} · Terms {rcpt.termsVersion}
                          </div>
                        </Cell>
                        <Cell>
                          <span className="font-mono text-xs text-white">
                            {formatEur(rcpt.priceEurCents, rcpt.currency)}
                          </span>
                          <div className="text-[11px] text-epic-text-muted">
                            {rcpt.vatIncluded ? "VAT incl." : "Excl. VAT"}
                          </div>
                        </Cell>
                        <Cell>
                          <span className="text-xs text-epic-text-muted">
                            Until {formatEpoch(rcpt.withdrawalExpiresAt)}
                          </span>
                        </Cell>
                        <Cell>
                          <span className="text-xs text-white">
                            {formatEpoch(rcpt.acceptedAt)}
                          </span>
                        </Cell>
                      </Row>
                    )}
                  </TableBody>
                </Table>
              </div>

              {(detail.billing.withdrawals.length > 0 ||
                detail.billing.usageAdjustments.length > 0 ||
                detail.billing.actions.length > 0) && (
                <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {detail.billing.withdrawals.length > 0 && (
                    <div className="rounded-lg border border-epic-border bg-epic-bg/40 overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-epic-border text-xs font-medium text-epic-text-muted uppercase tracking-wider">
                        Withdrawals &amp; Refunds (
                        {detail.billing.withdrawals.length})
                      </div>
                      <div className="divide-y divide-epic-border">
                        {detail.billing.withdrawals.map((w) => (
                          <div key={w.id} className="p-3.5 text-xs space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-white">
                                {w.requestKind} ·{" "}
                                {formatEur(
                                  w.refundedAmountCents ||
                                    w.requestedAmountCents ||
                                    0,
                                )}
                              </span>
                              <Badge
                                tone={
                                  w.status.startsWith("refunded")
                                    ? "success"
                                    : w.status === "failed" ||
                                        w.status === "denied"
                                      ? "danger"
                                      : "warning"
                                }
                              >
                                {w.status}
                              </Badge>
                            </div>
                            <p className="text-epic-text-muted">
                              {w.projectName ?? w.projectId} ·{" "}
                              {adminDate(w.createdAt)}
                              {w.stripeRefundId ? ` · ${w.stripeRefundId}` : ""}
                            </p>
                            {w.reason && (
                              <p className="text-epic-text">{w.reason}</p>
                            )}
                            {w.resolutionNote && (
                              <p className="text-epic-text-muted">
                                {w.resolutionNote}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(detail.billing.usageAdjustments.length > 0 ||
                    detail.billing.actions.length > 0) && (
                    <div className="rounded-lg border border-epic-border bg-epic-bg/40 overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-epic-border text-xs font-medium text-epic-text-muted uppercase tracking-wider">
                        Recent Billing Events &amp; Credits
                      </div>
                      <div className="divide-y divide-epic-border max-h-72 overflow-y-auto">
                        {detail.billing.usageAdjustments.map((adj) => (
                          <div
                            key={adj.adjustmentId}
                            className="p-3.5 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-epic-success">
                                +{adj.amount.toLocaleString()} req credit (
                                {adj.scope})
                              </span>
                              <span className="text-epic-text-muted">
                                {adminDate(adj.createdAt)}
                              </span>
                            </div>
                            <p className="text-epic-text">{adj.reason}</p>
                            <p className="font-mono text-[11px] text-epic-text-muted">
                              {adj.projectId ?? "Account"} · by{" "}
                              {adj.actorId ?? "system"}
                            </p>
                          </div>
                        ))}
                        {detail.billing.actions.map((act) => (
                          <div key={act.id} className="p-3.5 text-xs space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-white">
                                {act.action}
                              </span>
                              <Badge
                                tone={
                                  act.status === "ok"
                                    ? "success"
                                    : act.status === "failed"
                                      ? "danger"
                                      : "neutral"
                                }
                              >
                                {act.status}
                              </Badge>
                            </div>
                            <p className="text-epic-text-muted">
                              {act.projectId ?? "Account"} ·{" "}
                              {adminDate(act.createdAt)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {(detail.limitRequests.length > 0 ||
            detail.privacyRequests.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {detail.limitRequests.length > 0 && (
                <section
                  aria-label="Limit requests"
                  className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden"
                >
                  <div className="p-4 border-b border-epic-border">
                    <h2 className="text-base font-semibold text-white">
                      Limit requests
                    </h2>
                  </div>
                  <div className="divide-y divide-epic-border">
                    {detail.limitRequests.map((req) => (
                      <div key={req.id} className="p-4 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-white">
                            {req.requestedTier} ·{" "}
                            {req.requestedRpm.toLocaleString()} rpm
                          </span>
                          <Badge
                            tone={
                              req.status === "approved"
                                ? "success"
                                : req.status === "declined"
                                  ? "danger"
                                  : "warning"
                            }
                          >
                            {req.status}
                          </Badge>
                        </div>
                        <p className="text-epic-text-muted">
                          Project:{" "}
                          <span className="font-mono">{req.projectId}</span> ·{" "}
                          {adminDate(req.createdAt)}
                        </p>
                        {req.reviewNote && (
                          <p className="text-epic-text">{req.reviewNote}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {detail.privacyRequests.length > 0 && (
                <section
                  aria-label="Privacy requests"
                  className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden"
                >
                  <div className="p-4 border-b border-epic-border">
                    <h2 className="text-base font-semibold text-white">
                      Privacy requests
                    </h2>
                  </div>
                  <div className="divide-y divide-epic-border">
                    {detail.privacyRequests.map((req) => (
                      <div key={req.id} className="p-4 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-white">
                            {req.kind} · {req.caseReference}
                          </span>
                          <Badge tone={req.resolvedAt ? "success" : "warning"}>
                            {req.resolvedAt ? "Resolved" : "Open"}
                          </Badge>
                        </div>
                        <p className="text-epic-text-muted">
                          Received {formatEpoch(req.receivedAt)} · Due{" "}
                          {formatEpoch(req.extendedDueAt ?? req.dueAt)}
                        </p>
                        {req.resolution && (
                          <p className="text-epic-text">{req.resolution}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          <section
            aria-label="Audit history"
            className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-4"
          >
            <h2 className="text-base font-semibold text-white">
              Audit history
            </h2>
            <AdminAudit owner={detail.user.id} />
          </section>

          <AdminUsageNote usage={detail.usage} />
        </>
      ) : null}

      <Modal
        isOpen={editing}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(false);
        }}
        size="md"
      >
        <Dialog>
          <Form onSubmit={saveLimit}>
            <Heading slot="title" className="text-lg font-semibold">
              Project limit · {detail?.user.displayName}
            </Heading>
            <TextField
              label="Maximum projects (1–100)"
              type="number"
              isRequired
              value={limit}
              onChange={setLimit}
            />
            <TextField
              label="Reason"
              isRequired
              minLength={3}
              maxLength={2000}
              value={reason}
              onChange={setReason}
            />
            <p className="text-xs text-epic-text-muted">
              Existing projects are retained when the limit is lowered. The
              24-hour project creation cooldown still applies.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                isDisabled={saving}
                onPress={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button type="submit" isPending={saving}>
                Save limit
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>

      <Modal
        isOpen={creditProjectId !== null}
        onOpenChange={(open) => {
          if (!open && !creditSaving) setCreditProjectId(null);
        }}
        size="md"
      >
        <Dialog>
          <Form onSubmit={saveCredit}>
            <Heading slot="title" className="text-lg font-semibold">
              Credit project quota
            </Heading>
            <Select
              label="Quota scope"
              selectedKey={creditScope}
              onSelectionChange={(k) => {
                if (k === "period" || k === "month") setCreditScope(k);
              }}
              items={[
                { id: "period", label: "Current billing period (paid plan)" },
                { id: "month", label: "Current UTC month (free quota)" },
              ]}
            >
              {(item) => (
                <SelectItem id={item.id} textValue={item.label}>
                  {item.label}
                </SelectItem>
              )}
            </Select>
            <TextField
              label="Requests to credit (1–1,000,000)"
              type="number"
              isRequired
              value={creditAmount}
              onChange={setCreditAmount}
            />
            <TextField
              label="Reason"
              isRequired
              minLength={3}
              maxLength={2000}
              value={creditReason}
              onChange={setCreditReason}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                isDisabled={creditSaving}
                onPress={() => setCreditProjectId(null)}
              >
                Cancel
              </Button>
              <Button type="submit" isPending={creditSaving}>
                Apply credit
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>
    </div>
  );
}
