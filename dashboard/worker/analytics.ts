import type { DashboardEnv } from "./types.js";

/**
 * Analytics Engine Schema (`egdata_api_usage`)
 *
 * index1: ownerEpicId (single high-cardinality index for fast per-user queries & sampling)
 *
 * blob1:  keyId (e.g. key_abc123)
 * blob2:  projectId (e.g. prj_abc123)
 * blob3:  routeTemplate (e.g. /offers/{id} from X-Route-Template or normalized pathname)
 * blob4:  method (GET, HEAD, POST, ...)
 * blob5:  statusCode ("200", "304", "401", "403", "429", "500")
 * blob6:  cacheStatus ("HIT", "MISS", "STALE", "REVALIDATED", "BYPASS", "DYNAMIC", "EDGE_BLOCK")
 * blob7:  limitOutcome ("ok", "rate_limited", "ip_denied", "origin_denied", "path_denied", "scope_denied", "method_denied")
 * blob8:  origin (Origin request header or "(direct)")
 * blob9:  clientIp (masked or raw client IP for user diagnostics)
 * blob10: userAgent (truncated to 160 chars)
 * blob11: country (CF country code e.g. "US", "ES")
 *
 * double1: requestCount (1)
 * double2: latencyMs
 * double3: rateLimitedFlag (1 or 0)
 * double4: cacheHitFlag (1 or 0)
 * double5: errorFlag (1 or 0 for 4xx/5xx)
 */

export interface ApiTelemetryEvent {
  ownerEpicId: string;
  keyId: string;
  projectId: string;
  routeTemplate: string;
  method: string;
  statusCode: number;
  cacheStatus: string;
  limitOutcome: string;
  origin: string;
  clientIp: string;
  userAgent: string;
  country: string;
  latencyMs: number;
}

// Keep a lightweight bounded ring buffer in isolate memory so local `vite dev` / demo
// environments without remote Analytics Engine SQL tokens still show live traffic immediately!
const LOCAL_EVENT_BUFFER_MAX = 500;
interface BufferedEvent extends ApiTelemetryEvent {
  timestamp: string;
}
const localEventsBuffer: BufferedEvent[] = [];

export function recordApiTelemetry(
  env: DashboardEnv,
  event: ApiTelemetryEvent,
): void {
  const isCacheHit =
    event.cacheStatus === "HIT" ||
    event.cacheStatus === "STALE" ||
    event.cacheStatus === "UPDATING" ||
    event.statusCode === 304
      ? 1
      : 0;
  const isRateLimited =
    event.limitOutcome === "rate_limited" || event.statusCode === 429 ? 1 : 0;
  const isError = event.statusCode >= 400 ? 1 : 0;

  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [event.ownerEpicId.slice(0, 96)],
      blobs: [
        event.keyId.slice(0, 64),
        event.projectId.slice(0, 64),
        event.routeTemplate.slice(0, 180),
        event.method.slice(0, 16),
        String(event.statusCode),
        event.cacheStatus.slice(0, 32),
        event.limitOutcome.slice(0, 32),
        (event.origin || "(direct)").slice(0, 180),
        (event.clientIp || "unknown").slice(0, 64),
        (event.userAgent || "(none)").slice(0, 160),
        (event.country || "XX").slice(0, 8),
      ],
      doubles: [
        1,
        Math.max(0, event.latencyMs),
        isRateLimited,
        isCacheHit,
        isError,
      ],
    });
  } catch {
    // Analytics Engine binding may no-op in certain test runners; never fail the request
  }

  if (localEventsBuffer.length >= LOCAL_EVENT_BUFFER_MAX) {
    localEventsBuffer.shift();
  }
  localEventsBuffer.push({
    ...event,
    timestamp: new Date().toISOString(),
  });
}

export {
  queryDashboardAnalytics,
  queryUsageTable,
} from "./analytics-reporting.js";
export type { AnalyticsDashboardSummary } from "./analytics-types.js";

export function getLocalTelemetry() {
  return localEventsBuffer.slice();
}
