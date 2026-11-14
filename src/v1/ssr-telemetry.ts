import { getWorkerToken } from "./request-context.js";

export interface SsrTelemetryItem {
  requestId: string;
  keyId: string;
  projectId: string;
  ownerEpicId?: string;
  tier: "enterprise";
  routeTemplate: string;
  operationId: string | null;
  method: string;
  statusCode: number;
  cacheStatus: string;
  limitOutcome: "allowed";
  policyFamily: "ssr";
  errorCode: string;
  country: string;
  latencyMs: number;
  upstreamMs: number;
  responseBytes: number;
  timestamp: number;
}

const MAX_BUFFER_CAPACITY = 2000;
const ringBuffer: SsrTelemetryItem[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushSsrTelemetry().catch((err) => {
      console.warn("[v1 SSR Telemetry] Periodic flush error", err);
    });
  }, 10_000);
  if (typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}

export function recordSsrTelemetryHit(event: SsrTelemetryItem): void {
  if (ringBuffer.length >= MAX_BUFFER_CAPACITY) {
    ringBuffer.shift();
  }
  ringBuffer.push(event);
  ensureFlushTimer();
}

export async function flushSsrTelemetry(): Promise<void> {
  if (ringBuffer.length === 0) return;
  const events = ringBuffer.splice(0, ringBuffer.length);
  const workerToken = getWorkerToken() ?? "";
  const endpoint =
    process.env.DEVS_TELEMETRY_URL ||
    `${process.env.DASHBOARD_ORIGIN || "https://devs.egdata.app"}/_internal/telemetry`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
        "x-egdata-worker-token": workerToken,
      },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      console.warn(
        `[v1 SSR Telemetry] Failed to flush batch: HTTP ${res.status}`,
      );
    }
  } catch (err) {
    console.warn("[v1 SSR Telemetry] Network flush error", err);
  }
}

export function getSsrTelemetryBufferForTesting(): SsrTelemetryItem[] {
  return [...ringBuffer];
}

export function clearSsrTelemetryBufferForTesting(): void {
  ringBuffer.length = 0;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
