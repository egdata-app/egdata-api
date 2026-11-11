import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Mail, Send, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Tag } from "../components/ui/Controls";
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
import { dashboardClient, type LimitIncreaseRequestRecord } from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/limits")({
  component: RateLimitsPage,
});

const TIER_OPTIONS = [
  { id: "pro", label: "Pro Tier (1,200 req/min)" },
  { id: "enterprise", label: "Enterprise Tier (6,000 req/min)" },
  { id: "custom", label: "Custom High-Volume Quota" },
];

function RateLimitsPage() {
  const { selectedProject } = useDashboardAuth();
  const [contactEmail, setContactEmail] = useState("");
  const [requestedTier, setRequestedTier] = useState<
    "pro" | "enterprise" | "custom"
  >("pro");
  const [requestedRpm, setRequestedRpm] = useState("1200");
  const [expectedMonthly, setExpectedMonthly] = useState("1000000");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [useCase, setUseCase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<LimitIncreaseRequestRecord[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await dashboardClient.getLimitRequests();
      setHistory(res.requests);
    } catch {
      // ignore initial error
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    if (selectedProject?.websiteUrl) {
      setWebsiteUrl(selectedProject.websiteUrl);
    }
  }, [loadHistory, selectedProject]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProject) return;

    setSubmitting(true);
    try {
      const res = await dashboardClient.submitLimitRequest({
        projectId: selectedProject.id,
        contactEmail: contactEmail.trim(),
        requestedTier,
        requestedRpm: Number(requestedRpm),
        expectedMonthlyRequests: Number(expectedMonthly),
        websiteUrl: websiteUrl.trim(),
        useCase: useCase.trim(),
      });

      setUseCase("");
      await loadHistory();
      notify({
        title: "Limit increase request submitted",
        description:
          res.emailDelivery.status === "sent"
            ? "Sent via Cloudflare Email Service to the egdata team."
            : "Saved to D1 & queued for administrator review.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Submission failed",
        description: err instanceof Error ? err.message : "Check form fields",
        tone: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Rate Limits & Quota Upgrade
        </h1>
        <p className="text-sm text-epic-text-muted mt-1">
          Compare edge rate-limiting tiers and submit an upgrade request
          directly via Cloudflare Email Service.
        </p>
      </div>

      {/* Tier Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <TierCard
          name="Free"
          rpm="120 req / min"
          current={selectedProject?.tier === "free"}
          features={[
            "Up to 25 scoped API keys per project",
            "IPv4 / IPv6 CIDR & Origin restrictions",
            "Shared Cloudflare Edge Cache & ETag 304s",
            "Real-time Analytics Engine dashboard",
          ]}
        />
        <TierCard
          name="Pro"
          rpm="1,200 req / min"
          highlight
          current={selectedProject?.tier === "pro"}
          features={[
            "10x per-PoP edge burst capacity",
            "GraphQL APQ & Search v2 high-volume access",
            "Priority support & webhook notifications",
            "Zero anti-abuse PoW friction on clean server keys",
          ]}
        />
        <TierCard
          name="Enterprise"
          rpm="6,000+ req / min"
          current={selectedProject?.tier === "enterprise"}
          features={[
            "Custom RPM & dedicated partner quotas",
            "Catalog Hydration (/catalog/hydrate) bulk sync",
            "Custom CORS & multi-environment key policies",
            "Direct maintainer contact channel",
          ]}
        />
      </div>

      <div className="grid lg:grid-cols-5 gap-6 items-start">
        {/* Request Higher Limits Form */}
        <div className="lg:col-span-3 bg-epic-surface border border-epic-border rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Mail className="w-5 h-5 text-epic-accent" />
              <div>
                <h2 className="text-base font-semibold text-white">
                  Request Higher Limits
                </h2>
                <p className="text-xs text-epic-text-muted">
                  Sends a transactional email via Cloudflare Email Service (
                  <code className="font-mono">env.EMAIL.send</code>) with your
                  Epic ID and project details.
                </p>
              </div>
            </div>
            <Tag tone="accent">Cloudflare Email</Tag>
          </div>

          <Form onSubmit={handleSubmit}>
            <div className="grid sm:grid-cols-2 gap-4">
              <TextField
                label="Contact Email"
                type="email"
                isRequired
                value={contactEmail}
                onChange={setContactEmail}
                placeholder="you@domain.com"
                description="Used as Reply-To so we can follow up directly."
              />

              <Select
                label="Requested Tier"
                selectedKey={requestedTier}
                onSelectionChange={(k) => {
                  if (!k) return;
                  const val = String(k) as "pro" | "enterprise" | "custom";
                  setRequestedTier(val);
                  if (val === "pro") setRequestedRpm("1200");
                  if (val === "enterprise") setRequestedRpm("6000");
                }}
                items={TIER_OPTIONS}
              >
                {(item) => (
                  <SelectItem id={item.id} textValue={item.label}>
                    {item.label}
                  </SelectItem>
                )}
              </Select>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <TextField
                label="Target Requests / Minute (RPM)"
                type="number"
                isRequired
                value={requestedRpm}
                onChange={setRequestedRpm}
                placeholder="1200"
              />
              <TextField
                label="Expected Monthly Requests"
                type="number"
                isRequired
                value={expectedMonthly}
                onChange={setExpectedMonthly}
                placeholder="2500000"
              />
            </div>

            <TextField
              label="Project Website / GitHub Repository"
              value={websiteUrl}
              onChange={setWebsiteUrl}
              placeholder="https://github.com/your-org/epic-price-bot"
            />

            <TextField
              label="How are you using the egdata API?"
              multiline
              isRequired
              value={useCase}
              onChange={setUseCase}
              placeholder="Describe the endpoints you call (e.g. /offers/{id}, /search/v2/search), whether you cache responses or send If-None-Match ETags, and why you need higher throughput..."
              description="Minimum 20 characters."
            />

            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-epic-text-muted">
                Active project:{" "}
                <strong className="text-epic-text">
                  {selectedProject?.name}
                </strong>
              </span>
              <Button type="submit" isPending={submitting}>
                <Send className="w-4 h-4" />
                Send Upgrade Request
              </Button>
            </div>
          </Form>
        </div>

        {/* Previous Requests */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-epic-accent" />
            Submitted Upgrade Requests
          </h2>

          <Table aria-label="Submitted Upgrade Requests">
            <TableHeader>
              <Column isRowHeader>Tier & RPM</Column>
              <Column>Status</Column>
              <Column>Date</Column>
            </TableHeader>
            <TableBody
              items={history}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  No upgrade requests submitted yet.
                </div>
              )}
            >
              {(req) => (
                <Row id={req.id}>
                  <Cell>
                    <div className="font-medium text-xs text-epic-text uppercase">
                      {req.requestedTier}
                    </div>
                    <div className="text-[11px] font-mono text-epic-text-muted">
                      {req.requestedRpm.toLocaleString()} RPM
                    </div>
                  </Cell>
                  <Cell>
                    <Tag
                      tone={
                        req.status === "approved"
                          ? "success"
                          : req.status === "declined"
                            ? "danger"
                            : "accent"
                      }
                    >
                      {req.status}
                    </Tag>
                  </Cell>
                  <Cell className="text-xs text-epic-text-muted">
                    {new Date(req.createdAt).toLocaleDateString()}
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function TierCard({
  name,
  rpm,
  features,
  current,
  highlight,
}: {
  name: string;
  rpm: string;
  features: string[];
  current?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-5 border space-y-4 ${
        highlight
          ? "bg-epic-surface border-epic-accent/50 shadow-lg shadow-epic-accent/5"
          : "bg-epic-surface border-epic-border"
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-white">{name}</h3>
          <div className="text-sm font-mono text-epic-accent font-semibold mt-0.5">
            {rpm}
          </div>
        </div>
        {current ? (
          <Tag tone="success">Current Plan</Tag>
        ) : highlight ? (
          <Tag tone="accent">
            <Zap className="w-3 h-3" />
            Popular
          </Tag>
        ) : null}
      </div>

      <ul className="space-y-2 text-xs text-epic-text-muted">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-epic-accent shrink-0 mt-0.5" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
