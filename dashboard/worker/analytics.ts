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
 * blob7:  limitOutcome ("ok", "rate_limited", "monthly_quota_exceeded", "ip_denied", "origin_denied", "path_denied", "scope_denied", "method_denied")
 * blob8:  origin presence only ("(present)" or "(direct)")
 * blob9:  reserved; always empty (never an IP or fingerprint)
 * blob10: coarse client category, never a raw user agent
 * blob11: country (CF country code e.g. "US", "ES")
 * blob12: privacy schema marker ("privacy-v1")
 * blob13: operationId (e.g. "getOffer", optional)
 * blob14: policyFamily (e.g. "offers-list", "search", "heavy", "bulk", "nl-search", "image", "rpm", optional)
 * blob15: errorCode (e.g. "RATE_LIMITED", "HTTP_500", optional)
 *
 * double1: requestCount (1)
 * double2: latencyMs
 * double3: rateLimitedFlag (1 or 0)
 * double4: cacheHitFlag (1 or 0)
 * double5: errorFlag (1 or 0 for 4xx/5xx)
 * double6: upstreamLatencyMs (0 for edge hits/blocks)
 * double7: responseBytes (from Content-Length if known, else 0)
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
  operationId?: string;
  policyFamily?: string;
  errorCode?: string;
  upstreamLatencyMs?: number;
  responseBytes?: number;
}

// Keep a lightweight bounded ring buffer in isolate memory so local `vite dev` / demo
// environments without remote Analytics Engine SQL tokens still show live traffic immediately!
const LOCAL_EVENT_BUFFER_MAX = 500;
interface BufferedEvent extends ApiTelemetryEvent {
  timestamp: string;
}
const localEventsBuffer: BufferedEvent[] = [];

export function clientCategory(userAgent: string): string {
  if (!userAgent) return "unknown";
  if (/bot|crawler|spider/i.test(userAgent)) return "bot";
  if (/curl|wget|python|node|httpclient|axios|undici|sdk/i.test(userAgent))
    return "application";
  if (/mozilla|chrome|safari|firefox|edge/i.test(userAgent)) return "browser";
  return "other";
}

export function recordApiTelemetry(
  env: DashboardEnv,
  event: ApiTelemetryEvent,
  timestamp?: string,
): void {
  // Minimize before either storage sink. Do not substitute stable hashes for IPs.
  const normalized: ApiTelemetryEvent = {
    ...event,
    origin:
      event.origin && event.origin !== "(direct)" ? "(present)" : "(direct)",
    clientIp: "",
    userAgent: clientCategory(event.userAgent),
    country: /^[A-Z]{2}$/.test(event.country) ? event.country : "XX",
    operationId: (event.operationId ?? "").slice(0, 80),
    policyFamily: (event.policyFamily ?? "").slice(0, 40),
    errorCode: (event.errorCode ?? "").slice(0, 64),
    upstreamLatencyMs: Math.max(0, event.upstreamLatencyMs ?? 0),
    responseBytes: Math.max(0, event.responseBytes ?? 0),
  };
  const isCacheHit =
    normalized.cacheStatus === "HIT" ||
    normalized.cacheStatus === "STALE" ||
    normalized.cacheStatus === "UPDATING" ||
    normalized.cacheStatus === "REVALIDATED" ||
    normalized.statusCode === 304
      ? 1
      : 0;
  const isRateLimited =
    normalized.limitOutcome === "rate_limited" ||
    normalized.limitOutcome === "monthly_quota_exceeded" ||
    normalized.limitOutcome === "period_quota_exceeded" ||
    normalized.limitOutcome === "expensive_budget_exceeded" ||
    normalized.statusCode === 429
      ? 1
      : 0;
  const isError = normalized.statusCode >= 400 ? 1 : 0;

  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [normalized.ownerEpicId.slice(0, 96)],
      blobs: [
        normalized.keyId.slice(0, 64),
        normalized.projectId.slice(0, 64),
        normalized.routeTemplate.slice(0, 180),
        normalized.method.slice(0, 16),
        String(normalized.statusCode),
        normalized.cacheStatus.slice(0, 32),
        normalized.limitOutcome.slice(0, 32),
        (normalized.origin || "(direct)").slice(0, 180),
        "",
        normalized.userAgent,
        (normalized.country || "XX").slice(0, 8),
        "privacy-v1",
        normalized.operationId ?? "",
        normalized.policyFamily ?? "",
        normalized.errorCode ?? "",
      ],
      doubles: [
        1,
        Math.max(0, normalized.latencyMs),
        isRateLimited,
        isCacheHit,
        isError,
        normalized.upstreamLatencyMs ?? 0,
        normalized.responseBytes ?? 0,
      ],
    });
  } catch {
    // Analytics Engine binding may no-op in certain test runners; never fail the request
  }

  if (localEventsBuffer.length >= LOCAL_EVENT_BUFFER_MAX) {
    localEventsBuffer.shift();
  }
  localEventsBuffer.push({
    ...normalized,
    timestamp: timestamp ?? new Date().toISOString(),
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
