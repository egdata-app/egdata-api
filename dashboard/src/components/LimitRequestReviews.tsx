import { useCallback, useEffect, useRef, useState } from "react";
import { dashboardClient, type LimitIncreaseRequestRecord } from "../lib/api";
import { Button } from "./ui/Button";
import { Tag } from "./ui/Controls";
import { Select, SelectItem } from "./ui/Select";
import { Form, TextField } from "./ui/TextField";
import { notify } from "./ui/Toast";

const statuses = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "declined", label: "Declined" },
];

export function LimitRequestReviews({
  onReviewed,
}: {
  onReviewed: () => Promise<void>;
}) {
  const [status, setStatus] =
    useState<LimitIncreaseRequestRecord["status"]>("pending");
  const [offset, setOffset] = useState(0);
  const [requests, setRequests] = useState<LimitIncreaseRequestRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await dashboardClient.getAdminLimitRequests(
        status,
        offset,
      );
      if (current !== generation.current) return;
      setRequests(result.requests);
      setHasMore(result.hasMore);
    } catch (err) {
      if (current !== generation.current) return;
      setError(err instanceof Error ? err.message : "Could not load requests.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [status, offset]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  return (
    <section className="space-y-4" aria-labelledby="limit-reviews-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id="limit-reviews-title"
            className="text-lg font-semibold text-white"
          >
            Review limit requests
          </h2>
          <p className="text-sm text-epic-text-muted">
            Admin access · Requests from all projects, oldest first.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <Select
            label="Request status"
            selectedKey={status}
            items={statuses}
            onSelectionChange={(key) => {
              if (
                key === "pending" ||
                key === "approved" ||
                key === "declined"
              ) {
                setStatus(key);
                setOffset(0);
              }
            }}
          >
            {(item) => (
              <SelectItem id={item.id} textValue={item.label}>
                {item.label}
              </SelectItem>
            )}
          </Select>
          <Button
            variant="secondary"
            isDisabled={loading}
            onPress={() => void load()}
          >
            Refresh
          </Button>
        </div>
      </div>
      <div aria-live="polite">
        {loading ? (
          <p className="text-sm text-epic-text-muted">Loading requests…</p>
        ) : error ? (
          <div role="alert" className="space-y-2 text-sm text-epic-danger">
            <p>{error}</p>
            <Button variant="secondary" onPress={() => void load()}>
              Retry
            </Button>
          </div>
        ) : requests.length === 0 ? (
          <p className="rounded-xl border border-epic-border p-6 text-sm text-epic-text-muted">
            No {status} requests.
          </p>
        ) : (
          <div className="space-y-4">
            {requests.map((request) => (
              <ReviewCard
                key={request.id}
                request={request}
                onReviewed={async () => {
                  await Promise.all([load(), onReviewed()]);
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-epic-text-muted">
          Page {offset / 25 + 1}
        </span>
        <Button
          variant="secondary"
          isDisabled={loading || offset === 0}
          onPress={() => setOffset((value) => value - 25)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          isDisabled={loading || Boolean(error) || !hasMore}
          onPress={() => setOffset((value) => value + 25)}
        >
          Next
        </Button>
      </div>
    </section>
  );
}

function ReviewCard({
  request,
  onReviewed,
}: {
  request: LimitIncreaseRequestRecord;
  onReviewed: () => Promise<void>;
}) {
  const [decision, setDecision] = useState<"approved" | "declined" | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!decision || saving) return;
    setSaving(true);
    setError("");
    try {
      await dashboardClient.reviewLimitRequest(request.id, decision, note);
      notify({
        title:
          decision === "approved" ? "Request approved" : "Request declined",
        description:
          decision === "approved"
            ? "Limits updated. Existing keys may take up to five minutes to refresh."
            : "The decision is now visible in the requester's history.",
        tone: "success",
      });
      await onReviewed();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the decision.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="rounded-xl border border-epic-border bg-epic-surface p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">{request.projectName}</h3>
          <p className="break-all text-sm text-epic-text-muted">
            {request.ownerDisplayName} · {request.contactEmail}
          </p>
          <p className="text-xs text-epic-text-muted">
            {new Date(request.createdAt).toLocaleString()}
          </p>
        </div>
        <Tag
          tone={
            request.status === "approved"
              ? "success"
              : request.status === "declined"
                ? "danger"
                : "accent"
          }
        >
          {request.status}
        </Tag>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3 text-sm">
        <div>
          <dt className="text-epic-text-muted">Requested limit</dt>
          <dd className="font-semibold text-epic-accent">
            {request.requestedRpm.toLocaleString()} requests/min per project
          </dd>
        </div>
        <div>
          <dt className="text-epic-text-muted">Requested tier</dt>
          <dd className="capitalize">{request.requestedTier}</dd>
        </div>
        <div>
          <dt className="text-epic-text-muted">Monthly estimate</dt>
          <dd>{request.expectedMonthlyRequests.toLocaleString()} requests</dd>
        </div>
      </dl>
      {request.websiteUrl && (
        <p className="text-sm break-all">
          <span className="text-epic-text-muted">Website / repository: </span>
          {request.websiteUrl}
        </p>
      )}
      <p className="whitespace-pre-wrap break-words text-sm text-epic-text">
        {request.useCase}
      </p>
      <p className="text-xs text-epic-text-muted">
        Notification:{" "}
        {request.emailDeliveryStatus === "sent"
          ? "Sent"
          : "Saved without email delivery"}
      </p>
      {request.status === "pending" ? (
        decision ? (
          <Form onSubmit={submit}>
            <p className="text-sm">
              {decision === "approved"
                ? `Approve ${request.requestedRpm.toLocaleString()} requests/min for this project's existing and future keys?`
                : "Decline this request? The project's limits will stay the same."}
            </p>
            {decision === "approved" && (
              <p className="text-xs text-epic-text-muted">
                Custom RPM applies to v1 and the API console. Legacy requests
                use the approved tier. Expensive-operation caps remain in place.
              </p>
            )}
            <TextField
              label="Review note (optional)"
              description="Visible to the requester. Maximum 2,000 characters."
              multiline
              value={note}
              onChange={setNote}
              maxLength={2000}
            />
            {error && (
              <p role="alert" className="text-sm text-epic-danger">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant={decision === "declined" ? "destructive" : "primary"}
                isPending={saving}
                isDisabled={saving}
              >
                Confirm {decision === "approved" ? "approval" : "decline"}
              </Button>
              <Button
                variant="secondary"
                isDisabled={saving}
                onPress={() => {
                  setDecision(null);
                  setError("");
                }}
              >
                Cancel
              </Button>
            </div>
          </Form>
        ) : (
          <div className="flex gap-2">
            <Button onPress={() => setDecision("approved")}>
              Approve request
            </Button>
            <Button
              variant="destructive"
              onPress={() => setDecision("declined")}
            >
              Decline
            </Button>
          </div>
        )
      ) : (
        <div className="border-t border-epic-border pt-3 text-xs text-epic-text-muted">
          <p>
            Reviewed{" "}
            {request.reviewedAt
              ? new Date(request.reviewedAt).toLocaleString()
              : "previously"}
            {request.reviewedBy ? ` · ${request.reviewedBy}` : ""}
          </p>
          {request.reviewNote && (
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-epic-text">
              {request.reviewNote}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
