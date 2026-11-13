import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
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
                  </Row>
                )}
              </TableBody>
            </Table>
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
    </div>
  );
}
