import { createFileRoute } from "@tanstack/react-router";
import { Mail, Send, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LimitRequestReviews } from "../components/LimitRequestReviews";
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
  { id: "pro", label: "Pro (1,200 requests/min)" },
  { id: "enterprise", label: "Enterprise (6,000 requests/min)" },
  { id: "custom", label: "Custom limit" },
];

function RateLimitsPage() {
  const { selectedProject, isAdmin, refreshSession } = useDashboardAuth();
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
  const [historyError, setHistoryError] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryError(false);
    try {
      const res = await dashboardClient.getLimitRequests();
      setHistory(res.requests);
    } catch {
      setHistoryError(true);
      notify({
        title: "Could not load request history",
        description: "Reload the page to try again.",
        tone: "danger",
      });
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    setWebsiteUrl(selectedProject?.websiteUrl ?? "");
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
            ? "The egdata team has been notified."
            : "Your request has been saved. You can check its status here.",
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
          Rate Limits
        </h1>
        <p className="text-sm text-epic-text-muted mt-1">
          Compare exact request limits and ask for more capacity for your
          project. Quotas use fixed, UTC-aligned 60-second windows and are
          shared by all keys and console sessions in a project, across legacy
          and v1 requests. Expensive v1 operations have shared project caps; a
          429 response names the exhausted policy.
        </p>
      </div>

      {/* Tier Cards */}
      {isAdmin && (
        <LimitRequestReviews
          onReviewed={async () => {
            await Promise.all([refreshSession(), loadHistory()]);
          }}
        />
      )}
      {selectedProject?.customRpm != null && (
        <p className="rounded-xl border border-epic-accent/30 bg-epic-surface p-4 text-sm text-epic-text">
          Approved project limit for {selectedProject.name}:{" "}
          <strong>
            {selectedProject.customRpm.toLocaleString()} requests/min shared by
            all keys
          </strong>
          . Existing keys may take up to five minutes to refresh.
        </p>
      )}
      <div className="grid md:grid-cols-3 gap-4">
        <TierCard
          name="Free"
          rpm="120 requests/min per project"
          current={selectedProject?.tier === "free"}
          description="The default limit for new projects."
        />
        <TierCard
          name="Pro"
          rpm="1,200 requests/min per project"
          current={selectedProject?.tier === "pro"}
          description="Request this limit when your project needs more capacity."
        />
        <TierCard
          name="Enterprise"
          rpm="6,000 requests/min per project"
          current={selectedProject?.tier === "enterprise"}
          description="Need a different limit? Choose Custom limit in your request."
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
                  Tell the egdata team what you’re building and how many
                  requests you need.
                </p>
              </div>
            </div>
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
                description="We’ll use this address to follow up on your request."
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
                label="Requested Limit (Requests per Minute)"
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
              placeholder="What does your app do, which endpoints does it use, and why do you need a higher limit?"
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
                Submit Request
              </Button>
            </div>
          </Form>
        </div>

        {/* Previous Requests */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-epic-accent" />
            Request History
          </h2>

          <Table aria-label="Limit request history">
            <TableHeader>
              <Column isRowHeader>Requested Limit</Column>
              <Column>Status</Column>
              <Column>Date</Column>
            </TableHeader>
            <TableBody
              items={history}
              renderEmptyState={() => (
                <div className="py-8 text-xs text-epic-text-muted">
                  {historyError ? (
                    <>
                      <p>Could not load request history.</p>
                      <Button onPress={() => void loadHistory()}>Retry</Button>
                    </>
                  ) : (
                    "You haven’t requested a higher limit yet."
                  )}
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
                      {req.requestedRpm.toLocaleString()} requests/min
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
                    {req.reviewNote && (
                      <p className="mt-2 max-w-64 whitespace-pre-wrap break-words text-xs text-epic-text-muted">
                        {req.reviewNote}
                      </p>
                    )}
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
  description,
  current,
}: {
  name: string;
  rpm: string;
  description: string;
  current?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-5 border space-y-4 ${
        current
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
        {current && <Tag tone="success">Current Tier</Tag>}
      </div>

      <p className="text-xs text-epic-text-muted">{description}</p>
    </div>
  );
}
