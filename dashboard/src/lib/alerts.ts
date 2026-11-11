import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { MergedRecord } from "../components/EndpointHistory";

export type Inbox = {
  alerts: Array<
    MergedRecord & {
      sequence: number;
      read: boolean;
      matches: Array<{
        operation_id: string;
        key_id: string;
        first_used_at: number;
      }>;
      label: string;
    }
  >;
  unread: number;
  cutoffToken: string;
  trackingStartedAt: string | null;
  trackingEnabled: boolean;
  trackingDegraded: boolean;
  nextBefore: number | null;
};

export function getInbox(
  projectId: string,
  filters: Record<string, string> = {},
) {
  return apiFetch<Inbox>(
    `/alerts/${encodeURIComponent(projectId)}/inbox?${new URLSearchParams(filters)}`,
  );
}

export function notifyAlertsChanged() {
  window.dispatchEvent(new Event("egdata:alerts-changed"));
}

export function useUnreadAlerts(projectId?: string) {
  const [state, setState] = useState<{
    projectId?: string;
    count: number | null;
  }>({ count: null });
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (projectId) {
        void getInbox(projectId, { unread: "true" })
          .then((data) => {
            if (alive) setState({ projectId, count: data.unread });
          })
          .catch(() => {
            if (alive) setState({ projectId, count: null });
          });
      }
    };
    refresh();
    window.addEventListener("egdata:alerts-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("egdata:alerts-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [projectId]);
  return state.projectId === projectId ? state.count : null;
}
