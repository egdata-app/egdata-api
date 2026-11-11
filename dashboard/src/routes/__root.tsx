import {
  createRootRoute,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Bell,
  FolderPlus,
  KeyRound,
  LogOut,
  Plus,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { EgdataLogo, EpicGamesIcon } from "../components/icons/BrandIcons";
import { Button } from "../components/ui/Button";
import { Tag } from "../components/ui/Controls";
import { Dialog, Heading, Modal } from "../components/ui/Modal";
import { Select, SelectItem } from "../components/ui/Select";
import { Form, TextField } from "../components/ui/TextField";
import { AppToastRegion, notify } from "../components/ui/Toast";
import { dashboardClient } from "../lib/api";
import { DashboardAuthProvider, useDashboardAuth } from "../lib/auth-context";
import { useUnreadAlerts } from "../lib/alerts";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <DashboardAuthProvider>
      <DashboardShell />
      <AppToastRegion />
    </DashboardAuthProvider>
  );
}

function DashboardShell() {
  const {
    loading,
    authenticated,
    user,
    projects,
    selectedProject,
    setSelectedProjectId,
    devAuthAvailable,
    refreshSession,
    logout,
  } = useDashboardAuth();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDesc, setProjectDesc] = useState("");
  const [projectWebsite, setProjectWebsite] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const unreadAlerts = useUnreadAlerts(
    authenticated ? selectedProject?.id : undefined,
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3 text-epic-text-muted text-sm">
          <div className="w-4 h-4 rounded-full border-2 border-epic-accent border-t-transparent animate-spin" />
          Loading egdata Developer Portal...
        </div>
      </div>
    );
  }

  if (!authenticated || !user) {
    if (currentPath === "/docs" || currentPath.startsWith("/docs/")) {
      return (
        <main className="max-w-7xl mx-auto p-6">
          <a href="/" className="text-epic-accent block mb-6">
            egdata Developers · Sign in to manage projects and alerts
          </a>
          <Outlet />
        </main>
      );
    }
    return <UnauthenticatedLanding devAuthAvailable={devAuthAvailable} />;
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!projectName.trim()) return;
    setCreatingProject(true);
    try {
      const { project } = await dashboardClient.createProject({
        name: projectName.trim(),
        description: projectDesc.trim(),
        websiteUrl: projectWebsite.trim(),
      });
      await refreshSession();
      setSelectedProjectId(project.id);
      setProjectName("");
      setProjectDesc("");
      setProjectWebsite("");
      setNewProjectOpen(false);
      notify({
        title: "Project created",
        description: `${project.name} is ready for API keys.`,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not create project",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setCreatingProject(false);
    }
  }

  const navItems = [
    { to: "/", label: "Overview", icon: Activity },
    { to: "/keys", label: "API Keys", icon: KeyRound },
    { to: "/analytics", label: "Usage", icon: BarChart3 },
    { to: "/limits", label: "Rate Limits", icon: Sparkles },
    { to: "/docs", label: "API Reference", icon: BookOpen },
    {
      to: "/alerts",
      label: `Alerts${unreadAlerts ? ` (${unreadAlerts})` : ""}`,
      icon: Bell,
    },
  ] as const;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Header */}
      <header className="sticky top-0 z-30 bg-epic-bg/85 backdrop-blur-xl border-b border-epic-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-5">
            <Link to="/" className="flex items-center gap-2.5 group outline-0">
              <EgdataLogo className="h-7 w-7 transition-transform group-hover:scale-105" />
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-tight text-epic-text text-base">
                  egdata
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-epic-accent-muted text-epic-accent border border-epic-accent/25">
                  Developers
                </span>
              </div>
            </Link>

            <div className="hidden md:flex items-center gap-2 pl-4 border-l border-epic-border">
              <Select
                aria-label="Active Project"
                selectedKey={selectedProject?.id}
                onSelectionChange={(key) => {
                  if (key) setSelectedProjectId(String(key));
                }}
                items={projects}
                className="w-56"
              >
                {(item) => (
                  <SelectItem id={item.id} textValue={item.name}>
                    {item.name}
                  </SelectItem>
                )}
              </Select>
              <Button
                variant="secondary"
                size="sm"
                aria-label="Create new project"
                onPress={() => setNewProjectOpen(true)}
              >
                <Plus className="w-3.5 h-3.5" />
                New
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {selectedProject && (
              <Tag
                tone={
                  selectedProject.tier === "enterprise"
                    ? "accent"
                    : selectedProject.tier === "pro"
                      ? "success"
                      : "neutral"
                }
              >
                {selectedProject.tier.toUpperCase()} TIER
              </Tag>
            )}

            <a
              href="https://egdata.app"
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1 text-xs text-epic-text-muted hover:text-epic-text transition-colors px-2 py-1"
            >
              egdata.app
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>

            <div className="flex items-center gap-2.5 pl-3 border-l border-epic-border">
              <img
                src={user.avatarUrl}
                alt={user.displayName}
                className="w-7 h-7 rounded-full border border-epic-border object-cover bg-epic-elevated"
              />
              <span className="hidden sm:inline text-sm font-medium text-epic-text max-w-32 truncate">
                {user.displayName}
              </span>
              <Button
                variant="icon"
                aria-label="Sign out"
                onPress={() => {
                  void logout();
                }}
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Navigation Bar */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active =
              item.to === "/"
                ? currentPath === "/"
                : currentPath.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`relative flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap outline-0 focus-visible:text-epic-accent ${
                  active
                    ? "text-epic-text"
                    : "text-epic-text-muted hover:text-epic-text"
                }`}
              >
                <Icon
                  className={`w-4 h-4 ${active ? "text-epic-accent" : ""}`}
                />
                {item.label}
                {active && (
                  <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-epic-accent rounded-t-full" />
                )}
              </Link>
            );
          })}
        </div>
      </header>

      {/* Mobile Project Switcher */}
      <div className="md:hidden px-4 pt-4 flex items-center gap-2">
        <Select
          aria-label="Active Project"
          selectedKey={selectedProject?.id}
          onSelectionChange={(key) => {
            if (key) setSelectedProjectId(String(key));
          }}
          items={projects}
          className="flex-1"
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              {item.name}
            </SelectItem>
          )}
        </Select>
        <Button
          variant="secondary"
          size="md"
          onPress={() => setNewProjectOpen(true)}
        >
          <FolderPlus className="w-4 h-4" />
        </Button>
      </div>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-epic-border/70 py-5 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-epic-text-muted">
          <div className="flex items-center gap-2">
            <EgdataLogo className="w-4 h-4 opacity-75" />
            <span>egdata Developer Portal</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://docs.egdata.app"
              target="_blank"
              rel="noreferrer"
              className="hover:text-epic-text transition-colors"
            >
              API Docs
            </a>
            <a
              href="https://github.com/egdata-app"
              target="_blank"
              rel="noreferrer"
              className="hover:text-epic-text transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>

      {/* Create Project Modal */}
      <Modal isOpen={newProjectOpen} onOpenChange={setNewProjectOpen} size="md">
        <Dialog>
          {({ close }) => (
            <Form onSubmit={handleCreateProject}>
              <div className="flex items-center justify-between">
                <Heading
                  slot="title"
                  className="text-lg font-semibold text-epic-text"
                >
                  Create Project
                </Heading>
              </div>
              <p className="text-xs text-epic-text-muted -mt-2">
                Group API keys, permissions, and usage analytics by application
                or environment.
              </p>

              <TextField
                label="Project Name"
                isRequired
                value={projectName}
                onChange={setProjectName}
                placeholder="e.g. Price Tracker Bot"
              />
              <TextField
                label="Website / Repository URL"
                value={projectWebsite}
                onChange={setProjectWebsite}
                placeholder="https://example.com"
              />
              <TextField
                label="Description"
                multiline
                value={projectDesc}
                onChange={setProjectDesc}
                placeholder="What are you building with egdata?"
              />

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button variant="secondary" onPress={close}>
                  Cancel
                </Button>
                <Button type="submit" isPending={creatingProject}>
                  Create Project
                </Button>
              </div>
            </Form>
          )}
        </Dialog>
      </Modal>
    </div>
  );
}

function UnauthenticatedLanding({
  devAuthAvailable,
}: {
  devAuthAvailable: boolean;
}) {
  const authError =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("auth_error")
      : null;

  return (
    <div className="min-h-screen flex flex-col justify-between px-4 py-10">
      <div className="max-w-5xl mx-auto w-full flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <EgdataLogo className="h-8 w-8" />
          <span className="font-bold text-lg tracking-tight">egdata</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-epic-accent-muted text-epic-accent border border-epic-accent/25">
            Developer Portal
          </span>
        </div>
        <a
          href="https://egdata.app"
          className="text-xs font-medium text-epic-text-muted hover:text-epic-text flex items-center gap-1"
        >
          Back to egdata.app
          <ArrowUpRight className="w-3.5 h-3.5" />
        </a>
      </div>

      <div className="max-w-4xl mx-auto w-full grid md:grid-cols-2 gap-8 items-center my-12">
        <div className="space-y-5">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white leading-tight">
            Build with Epic Games Store data.
          </h1>
          <p className="text-sm text-epic-text-muted leading-relaxed">
            Create API keys for your apps, choose what they can access, and
            track their usage.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <div className="p-3.5 rounded-xl bg-epic-surface border border-epic-border">
              <div className="flex items-center gap-2 text-xs font-semibold text-epic-text mb-1">
                <ShieldCheck className="w-4 h-4 text-epic-accent" />
                Control access
              </div>
              <p className="text-xs text-epic-text-muted">
                Choose which endpoints, IP addresses, and browser origins each
                key can use.
              </p>
            </div>
            <div className="p-3.5 rounded-xl bg-epic-surface border border-epic-border">
              <div className="flex items-center gap-2 text-xs font-semibold text-epic-text mb-1">
                <BarChart3 className="w-4 h-4 text-epic-accent" />
                Understand usage
              </div>
              <p className="text-xs text-epic-text-muted">
                See which endpoints your apps call and when they reach their
                request limits.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-epic-surface border border-epic-border rounded-2xl p-7 shadow-2xl space-y-6">
          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold text-white">
              Sign in to manage your API keys
            </h2>
            <p className="text-xs text-epic-text-muted">
              Use your Epic Games account to continue.
            </p>
          </div>

          {authError && (
            <div className="p-3 rounded-lg bg-epic-danger/15 border border-epic-danger/30 text-xs text-epic-danger">
              We couldn’t sign you in. Please try again.
            </div>
          )}

          <div className="space-y-3">
            <a
              href="/_dashboard/api/auth/epic/login"
              className="w-full h-11 rounded-lg bg-epic-accent hover:bg-epic-accent-hover text-epic-accent-fg font-semibold text-sm flex items-center justify-center gap-2.5 transition shadow-xs"
            >
              <EpicGamesIcon className="w-5 h-5" />
              Continue with Epic Games
            </a>

            {devAuthAvailable && (
              <p className="text-[11px] text-center text-epic-text-muted">
                Local preview: continue with a test account.
              </p>
            )}
          </div>

          <div className="pt-4 border-t border-epic-border space-y-2 text-xs text-epic-text-muted">
            <div className="flex items-center justify-between">
              <span>Free limit per key</span>
              <span className="font-mono text-epic-text">120 requests/min</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Pro limit per key</span>
              <span className="font-mono text-epic-accent">
                1,200 requests/min
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto w-full text-center text-xs text-epic-text-muted">
        egdata is not affiliated with Epic Games, Inc.
      </div>
    </div>
  );
}
