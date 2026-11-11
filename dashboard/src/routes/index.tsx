import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  Check,
  Copy,
  Gauge,
  KeyRound,
  ShieldAlert,
  Sparkles,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button, buttonStyles } from "../components/ui/Button";
import { Tag } from "../components/ui/Controls";
import { notify } from "../components/ui/Toast";
import { AdminOverview } from "../components/usage/AdminOverview";
import {
  Coverage,
  Freshness,
  ScopeSelector,
  UsageError,
  UsageLoading,
} from "../components/usage/UsageShared";
import { type DashboardApiKey, dashboardClient } from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";
import { useUsage } from "../lib/usage";

export const Route = createFileRoute("/")({
  component: OverviewPage,
});

function OverviewPage() {
  const { analyticsScope } = useDashboardAuth();
  return analyticsScope === "all" ? <AdminOverview /> : <ProjectOverview />;
}

function ProjectOverview() {
  const { selectedProject } = useDashboardAuth();
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const result = useUsage(
    selectedProject ? { hours: 24, projectId: selectedProject.id } : null,
  );
  const analytics = result.data;
  const [copiedCurl, setCopiedCurl] = useState(false);

  useEffect(() => {
    let current = true;
    setKeys([]);
    if (!selectedProject) return;
    const failed = () => {
      if (current)
        notify({
          title: "Could not load overview",
          description: "Reload the page to try again.",
          tone: "danger",
        });
    };
    void dashboardClient
      .getKeys(selectedProject.id)
      .then((r) => {
        if (current) setKeys(r.keys);
      })
      .catch(failed);
    return () => {
      current = false;
    };
  }, [selectedProject]);

  const activeKeys = keys.filter((k) => k.active);
  const rpmLimit =
    selectedProject?.customRpm ??
    (selectedProject?.tier === "enterprise"
      ? 6000
      : selectedProject?.tier === "pro"
        ? 1200
        : 120);

  const sampleCurl = `curl -H "X-API-Key: egk_live_YOUR_API_KEY" \\
  "https://api.egdata.app/offers/top-sellers?country=US"`;

  function copySnippet() {
    void navigator.clipboard.writeText(sampleCurl);
    setCopiedCurl(true);
    notify({ title: "Copied cURL example", tone: "info" });
    setTimeout(() => setCopiedCurl(false), 2000);
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            {selectedProject ? selectedProject.name : "Developer Overview"}
          </h1>
          <p className="text-sm text-epic-text-muted mt-1">
            Manage your API keys and review this project’s usage.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <ScopeSelector />
          <Link to="/keys" className={buttonStyles({ variant: "primary" })}>
            <KeyRound className="w-4 h-4" />
            Manage API Keys
          </Link>
          <Link to="/limits" className={buttonStyles({ variant: "secondary" })}>
            <Sparkles className="w-4 h-4 text-epic-accent" />
            Request Higher Limits
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="flex flex-wrap justify-between items-center gap-3">
        {analytics && <Coverage data={analytics} />}
        <Freshness
          updatedAt={result.updatedAt}
          loading={result.loading}
          onRefresh={result.refresh}
        />
      </div>
      <UsageError
        message={result.error}
        retry={result.refresh}
        stale={Boolean(analytics)}
      />
      {!analytics && result.loading && <UsageLoading />}
      {analytics && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="24h Requests"
            value={(analytics?.totals.requests ?? 0).toLocaleString()}
            sub={`${analytics?.totals.avgLatencyMs ?? 0} ms average processing time`}
            icon={<Activity className="w-4 h-4 text-epic-accent" />}
          />
          <StatCard
            label="Requests Served from Cache"
            value={`${analytics?.totals.cacheHitRate ?? 0}%`}
            sub={`${(analytics?.totals.cacheHits ?? 0).toLocaleString()} cached responses`}
            icon={<Zap className="w-4 h-4 text-epic-success" />}
          />
          <StatCard
            label="Active API Keys"
            value={String(activeKeys.length)}
            sub={`Up to ${rpmLimit.toLocaleString()} req/min per key`}
            icon={<KeyRound className="w-4 h-4 text-epic-accent" />}
          />
          <StatCard
            label="Blocked Requests (24h)"
            value={(
              (analytics?.totals.rateLimited ?? 0) +
              (analytics?.totals.blockedPolicy ?? 0)
            ).toLocaleString()}
            sub={`${analytics?.totals.rateLimited ?? 0} over limit · ${analytics?.totals.blockedPolicy ?? 0} denied by permissions`}
            icon={<ShieldAlert className="w-4 h-4 text-epic-warning" />}
          />
        </div>
      )}

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Quickstart Card */}
        <div className="lg:col-span-3 bg-epic-surface border border-epic-border rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">
                Make your first request
              </h2>
              <p className="text-xs text-epic-text-muted mt-0.5">
                Replace the example key with your own and send it in the{" "}
                <code className="font-mono text-epic-accent">X-API-Key</code>{" "}
                header.
              </p>
            </div>
          </div>

          <div className="relative bg-epic-bg border border-epic-border rounded-lg p-4 font-mono text-xs text-epic-text overflow-x-auto">
            <pre className="leading-relaxed">{sampleCurl}</pre>
            <div className="absolute top-2.5 right-2.5">
              <Button variant="secondary" size="sm" onPress={copySnippet}>
                {copiedCurl ? (
                  <Check className="w-3.5 h-3.5 text-epic-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {copiedCurl ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-3 pt-1 text-xs">
            <div className="p-3 rounded-lg bg-epic-bg/60 border border-epic-border/70">
              <div className="font-semibold text-epic-text mb-0.5">
                1. Create a key
              </div>
              <div className="text-epic-text-muted">
                Give it a name you’ll recognize, such as your app or service.
              </div>
            </div>
            <div className="p-3 rounded-lg bg-epic-bg/60 border border-epic-border/70">
              <div className="font-semibold text-epic-text mb-0.5">
                2. Choose permissions
              </div>
              <div className="text-epic-text-muted">
                Allow the endpoints and request methods your app needs.
              </div>
            </div>
            <div className="p-3 rounded-lg bg-epic-bg/60 border border-epic-border/70">
              <div className="font-semibold text-epic-text mb-0.5">
                3. Send a request
              </div>
              <div className="text-epic-text-muted">
                Try the example above, then check Usage for recorded requests.
              </div>
            </div>
          </div>
        </div>

        {/* Active Keys Summary */}
        <div className="lg:col-span-2 bg-epic-surface border border-epic-border rounded-xl p-6 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                Project Keys
              </h2>
              <span className="text-xs text-epic-text-muted font-mono">
                {rpmLimit.toLocaleString()} requests/min per key
              </span>
            </div>

            {keys.length === 0 ? (
              <div className="py-8 text-center space-y-2 border border-dashed border-epic-border rounded-lg">
                <Gauge className="w-6 h-6 text-epic-text-muted mx-auto" />
                <p className="text-xs text-epic-text-muted">
                  No API keys created in this project yet.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {keys.slice(0, 4).map((k) => (
                  <div
                    key={k.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-epic-bg border border-epic-border"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-epic-text truncate">
                        {k.name}
                      </div>
                      <div className="text-xs font-mono text-epic-text-muted">
                        {k.keyPrefix}
                      </div>
                    </div>
                    <Tag tone={k.active ? "success" : "warning"}>
                      {k.active ? "Active" : "Paused"}
                    </Tag>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-epic-border">
            <Link
              to="/analytics"
              className="text-xs font-medium text-epic-accent hover:text-epic-accent-hover inline-flex items-center gap-1"
            >
              View usage
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <Link
              to="/keys"
              className="text-xs font-medium text-epic-text-muted hover:text-epic-text inline-flex items-center gap-1"
            >
              Configure permissions
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-epic-surface border border-epic-border rounded-xl p-5 space-y-2">
      <div className="flex items-center justify-between text-xs font-medium text-epic-text-muted">
        <span>{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold tracking-tight text-white">
        {value}
      </div>
      <div className="text-xs text-epic-text-muted">{sub}</div>
    </div>
  );
}
