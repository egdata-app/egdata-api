import { createFileRoute, Link } from "@tanstack/react-router";
import {
  History,
  KeyRound,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AdminProject } from "../../worker/admin-types";
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
import {
  type DashboardApiKey,
  type DashboardProject,
  dashboardClient,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/admin/projects")({
  validateSearch: (search: Record<string, unknown>): { owner: string } => ({
    owner: typeof search.owner === "string" ? search.owner : "",
  }),
  component: AdminProjectsPage,
});

const propagationNotice =
  "Existing key caches may take up to five minutes to refresh.";
const tiers = [
  { id: "free", name: "Free · 60/120 requests/min" },
  { id: "pro", name: "Pro · 200 requests/min (manual override 1,200)" },
  { id: "scale", name: "Scale · 600 requests/min" },
  { id: "enterprise", name: "Enterprise · 6,000 requests/min" },
];

function AdminProjectsPage() {
  const { isAdmin } = useDashboardAuth();
  const { owner } = Route.useSearch();
  return isAdmin ? (
    <Projects key={owner} owner={owner} />
  ) : (
    <p role="alert">Administrator access required.</p>
  );
}

function Projects({ owner }: { owner: string }) {
  const { refreshSession } = useDashboardAuth();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<"active" | "deleted">("active");
  const load = useCallback(
    (signal: AbortSignal) =>
      dashboardClient.getAdminProjects(search, offset, owner, status, signal),
    [search, offset, owner, status],
  );
  const { page, loading, error, reload } = useAdminPage(load);
  const [editing, setEditing] = useState<AdminProject | null>(null);
  const [deleting, setDeleting] = useState<AdminProject | null>(null);
  const [keysProject, setKeysProject] = useState<AdminProject | null>(null);
  const [tier, setTier] = useState<DashboardProject["tier"]>("free");
  const [rpm, setRpm] = useState("");
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<AdminProject | null>(null);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<string | null>(null);

  function changed() {
    reload();
    void refreshSession().catch(() =>
      notify({
        title: "Refresh the page to update your project selector",
        tone: "danger",
      }),
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      await dashboardClient.updateAdminProjectLimits(
        editing.id,
        tier,
        rpm.trim() === "" ? null : Number(rpm),
        reason,
      );
      setEditing(null);
      changed();
      notify({
        title: "Project limits updated",
        description: propagationNotice,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not update limits",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  async function deleteProject() {
    if (!deleting) return;
    setSaving(true);
    try {
      await dashboardClient.deleteAdminProject(deleting.id, reason);
      setDeleting(null);
      changed();
      notify({
        title: "Project moved to Deleted projects",
        description: propagationNotice,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not delete project",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  async function restoreProject() {
    if (!restoring) return;
    setSaving(true);
    try {
      await dashboardClient.restoreAdminProject(restoring.id, reason);
      setRestoring(null);
      changed();
      notify({
        title: "Project restored",
        description:
          "Issue new API keys to resume access. Previous keys remain revoked.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not restore project",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Projects
            </h1>
            <Badge tone="accent">
              Admin · {owner ? "Owner scope" : "All projects"}
            </Badge>
          </div>
          <p className="text-sm text-epic-text-muted mt-1">
            Manage platform projects, shared request limits, and API keys.
          </p>
        </div>
        <Button variant="secondary" onPress={() => setHistory("")}>
          <History aria-hidden="true" className="w-4 h-4" />
          Audit history
        </Button>
      </div>
      {owner && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-epic-text-muted">
          Filtered by owner
          <span className="font-mono text-epic-text break-all">{owner}</span>
          <Link
            to="/admin/projects"
            search={{ owner: "" }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-epic-border bg-epic-elevated px-2 py-1 text-epic-text hover:bg-epic-hover focus-visible:outline-2 focus-visible:outline-epic-accent"
          >
            Show all projects
            <X aria-hidden="true" className="w-3 h-3" />
          </Link>
        </div>
      )}
      <section
        aria-label="Project directory"
        className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden"
      >
        <AdminToolbar
          loading={loading}
          reload={reload}
          placeholder="Search project, ID, or owner…"
          onSearch={(value) => {
            setSearch(value);
            setOffset(0);
          }}
        >
          <Select
            aria-label="Project status"
            className="w-44"
            selectedKey={status}
            onSelectionChange={(key) => {
              if (key === "active" || key === "deleted") {
                setStatus(key);
                setOffset(0);
              }
            }}
            items={[
              { id: "active", name: "Active projects" },
              { id: "deleted", name: "Deleted projects" },
            ]}
          >
            {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
          </Select>
        </AdminToolbar>
        <Table
          aria-label="Platform projects"
          aria-busy={loading}
          className="border-0 rounded-none"
        >
          <TableHeader>
            <Column isRowHeader>Project / owner</Column>
            <Column>Rate limit</Column>
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
                noun="projects"
                filtered={Boolean(search || owner || status === "deleted")}
                retry={reload}
              />
            )}
          >
            {(project) => (
              <Row id={project.id} textValue={project.name}>
                <Cell>
                  <AdminIdentity
                    name={project.name}
                    detail={project.ownerDisplayName}
                    kind="project"
                    badge={
                      project.deletedAt ? (
                        <Badge
                          tone="danger"
                          className="text-[10px] px-1.5 shrink-0"
                        >
                          Deleted
                        </Badge>
                      ) : undefined
                    }
                  >
                    <div
                      className="font-mono text-[10px] text-epic-text-muted truncate"
                      title={project.id}
                    >
                      {project.id}
                    </div>
                  </AdminIdentity>
                  {project.deletedAt && (
                    <details className="text-[11px] text-epic-text-muted mt-2 max-w-80">
                      <summary className="cursor-pointer text-epic-warning rounded focus-visible:outline-2 focus-visible:outline-epic-accent">
                        Deletion & recovery details
                      </summary>
                      <div className="mt-2 space-y-1 border-l border-epic-border pl-3 break-words">
                        <p>
                          Deleted {adminDate(project.deletedAt)} by{" "}
                          {project.deletedBy}
                        </p>
                        <p className="whitespace-pre-wrap">
                          {project.deletionReason}
                        </p>
                        <p>
                          Recovery deadline: {adminDate(project.purgeAfter)}
                        </p>
                      </div>
                    </details>
                  )}
                </Cell>
                <Cell>
                  <div className="font-mono text-xs tabular-nums whitespace-nowrap">
                    {project.effectiveRpm.toLocaleString()}{" "}
                    <span className="text-epic-text-muted text-[10px]">
                      / min
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <Badge
                      tone={project.tier === "free" ? "neutral" : "accent"}
                      className="capitalize text-[10px] px-1.5"
                    >
                      {project.tier}
                    </Badge>
                    {project.customRpm !== null && (
                      <span className="text-[10px] text-epic-text-muted">
                        Custom
                      </span>
                    )}
                  </div>
                </Cell>
                <Cell>
                  <AdminKeyCount
                    active={project.activeKeyCount}
                    total={project.keyCount}
                  />
                </Cell>
                <Cell>
                  {page && (
                    <AdminRequestCount usage={page.usage} id={project.id} />
                  )}
                </Cell>
                <Cell>
                  {page && (
                    <AdminErrorCounts usage={page.usage} id={project.id} />
                  )}
                </Cell>
                <Cell>
                  <AdminLastUsed value={project.lastUsedAt} />
                </Cell>
                <Cell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="quiet"
                      aria-label={`View keys for ${project.name}`}
                      onPress={() => setKeysProject(project)}
                    >
                      <KeyRound aria-hidden="true" className="w-3.5 h-3.5" />
                      Keys
                    </Button>
                    <AdminRowActions
                      label={project.name}
                      actions={[
                        {
                          id: "edit",
                          label: "Edit limits",
                          icon: <SlidersHorizontal className="w-3.5 h-3.5" />,
                          disabled: Boolean(project.deletedAt),
                          onAction: () => {
                            setEditing(project);
                            setReason("");
                            setTier(project.tier);
                            setRpm(
                              project.customRpm === null
                                ? ""
                                : String(project.customRpm),
                            );
                          },
                        },
                        {
                          id: "history",
                          label: "View history",
                          icon: <History className="w-3.5 h-3.5" />,
                          onAction: () => setHistory(project.id),
                        },
                        project.deletedAt
                          ? {
                              id: "restore",
                              label: "Restore project",
                              icon: <RotateCcw className="w-3.5 h-3.5" />,
                              disabled:
                                !project.purgeAfter ||
                                Date.parse(project.purgeAfter) <= Date.now(),
                              onAction: () => {
                                setRestoring(project);
                                setReason("");
                              },
                            }
                          : {
                              id: "delete",
                              label: "Delete project",
                              icon: <Trash2 className="w-3.5 h-3.5" />,
                              destructive: true,
                              onAction: () => {
                                setDeleting(project);
                                setReason("");
                              },
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
              Limits · {editing?.name}
            </Heading>
            <Select
              label="Tier"
              selectedKey={tier}
              items={tiers}
              onSelectionChange={(key) => {
                if (key === "free" || key === "pro" || key === "enterprise")
                  setTier(key);
              }}
            >
              {(item) => (
                <SelectItem id={item.id} textValue={item.name}>
                  {item.name}
                </SelectItem>
              )}
            </Select>
            <TextField
              label="Custom requests per minute"
              type="number"
              value={rpm}
              onChange={setRpm}
              description="150–500,000. Leave blank to use the selected tier's default."
              validate={(value) => {
                if (value.trim() === "") return null;
                const limit = Number(value);
                return Number.isInteger(limit) &&
                  limit >= 150 &&
                  limit <= 500_000
                  ? null
                  : "Enter a whole number between 150 and 500,000.";
              }}
            />
            <p className="text-xs text-epic-text-muted">
              Shared by all project keys and console sessions. Changing custom
              RPM alone on a free project keeps the 100,000/month free-account
              allowance; switch tier to Pro or Enterprise to exempt the project.{" "}
              {propagationNotice}
            </p>
            <TextField
              label="Reason"
              isRequired
              minLength={3}
              maxLength={2000}
              value={reason}
              onChange={setReason}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                isDisabled={saving}
                onPress={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" isPending={saving}>
                Save limits
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>

      <Modal
        isOpen={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setDeleting(null);
        }}
        size="md"
      >
        <Dialog className="space-y-4">
          <Heading slot="title" className="text-lg font-semibold">
            Delete {deleting?.name}?
          </Heading>
          <p className="text-sm text-epic-text-muted">
            This hides the project and revokes its keys and console sessions.
            Project records remain recoverable by admins for 90 days, then are
            permanently purged. Audit history is retained. Restoring a project
            requires new credentials. {propagationNotice}
          </p>
          <TextField
            label="Reason for deletion"
            isRequired
            minLength={3}
            maxLength={2000}
            value={reason}
            onChange={setReason}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              isDisabled={saving}
              onPress={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              isPending={saving}
              isDisabled={reason.trim().length < 3}
              onPress={() => void deleteProject()}
            >
              Delete project
            </Button>
          </div>
        </Dialog>
      </Modal>

      <Modal
        isOpen={restoring !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setRestoring(null);
        }}
        size="md"
      >
        <Dialog className="space-y-4">
          <Heading slot="title">Restore {restoring?.name}?</Heading>
          <p className="text-sm text-epic-text-muted">
            The project counts against its owner's allowance again. All old keys
            remain revoked; issue new keys after restoring.
          </p>
          <TextField
            label="Reason for restoration"
            isRequired
            minLength={3}
            maxLength={2000}
            value={reason}
            onChange={setReason}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              isDisabled={saving}
              onPress={() => setRestoring(null)}
            >
              Cancel
            </Button>
            <Button
              isPending={saving}
              isDisabled={reason.trim().length < 3}
              onPress={() => void restoreProject()}
            >
              Restore project
            </Button>
          </div>
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
          <Heading slot="title">
            Audit history{history ? ` · ${history}` : ""}
          </Heading>
          {history !== null && <AdminAudit key={history} projectId={history} />}
          <Button variant="secondary" onPress={() => setHistory(null)}>
            Close
          </Button>
        </Dialog>
      </Modal>

      <Modal
        isOpen={keysProject !== null}
        onOpenChange={(open) => {
          if (!open) setKeysProject(null);
        }}
        size="lg"
      >
        <Dialog className="space-y-4">
          {keysProject && (
            <ProjectKeys
              key={keysProject.id}
              project={keysProject}
              onChanged={reload}
            />
          )}
          <div className="flex justify-end">
            <Button variant="secondary" onPress={() => setKeysProject(null)}>
              Close
            </Button>
          </div>
        </Dialog>
      </Modal>
    </div>
  );
}

function ProjectKeys({
  project,
  onChanged,
}: {
  project: AdminProject;
  onChanged: () => void;
}) {
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [deleting, setDeleting] = useState<DashboardApiKey | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers an explicit retry after loading fails.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void dashboardClient
      .getAdminProjectKeys(project.id, offset, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setKeys(result.keys);
          setHasMore(result.hasMore);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : "Could not load keys.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.id, offset, version]);

  async function deleteKey() {
    if (!deleting) return;
    setSaving(true);
    try {
      await dashboardClient.deleteAdminKey(deleting.id, reason);
      setVersion((value) => value + 1);
      setDeleting(null);
      onChanged();
      notify({
        title: "API key deleted",
        description: propagationNotice,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not delete key",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Heading slot="title" className="text-lg font-semibold">
        API keys · {project.name}
      </Heading>
      {loading ? (
        <output>Loading keys...</output>
      ) : error ? (
        <div>
          <p role="alert" className="text-epic-danger">
            {error}
          </p>
          <Button onPress={() => setVersion((value) => value + 1)}>
            Retry
          </Button>
        </div>
      ) : (
        <Table aria-label={`Keys for ${project.name}`}>
          <TableHeader>
            <Column isRowHeader>Key</Column>
            <Column>Status</Column>
            <Column>Last used</Column>
            <Column>Actions</Column>
          </TableHeader>
          <TableBody
            items={keys}
            renderEmptyState={() => "No keys in this project."}
          >
            {(key) => (
              <Row id={key.id}>
                <Cell>
                  <div>{key.name}</div>
                  <code className="text-xs text-epic-text-muted">
                    {key.keyPrefix}...
                  </code>
                </Cell>
                <Cell>
                  {key.revokedAt
                    ? `Revoked ${adminDate(key.revokedAt)}`
                    : key.expiresAt && Date.parse(key.expiresAt) <= Date.now()
                      ? "Expired"
                      : key.active
                        ? "Active"
                        : "Disabled"}
                </Cell>
                <Cell>{adminDate(key.lastUsedAt)}</Cell>
                <Cell>
                  <Button
                    size="sm"
                    variant="destructive"
                    isDisabled={saving || Boolean(key.revokedAt)}
                    onPress={() => {
                      setDeleting(key);
                      setReason("");
                    }}
                  >
                    Delete
                  </Button>
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
      )}
      {deleting && (
        <div className="rounded-lg border border-epic-border p-4 space-y-3">
          <p>
            Delete <strong>{deleting.name}</strong>? This key cannot be
            restored.
          </p>
          <p className="text-xs text-epic-text-muted">{propagationNotice}</p>
          <TextField
            label="Reason for revocation"
            isRequired
            minLength={3}
            maxLength={2000}
            value={reason}
            onChange={setReason}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              isDisabled={saving}
              onPress={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              isPending={saving}
              onPress={() => void deleteKey()}
              isDisabled={reason.trim().length < 3}
            >
              Delete key
            </Button>
          </div>
        </div>
      )}
      {!loading && !error && (
        <AdminPagination
          offset={offset}
          hasMore={hasMore}
          onChange={setOffset}
        />
      )}
    </>
  );
}
