import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { AdminUser } from "../../worker/admin-types";
import { AdminAudit } from "../components/AdminAudit";
import {
  AdminPagination,
  AdminToolbar,
  AdminUsageNote,
  adminDate,
  usageNumber,
  useAdminPage,
} from "../components/AdminShared";
import { Button } from "../components/ui/Button";
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
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Users</h1>
        <p className="text-sm text-epic-text-muted mt-1">
          Platform accounts, project allowances, and API activity.
        </p>
      </div>
      <AdminToolbar
        loading={loading}
        reload={reload}
        onSearch={(value) => {
          setSearch(value);
          setOffset(0);
        }}
      />
      {loading && <output>Loading users...</output>}
      {error && (
        <p role="alert" className="text-epic-danger">
          {error}
        </p>
      )}
      {page && (
        <>
          <AdminUsageNote usage={page.usage} />
          <Table aria-label="Platform users">
            <TableHeader>
              <Column isRowHeader>User</Column>
              <Column>Projects / limit</Column>
              <Column>Active / total keys</Column>
              <Column>Requests (24h)</Column>
              <Column>429s / errors (24h)</Column>
              <Column>Last key use</Column>
              <Column>Actions</Column>
            </TableHeader>
            <TableBody
              items={page.rows}
              renderEmptyState={() => "No users found."}
            >
              {(user) => (
                <Row id={user.id}>
                  <Cell>
                    <div className="font-medium">
                      {user.displayName}
                      {user.isAdmin ? " · Admin" : ""}
                    </div>
                    <div className="text-xs text-epic-text-muted">
                      {user.email || user.id}
                    </div>
                    <div className="text-xs text-epic-text-muted">
                      Joined {adminDate(user.createdAt)}
                    </div>
                  </Cell>
                  <Cell>
                    {user.projectCount} / {user.projectLimit}
                  </Cell>
                  <Cell>
                    {user.activeKeyCount} / {user.keyCount}
                  </Cell>
                  <Cell>{usageNumber(page.usage, user.id, "requests")}</Cell>
                  <Cell>
                    {usageNumber(page.usage, user.id, "rateLimited")} /{" "}
                    {usageNumber(page.usage, user.id, "errors")}
                  </Cell>
                  <Cell>{adminDate(user.lastUsedAt)}</Cell>
                  <Cell>
                    <div className="flex gap-2 items-center">
                      <Link
                        to="/admin/projects"
                        search={{ owner: user.id }}
                        className="text-epic-accent"
                      >
                        Projects
                      </Link>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => {
                          setEditing(user);
                          setReason("");
                          setLimit(String(user.projectLimit));
                        }}
                      >
                        Edit limit
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => setHistory(user)}
                      >
                        History
                      </Button>
                    </div>
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
          <AdminPagination
            offset={offset}
            hasMore={page.hasMore}
            onChange={setOffset}
          />
        </>
      )}
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
