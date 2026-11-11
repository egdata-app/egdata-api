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
import { Button } from "../components/ui/Button";
import { Tag } from "../components/ui/Controls";
import { notify } from "../components/ui/Toast";
import {
  type AnalyticsDashboardSummary,
  type DashboardApiKey,
  dashboardClient,
} from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/")({
  component: OverviewPage,
});

function OverviewPage() {
  const { selectedProject } = useDashboardAuth();
  const [keys, setKeys] = useState<DashboardApiKey[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsDashboardSummary | null>(
    null,
  );
  const [copiedCurl, setCopiedCurl] = useState(false);

  useEffect(() => {
    if (!selectedProject) return;
    void dashboardClient
      .getKeys(selectedProject.id)
      .then((r) => setKeys(r.keys))
      .catch(() => {});
    void dashboardClient
      .getAnalytics({ hours: 24, projectId: selectedProject.id })
      .then((r) => setAnalytics(r))
      .catch(() => {});
  }, [selectedProject]);

  const activeKeys = keys.filter((k) => k.active);
  const rpmLimit =
    selectedProject?.tier === "enterprise"
      ? 6000
      : selectedProject?.tier === "pro"
        ? 1200
        : 120;

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
            Edge-validated API access with shared Cloudflare CDN caching and
            real-time Analytics Engine telemetry.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Link to="/keys">
            <Button variant="primary">
              <KeyRound className="w-4 h-4" />
              Manage API Keys
            </Button>
          </Link>
          <Link to="/limits">
            <Button variant="secondary">
              <Sparkles className="w-4 h-4 text-epic-accent" />
              Request Higher Limits
            </Button>
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="24h Requests"
          value={(analytics?.totals.requests ?? 0).toLocaleString()}
          sub={`${analytics?.totals.avgLatencyMs ?? 0} ms avg edge latency`}
          icon={<Activity className="w-4 h-4 text-epic-accent" />}
        />
        <StatCard
          label="CDN Cache Hit Ratio"
          value={`${analytics?.totals.cacheHitRate ?? 0}%`}
          sub={`${(analytics?.totals.cacheHits ?? 0).toLocaleString()} edge cache hits`}
          icon={<Zap className="w-4 h-4 text-epic-success" />}
        />
        <StatCard
          label="Active API Keys"
          value={String(activeKeys.length)}
          sub={`Up to ${rpmLimit.toLocaleString()} req/min per key`}
          icon={<KeyRound className="w-4 h-4 text-epic-accent" />}
        />
        <StatCard
          label="Throttled / Blocked (24h)"
          value={(
            (analytics?.totals.rateLimited ?? 0) +
            (analytics?.totals.blockedPolicy ?? 0)
          ).toLocaleString()}
          sub={`${analytics?.totals.rateLimited ?? 0} rate limited · ${analytics?.totals.blockedPolicy ?? 0} policy denied`}
          icon={<ShieldAlert className="w-4 h-4 text-epic-warning" />}
        />
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Quickstart Card */}
        <div className="lg:col-span-3 bg-epic-surface border border-epic-border rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">
                Edge Gateway Quickstart
              </h2>
              <p className="text-xs text-epic-text-muted mt-0.5">
                Pass your key via{" "}
                <code className="font-mono text-epic-accent">X-API-Key</code> so
                Cloudflare validates at the PoP without fragmenting the shared
                cache key.
              </p>
            </div>
            <Tag tone="accent">Zero Cache Fragmentation</Tag>
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
                1. Edge Verification
              </div>
              <div className="text-epic-text-muted">
                SHA-256 key hash verified in PoP memory / KV in &lt;1ms.
              </div>
            </div>
            <div className="p-3 rounded-lg bg-epic-bg/60 border border-epic-border/70">
              <div className="font-semibold text-epic-text mb-0.5">
                2. Policy & Quota
              </div>
              <div className="text-epic-text-muted">
                CIDR IP, Origin, Scope & RPM limits enforced before cache
                lookup.
              </div>
            </div>
            <div className="p-3 rounded-lg bg-epic-bg/60 border border-epic-border/70">
              <div className="font-semibold text-epic-text mb-0.5">
                3. Shared CDN Hit
              </div>
              <div className="text-epic-text-muted">
                Header stripped upstream so all valid keys share Cloudflare
                Cache + ETags.
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
                {rpmLimit.toLocaleString()} RPM
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
              View full analytics
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
