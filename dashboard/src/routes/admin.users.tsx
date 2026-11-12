import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, History, SlidersHorizontal } from "lucide-react";
import { useCallback, useState } from "react";
import type { AdminUser } from "../../worker/admin-types";
import { AdminAudit } from "../components/AdminAudit";
import {
  AdminPagination,
  AdminToolbar,
  AdminUsageNote,
  adminDate,
  useAdminPage,
} from "../components/AdminShared";
import {
  AdminErrorCounts,
  AdminIdentity,
  AdminKeyCount,
  AdminLastUsed,
  AdminRequestCount,
  AdminRowActions,
  AdminTableState,
} from "../components/AdminTable";
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
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const { isAdmin } = useDashboardAuth();
  return isAdmin ? (
    <Users />
  ) : (
    <p role="alert">Administrator access required.</p>
  );
}

function Users() {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) =>
      dashboardClient.getAdminUsers(search, offset, signal),
    [search, offset],
  );
  const { page, loading, error, reload } = useAdminPage(load);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<AdminUser | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      await dashboardClient.updateAdminUserLimits(
        editing.id,
        Number(limit),
        reason,
      );
      setEditing(null);
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
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Users
          </h1>
          <Badge tone="accent">Admin · All accounts</Badge>
        </div>
        <p className="text-sm text-epic-text-muted mt-1">
          Platform accounts, project allowances, and API activity.
        </p>
      </div>
      <section
        aria-label="User directory"
        className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden"
      >
        <AdminToolbar
          loading={loading}
          reload={reload}
          placeholder="Search name, email, or ID…"
          onSearch={(value) => {
            setSearch(value);
            setOffset(0);
          }}
        />
        <Table
          aria-label="Platform users"
          aria-busy={loading}
          className="border-0 rounded-none"
        >
          <TableHeader>
            <Column isRowHeader>User</Column>
            <Column>Projects</Column>
            <Column>API keys</Column>
            <Column>Requests · 24h</Column>
            <Column>Errors · 24h</Column>
            <Column>Last active</Column>
            <Column>Actions</Column>
          </TableHeader>
          <TableBody
            items={page?.rows ?? []}
            renderEmptyState={() => (
              <AdminTableState
                loading={loading}
                error={error}
                noun="users"
                filtered={Boolean(search)}
                retry={reload}
              />
            )}
          >
            {(user) => (
              <Row id={user.id} textValue={user.displayName}>
                <Cell>
                  <AdminIdentity
                    name={user.displayName}
                    detail={user.email || user.id}
                    kind="user"
                    badge={
                      user.isAdmin ? (
                        <Badge
                          tone="accent"
                          className="text-[10px] px-1.5 shrink-0"
                        >
                          Admin
                        </Badge>
                      ) : undefined
                    }
                  >
                    <div
                      className="text-[11px] text-epic-text-muted"
                      title={adminDate(user.createdAt)}
                    >
                      Joined{" "}
                      {new Date(user.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </div>
                  </AdminIdentity>
                </Cell>
                <Cell>
                  <div className="min-w-20 space-y-2">
                    <div className="font-mono text-xs tabular-nums">
                      {user.projectCount}{" "}
                      <span className="text-epic-text-muted">
                        / {user.projectLimit}
                      </span>
                    </div>
                    <div
                      aria-hidden="true"
                      className="h-1 w-16 rounded-full bg-epic-bg overflow-hidden"
                    >
                      <div
                        className={`h-full rounded-full ${user.projectCount >= user.projectLimit ? "bg-epic-warning" : "bg-epic-accent"}`}
                        style={{
                          width: `${user.projectLimit ? Math.min(100, (user.projectCount / user.projectLimit) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="sr-only">
                      {user.projectCount} projects of {user.projectLimit}{" "}
                      allowed
                    </span>
                  </div>
                </Cell>
                <Cell>
                  <AdminKeyCount
                    active={user.activeKeyCount}
                    total={user.keyCount}
                  />
                </Cell>
                <Cell>
                  {page && (
                    <AdminRequestCount usage={page.usage} id={user.id} />
                  )}
                </Cell>
                <Cell>
                  {page && <AdminErrorCounts usage={page.usage} id={user.id} />}
                </Cell>
                <Cell>
                  <AdminLastUsed value={user.lastUsedAt} />
                </Cell>
                <Cell>
                  <div className="flex gap-2 items-center">
                    <Link
                      to="/admin/projects"
                      search={{ owner: user.id }}
                      aria-label={`View projects for ${user.displayName}`}
                      className="inline-flex items-center gap-1 text-xs text-epic-accent hover:text-epic-accent-hover rounded focus-visible:outline-2 focus-visible:outline-epic-accent focus-visible:outline-offset-4"
                    >
                      Projects
                      <ArrowUpRight
                        aria-hidden="true"
                        className="w-3.5 h-3.5"
                      />
                    </Link>
                    <AdminRowActions
                      label={user.displayName}
                      actions={[
                        {
                          id: "edit",
                          label: "Edit project limit",
                          icon: <SlidersHorizontal className="w-3.5 h-3.5" />,
                          onAction: () => {
                            setEditing(user);
                            setReason("");
                            setLimit(String(user.projectLimit));
                          },
                        },
                        {
                          id: "history",
                          label: "View history",
                          icon: <History className="w-3.5 h-3.5" />,
                          onAction: () => setHistory(user),
                        },
                      ]}
                    />
                  </div>
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
        <div className="p-4 border-t border-epic-border space-y-4">
          <AdminPagination
            offset={offset}
            hasMore={page?.hasMore ?? false}
            count={page?.rows.length ?? 0}
            loading={loading}
            onChange={setOffset}
          />
          {page && <AdminUsageNote usage={page.usage} />}
        </div>
      </section>
      <Modal
        isOpen={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
        size="md"
      >
        <Dialog>
          <Form onSubmit={save}>
            <Heading slot="title" className="text-lg font-semibold">
              Project limit · {editing?.displayName}
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
                onPress={() => setEditing(null)}
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
        isOpen={history !== null}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
        size="xl"
      >
        <Dialog className="space-y-4">
          <Heading slot="title">History · {history?.displayName}</Heading>
          {history && <AdminAudit key={history.id} owner={history.id} />}
          <Button variant="secondary" onPress={() => setHistory(null)}>
            Close
          </Button>
        </Dialog>
      </Modal>
    </div>
  );
}
