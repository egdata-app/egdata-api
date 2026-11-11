import { createFileRoute } from "@tanstack/react-router";
import {
  Check,
  Copy,
  Globe,
  KeyRound,
  Network,
  Plus,
  Settings2,
  Shield,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { API_SCOPES, HTTP_METHODS } from "../../worker/types";
import { Button } from "../components/ui/Button";
import {
  Checkbox,
  CheckboxGroup,
  Switch,
  Tag,
} from "../components/ui/Controls";
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
import {
  type AllowedHttpMethod,
  type ApiScope,
  type DashboardApiKey,
  dashboardClient,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/keys")({
  component: ApiKeysPage,
});

function splitListInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ApiKeysPage() {
  const { selectedProject } = useDashboardAuth();
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const [loading, setLoading] = useState(true);

  // Create key modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>([...API_SCOPES]);
  const [newMethods, setNewMethods] = useState<string[]>(["GET", "HEAD"]);
  const [newIps, setNewIps] = useState("");
  const [newOrigins, setNewOrigins] = useState("");
  const [newPaths, setNewPaths] = useState("");

  // Reveal created secret modal
  const [revealedSecret, setRevealedSecret] = useState<{
    name: string;
    secret: string;
  } | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Edit permissions modal state
  const [editingKey, setEditingKey] = useState<DashboardApiKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editScopes, setEditScopes] = useState<string[]>([]);
  const [editMethods, setEditMethods] = useState<string[]>([]);
  const [editIps, setEditIps] = useState("");
  const [editOrigins, setEditOrigins] = useState("");
  const [editPaths, setEditPaths] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete confirmation modal
  const [deletingKey, setDeletingKey] = useState<DashboardApiKey | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadKeys = useCallback(async () => {
    if (!selectedProject) return;
    setLoading(true);
    try {
      const res = await dashboardClient.getKeys(selectedProject.id);
      setKeys(res.keys);
    } catch (err) {
      notify({
        title: "Failed to load API keys",
        description: err instanceof Error ? err.message : "Unknown error",
        tone: "danger",
      });
    } finally {
      setLoading(false);
    }
  }, [selectedProject]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  function openEditModal(k: DashboardApiKey) {
    setEditingKey(k);
    setEditName(k.name);
    setEditActive(k.active);
    setEditScopes([...k.scopes]);
    setEditMethods([...k.allowedMethods]);
    setEditIps(k.allowedIps.join("\n"));
    setEditOrigins(k.allowedOrigins.join("\n"));
    setEditPaths(k.allowedPaths.join("\n"));
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProject || !newKeyName.trim()) return;
    setCreating(true);
    try {
      const res = await dashboardClient.createKey({
        projectId: selectedProject.id,
        name: newKeyName.trim(),
        scopes: newScopes as ApiScope[],
        allowedMethods: newMethods as AllowedHttpMethod[],
        allowedIps: splitListInput(newIps),
        allowedOrigins: splitListInput(newOrigins),
        allowedPaths: splitListInput(newPaths),
      });
      setCreateOpen(false);
      setNewKeyName("");
      setNewIps("");
      setNewOrigins("");
      setNewPaths("");
      setNewScopes([...API_SCOPES]);
      setNewMethods(["GET", "HEAD"]);
      setRevealedSecret({ name: res.key.name, secret: res.secret });
      await loadKeys();
      notify({
        title: "API key created",
        description: "Copy your secret key now — it will only be shown once.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not create API key",
        description: err instanceof Error ? err.message : "Validation failed",
        tone: "danger",
      });
    } finally {
      setCreating(false);
    }
  }

  async function handleSavePermissions(e: React.FormEvent) {
    e.preventDefault();
    if (!editingKey) return;
    setSavingEdit(true);
    try {
      await dashboardClient.updateKey(editingKey.id, {
        name: editName.trim(),
        active: editActive,
        scopes: editScopes as ApiScope[],
        allowedMethods: editMethods as AllowedHttpMethod[],
        allowedIps: splitListInput(editIps),
        allowedOrigins: splitListInput(editOrigins),
        allowedPaths: splitListInput(editPaths),
      });
      setEditingKey(null);
      await loadKeys();
      notify({
        title: "Permissions updated",
        description: "Changes may take a short time to take effect.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not update permissions",
        description: err instanceof Error ? err.message : "Validation failed",
        tone: "danger",
      });
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingKey) return;
    setDeleting(true);
    try {
      await dashboardClient.deleteKey(deletingKey.id);
      setDeletingKey(null);
      await loadKeys();
      notify({
        title: "API key revoked",
        description: "Revocation may take a short time to take effect.",
        tone: "info",
      });
    } catch (err) {
      notify({
        title: "Failed to revoke key",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            API Keys
          </h1>
          <p className="text-sm text-epic-text-muted mt-1">
            Create keys for{" "}
            <span className="text-epic-text font-medium">
              {selectedProject?.name}
            </span>{" "}
            and choose what each key can access.
          </p>
        </div>
        <Button variant="primary" onPress={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4" />
          Create API Key
        </Button>
      </div>

      {/* Keys Table */}
      <Table aria-label="Project API Keys">
        <TableHeader>
          <Column isRowHeader>Name & Prefix</Column>
          <Column>Status</Column>
          <Column>Restrictions</Column>
          <Column>Scopes</Column>
          <Column>Created / Last Used</Column>
          <Column>Actions</Column>
        </TableHeader>
        <TableBody
          items={keys}
          renderEmptyState={() => (
            <div className="py-12 px-4 text-center space-y-3">
              <KeyRound className="w-8 h-8 text-epic-text-muted mx-auto" />
              <div className="text-sm font-medium text-epic-text">
                {loading
                  ? "Loading API keys..."
                  : "No API keys in this project yet"}
              </div>
              <p className="text-xs text-epic-text-muted max-w-md mx-auto">
                Create a key for your app, then choose its permissions.
              </p>
            </div>
          )}
        >
          {(item) => (
            <Row id={item.id}>
              <Cell>
                <div className="font-medium text-epic-text">{item.name}</div>
                <div className="text-xs font-mono text-epic-text-muted mt-0.5">
                  {item.keyPrefix}
                </div>
              </Cell>
              <Cell>
                <Tag tone={item.active ? "success" : "warning"}>
                  {item.active ? "Active" : "Paused"}
                </Tag>
              </Cell>
              <Cell>
                <div className="flex flex-wrap gap-1.5">
                  <Tag tone={item.allowedIps.length > 0 ? "accent" : "neutral"}>
                    <Network className="w-3 h-3" />
                    {item.allowedIps.length > 0
                      ? `${item.allowedIps.length} IP/CIDR`
                      : "Any IP"}
                  </Tag>
                  <Tag
                    tone={item.allowedOrigins.length > 0 ? "accent" : "neutral"}
                  >
                    <Globe className="w-3 h-3" />
                    {item.allowedOrigins.length > 0
                      ? `${item.allowedOrigins.length} Origin`
                      : "Any Origin"}
                  </Tag>
                  {item.allowedPaths.length > 0 && (
                    <Tag tone="accent">
                      {item.allowedPaths.length} Path Rules
                    </Tag>
                  )}
                </div>
              </Cell>
              <Cell>
                <span className="text-xs text-epic-text-muted">
                  {item.scopes.length === API_SCOPES.length
                    ? "All read scopes"
                    : `${item.scopes.length} scopes`}{" "}
                  ·{" "}
                  <span className="font-mono">
                    {item.allowedMethods.join(", ")}
                  </span>
                </span>
              </Cell>
              <Cell>
                <div className="text-xs text-epic-text">
                  {new Date(item.createdAt).toLocaleDateString()}
                </div>
                <div className="text-[11px] text-epic-text-muted">
                  {item.lastUsedAt
                    ? `Used ${new Date(item.lastUsedAt).toLocaleString()}`
                    : "Never used"}
                </div>
              </Cell>
              <Cell>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => openEditModal(item)}
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    Permissions
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    aria-label={`Revoke ${item.name}`}
                    onPress={() => setDeletingKey(item)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </Cell>
            </Row>
          )}
        </TableBody>
      </Table>

      {/* Create Key Modal */}
      <Modal isOpen={createOpen} onOpenChange={setCreateOpen} size="xl">
        <Dialog>
          {({ close }) => (
            <Form onSubmit={handleCreateKey}>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-epic-accent" />
                <Heading
                  slot="title"
                  className="text-lg font-semibold text-white"
                >
                  Create API Key
                </Heading>
              </div>
              <p className="text-xs text-epic-text-muted -mt-2">
                Choose what this key can access. You can change its permissions
                later.
              </p>

              <TextField
                label="Key Name"
                isRequired
                value={newKeyName}
                onChange={setNewKeyName}
                placeholder="e.g. Production Backend Server"
              />

              <CheckboxGroup
                label="Permission Scopes"
                value={newScopes}
                onChange={setNewScopes}
                description="Choose which types of data this key can read."
              >
                {API_SCOPES.map((scope) => (
                  <Checkbox key={scope} value={scope}>
                    <span className="font-mono text-xs">{scope}</span>
                  </Checkbox>
                ))}
              </CheckboxGroup>

              <CheckboxGroup
                label="Allowed HTTP Methods"
                value={newMethods}
                onChange={setNewMethods}
              >
                {HTTP_METHODS.map((m) => (
                  <Checkbox key={m} value={m}>
                    <span className="font-mono text-xs">{m}</span>
                  </Checkbox>
                ))}
              </CheckboxGroup>

              <div className="grid sm:grid-cols-2 gap-4">
                <TextField
                  label="Allowed IP Addresses / CIDR Ranges (Optional)"
                  multiline
                  value={newIps}
                  onChange={setNewIps}
                  placeholder={"203.0.113.0/24\n198.51.100.42\n2001:db8::/32"}
                  description="Enter one IP address or CIDR range per line. Leave blank to allow any IP."
                />
                <TextField
                  label="Allowed Browser Origins (Optional)"
                  multiline
                  value={newOrigins}
                  onChange={setNewOrigins}
                  placeholder={
                    "https://myapp.example.com\nhttps://*.example.com"
                  }
                  description="Enter one origin per line, including https://. Wildcard subdomains are supported. Leave blank for no origin restriction."
                />
              </div>

              <TextField
                label="Allowed Endpoint Paths (Optional)"
                value={newPaths}
                onChange={setNewPaths}
                placeholder="/offers/*, /search/v2/search, /free-games"
                description="Separate paths with commas. Path rules are evaluated against the full public path, including /v1. For example /v1/offers/* grants v1 offers but does not extend a legacy /offers/* grant. Use * to match multiple paths. Leave blank to allow all endpoints covered by the selected scopes."
              />

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-epic-border">
                <Button variant="secondary" onPress={close}>
                  Cancel
                </Button>
                <Button type="submit" isPending={creating}>
                  Generate API Key
                </Button>
              </div>
            </Form>
          )}
        </Dialog>
      </Modal>

      {/* One-Time Secret Reveal Modal */}
      <Modal
        isOpen={Boolean(revealedSecret)}
        onOpenChange={(open) => {
          if (!open) setRevealedSecret(null);
        }}
        size="md"
      >
        <Dialog>
          {({ close }) => (
            <div className="space-y-4">
              <Heading
                slot="title"
                className="text-lg font-semibold text-white"
              >
                Save Your API Key
              </Heading>
              <p className="text-xs text-epic-text-muted">
                Copy the key for{" "}
                <strong className="text-epic-text">
                  {revealedSecret?.name}
                </strong>{" "}
                and store it somewhere safe. You won’t be able to view it again.
              </p>

              <div className="p-3.5 rounded-lg bg-epic-bg border border-epic-accent/40 font-mono text-xs text-epic-accent break-all select-all">
                {revealedSecret?.secret}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  variant="secondary"
                  onPress={() => {
                    if (revealedSecret) {
                      void navigator.clipboard.writeText(revealedSecret.secret);
                      setCopiedSecret(true);
                      notify({
                        title: "API key copied to clipboard",
                        tone: "success",
                      });
                      setTimeout(() => setCopiedSecret(false), 2000);
                    }
                  }}
                >
                  {copiedSecret ? (
                    <Check className="w-4 h-4 text-epic-success" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  {copiedSecret ? "Copied" : "Copy Key"}
                </Button>
                <Button variant="primary" onPress={close}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>

      {/* Edit Key Permissions Modal */}
      <Modal
        isOpen={Boolean(editingKey)}
        onOpenChange={(open) => {
          if (!open) setEditingKey(null);
        }}
        size="xl"
      >
        <Dialog>
          {({ close }) => (
            <Form onSubmit={handleSavePermissions}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Heading
                    slot="title"
                    className="text-lg font-semibold text-white"
                  >
                    Edit Key Permissions
                  </Heading>
                  <p className="text-xs font-mono text-epic-text-muted mt-0.5">
                    {editingKey?.keyPrefix}
                  </p>
                </div>
                <Switch isSelected={editActive} onChange={setEditActive}>
                  {editActive ? "Key Enabled" : "Key Paused"}
                </Switch>
              </div>

              <TextField
                label="Key Name"
                isRequired
                value={editName}
                onChange={setEditName}
              />

              <CheckboxGroup
                label="Permission Scopes"
                value={editScopes}
                onChange={setEditScopes}
              >
                {API_SCOPES.map((scope) => (
                  <Checkbox key={scope} value={scope}>
                    <span className="font-mono text-xs">{scope}</span>
                  </Checkbox>
                ))}
              </CheckboxGroup>

              <CheckboxGroup
                label="Allowed HTTP Methods"
                value={editMethods}
                onChange={setEditMethods}
              >
                {HTTP_METHODS.map((m) => (
                  <Checkbox key={m} value={m}>
                    <span className="font-mono text-xs">{m}</span>
                  </Checkbox>
                ))}
              </CheckboxGroup>

              <div className="grid sm:grid-cols-2 gap-4">
                <TextField
                  label="Allowed IP Addresses / CIDR Ranges"
                  multiline
                  value={editIps}
                  onChange={setEditIps}
                  placeholder={"203.0.113.0/24\n198.51.100.42"}
                  description="Enter one IP address or CIDR range per line. Leave blank to allow any IP."
                />
                <TextField
                  label="Allowed Browser Origins"
                  multiline
                  value={editOrigins}
                  onChange={setEditOrigins}
                  placeholder={"https://egdata.app\nhttps://*.myapp.dev"}
                  description="Enter one origin per line, including https://. Wildcard subdomains are supported. Leave blank for no origin restriction."
                />
              </div>

              <TextField
                label="Allowed Endpoint Paths"
                value={editPaths}
                onChange={setEditPaths}
                placeholder="/offers/*, /items/*, /search/v2/search"
                description="Separate paths with commas. Path rules are evaluated against the full public path, including /v1. For example /v1/offers/* grants v1 offers but does not extend a legacy /offers/* grant. Use * to match multiple paths. Leave blank to allow all endpoints covered by the selected scopes."
              />

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-epic-border">
                <Button variant="secondary" onPress={close}>
                  Cancel
                </Button>
                <Button type="submit" isPending={savingEdit}>
                  Save Permissions
                </Button>
              </div>
            </Form>
          )}
        </Dialog>
      </Modal>

      {/* Delete / Revoke Key Modal */}
      <Modal
        isOpen={Boolean(deletingKey)}
        onOpenChange={(open) => {
          if (!open) setDeletingKey(null);
        }}
        size="md"
      >
        <Dialog>
          {({ close }) => (
            <div className="space-y-4">
              <Heading
                slot="title"
                className="text-lg font-semibold text-white"
              >
                Revoke API Key?
              </Heading>
              <p className="text-xs text-epic-text-muted leading-relaxed">
                Are you sure you want to permanently revoke{" "}
                <strong className="text-epic-text">{deletingKey?.name}</strong>{" "}
                (<code className="font-mono">{deletingKey?.keyPrefix}</code>)?{" "}
                Apps using it will lose access once revocation takes effect.
                Update them with a replacement key first. This cannot be undone.
              </p>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button variant="secondary" onPress={close}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  isPending={deleting}
                  onPress={() => {
                    void handleConfirmDelete();
                  }}
                >
                  Revoke Key
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </div>
  );
}
