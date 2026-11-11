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

export interface AnalyticsDashboardSummary {
  source: "cloudflare_analytics_engine" | "local_buffer";
  rangeHours: number;
  totals: {
    requests: number;
    cacheHits: number;
    cacheHitRate: number;
    rateLimited: number;
    blockedPolicy: number;
    errors: number;
    avgLatencyMs: number;
  };
  timeseries: Array<{
    bucket: string;
    requests: number;
    cacheHits: number;
    rateLimited: number;
    errors: number;
    avgLatencyMs: number;
  }>;
  endpoints: Array<{
    route: string;
    method: string;
    requests: number;
    cacheHits: number;
    rateLimited: number;
    avgLatencyMs: number;
  }>;
  cacheBreakdown: Array<{
    status: string;
    requests: number;
  }>;
  limitOutcomes: Array<{
    outcome: string;
    requests: number;
  }>;
  origins: Array<{
    origin: string;
    requests: number;
  }>;
  ips: Array<{
    ip: string;
    country: string;
    requests: number;
    rateLimited: number;
  }>;
  userAgents: Array<{
    userAgent: string;
    requests: number;
  }>;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_.:@-]{1,96}$/.test(value)) {
    throw new Error("Unsafe analytics filter identifier");
  }
  return value.replace(/'/g, "");
}

async function runAnalyticsSql<T>(
  accountId: string,
  apiToken: string,
  sql: string,
): Promise<T[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: sql,
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Analytics SQL error (${res.status}): ${body}`);
  }
  const parsed = (await res.json()) as { data?: T[] };
  return parsed.data ?? [];
}

export async function queryDashboardAnalytics(
  env: DashboardEnv,
  params: {
    ownerEpicId: string;
    projectId?: string;
    keyId?: string;
    rangeHours: number;
  },
): Promise<AnalyticsDashboardSummary> {
  const safeHours = Math.min(
    Math.max(Math.floor(params.rangeHours) || 24, 1),
    24 * 30,
  );
  const safeOwner = sanitizeIdentifier(params.ownerEpicId);
  const projectClause = params.projectId
    ? `AND blob2 = '${sanitizeIdentifier(params.projectId)}'`
    : "";
  const keyClause = params.keyId
    ? `AND blob1 = '${sanitizeIdentifier(params.keyId)}'`
    : "";

  const baseWhere = `
    WHERE index1 = '${safeOwner}'
      ${projectClause}
      ${keyClause}
      AND timestamp >= NOW() - INTERVAL '${safeHours}' HOUR
  `;

  if (env.CF_ACCOUNT_ID && env.CF_ANALYTICS_API_TOKEN) {
    const bucketInterval = safeHours <= 48 ? "'1' HOUR" : "'1' DAY";

    const [
      timeseriesRows,
      endpointRows,
      cacheRows,
      outcomeRows,
      originRows,
      ipRows,
      uaRows,
    ] = await Promise.all([
      runAnalyticsSql<{
        bucket: string;
        requests: number;
        cache_hits: number;
        rate_limited: number;
        errors: number;
        avg_latency: number;
      }>(
        env.CF_ACCOUNT_ID,
        env.CF_ANALYTICS_API_TOKEN,
        `SELECT
            toStartOfInterval(timestamp, INTERVAL ${bucketInterval}) AS bucket,
            SUM(_sample_interval * double1) AS requests,
            SUM(_sample_interval * double4) AS cache_hits,
            SUM(_sample_interval * double3) AS rate_limited,
            SUM(_sample_interval * double5) AS errors,
            SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_latency
          FROM egdata_api_usage
          ${baseWhere}
          GROUP BY bucket
          ORDER BY bucket ASC
          FORMAT JSON`,
      ),
      runAnalyticsSql<{
        route: string;
        method: string;
        requests: number;
        cache_hits: number;
        rate_limited: number;
        avg_latency: number;
      }>(
        env.CF_ACCOUNT_ID,
        env.CF_ANALYTICS_API_TOKEN,
        `SELECT
            blob3 AS route,
            blob4 AS method,
            SUM(_sample_interval * double1) AS requests,
            SUM(_sample_interval * double4) AS cache_hits,
            SUM(_sample_interval * double3) AS rate_limited,
            SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_latency
          FROM egdata_api_usage
          ${baseWhere}
          GROUP BY route, method
          ORDER BY requests DESC
          LIMIT 15
          FORMAT JSON`,
      ),
      runAnalyticsSql<{ status: string; requests: number }>(
        env.CF_ACCOUNT_ID,
        env.CF_ANALYTICS_API_TOKEN,
        `SELECT
            blob6 AS status,
            SUM(_sample_interval * double1) AS requests
          FROM egdata_api_usage
          ${baseWhere}
          GROUP BY status
          ORDER BY requests DESC
          LIMIT 10
          FORMAT JSON`,
      ),
      runAnalyticsSql<{ outcome: string; requests: number }>(
        env.CF_ACCOUNT_ID,
        env.CF_ANALYTICS_API_TOKEN,
        `SELECT
            blob7 AS outcome,
            SUM(_sample_interval * double1) AS requests
          FROM egdata_api_usage
          ${baseWhere}
          GROUP BY outcome
          ORDER BY requests DESC
          LIMIT 10
          FORMAT JSON`,
      ),
      runAnalyticsSql<{ origin: string; requests: number }>(
        env.CF_ACCOUNT_ID,
        env.CF_ANALYTICS_API_TOKEN,
        `SELECT
            blob8 AS origin,
            SUM(_sample_interval * double1) AS requests
          FROM egdata_api_usage
          ${baseWhere}
          GROUP BY origin
          ORDER BY requests DESC
          LIMIT 10
          FORMAT JSON`,
      ),
      runAnalyticsSql<{
        ip: string;
        country: string;
        requests: number;
        rate_limited: number;
      }>(
        env.CF_ACCOUNT_ID,
        env.CF_ANALYTICS_API_TOKEN,
        `SELECT
            blob9 AS ip,
            blob11 AS country,
            SUM(_sample_interval * double1) AS requests,
            SUM(_sample_interval * double3) AS rate_limited
          FROM egdata_api_usage
          ${baseWhere}
          GROUP BY ip, country
          ORDER BY requests DESC
          LIMIT 12
          FORMAT JSON`,
      ),
      runAnalyticsSql<{ ua: string; requests: number }>(
        env.CF_ACCOUNT_ID,
        env.CF_ANALYTICS_API_TOKEN,
        `SELECT
            blob10 AS ua,
            SUM(_sample_interval * double1) AS requests
          FROM egdata_api_usage
          ${baseWhere}
          GROUP BY ua
          ORDER BY requests DESC
          LIMIT 12
          FORMAT JSON`,
      ),
    ]);

    const totalRequests = timeseriesRows.reduce(
      (acc, r) => acc + Number(r.requests || 0),
      0,
    );
    const totalCacheHits = timeseriesRows.reduce(
      (acc, r) => acc + Number(r.cache_hits || 0),
      0,
    );
    const totalRateLimited = timeseriesRows.reduce(
      (acc, r) => acc + Number(r.rate_limited || 0),
      0,
    );
    const totalErrors = timeseriesRows.reduce(
      (acc, r) => acc + Number(r.errors || 0),
      0,
    );
    const weightedLatency = timeseriesRows.reduce(
      (acc, r) => acc + Number(r.avg_latency || 0) * Number(r.requests || 0),
      0,
    );
    const blockedPolicy = outcomeRows
      .filter((o) => o.outcome !== "ok" && o.outcome !== "rate_limited")
      .reduce((acc, r) => acc + Number(r.requests || 0), 0);

    return {
      source: "cloudflare_analytics_engine",
      rangeHours: safeHours,
      totals: {
        requests: totalRequests,
        cacheHits: totalCacheHits,
        cacheHitRate:
          totalRequests > 0
            ? Math.round((totalCacheHits / totalRequests) * 1000) / 10
            : 0,
        rateLimited: totalRateLimited,
        blockedPolicy,
        errors: totalErrors,
        avgLatencyMs:
          totalRequests > 0
            ? Math.round((weightedLatency / totalRequests) * 10) / 10
            : 0,
      },
      timeseries: timeseriesRows.map((r) => ({
        bucket: r.bucket,
        requests: Number(r.requests || 0),
        cacheHits: Number(r.cache_hits || 0),
        rateLimited: Number(r.rate_limited || 0),
        errors: Number(r.errors || 0),
        avgLatencyMs: Math.round(Number(r.avg_latency || 0) * 10) / 10,
      })),
      endpoints: endpointRows.map((r) => ({
        route: r.route,
        method: r.method,
        requests: Number(r.requests || 0),
        cacheHits: Number(r.cache_hits || 0),
        rateLimited: Number(r.rate_limited || 0),
        avgLatencyMs: Math.round(Number(r.avg_latency || 0) * 10) / 10,
      })),
      cacheBreakdown: cacheRows.map((r) => ({
        status: r.status,
        requests: Number(r.requests || 0),
      })),
      limitOutcomes: outcomeRows.map((r) => ({
        outcome: r.outcome,
        requests: Number(r.requests || 0),
      })),
      origins: originRows.map((r) => ({
        origin: r.origin,
        requests: Number(r.requests || 0),
      })),
      ips: ipRows.map((r) => ({
        ip: r.ip,
        country: r.country,
        requests: Number(r.requests || 0),
        rateLimited: Number(r.rate_limited || 0),
      })),
      userAgents: uaRows.map((r) => ({
        userAgent: r.ua,
        requests: Number(r.requests || 0),
      })),
    };
  }

  // Local / preview fallback using buffered live proxy events in memory
  return buildLocalBufferedAnalytics(
    params.ownerEpicId,
    safeHours,
    params.projectId,
    params.keyId,
  );
}

function buildLocalBufferedAnalytics(
  ownerEpicId: string,
  rangeHours: number,
  projectId?: string,
  keyId?: string,
): AnalyticsDashboardSummary {
  const cutoff = Date.now() - rangeHours * 3600_000;
  const matching = localEventsBuffer.filter((e) => {
    if (e.ownerEpicId !== ownerEpicId) return false;
    if (projectId && e.projectId !== projectId) return false;
    if (keyId && e.keyId !== keyId) return false;
    return Date.parse(e.timestamp) >= cutoff;
  });

  const bucketMap = new Map<
    string,
    {
      requests: number;
      cacheHits: number;
      rateLimited: number;
      errors: number;
      latencySum: number;
    }
  >();
  const endpointMap = new Map<
    string,
    {
      route: string;
      method: string;
      requests: number;
      cacheHits: number;
      rateLimited: number;
      latencySum: number;
    }
  >();
  const cacheMap = new Map<string, number>();
  const outcomeMap = new Map<string, number>();
  const originMap = new Map<string, number>();
  const ipMap = new Map<
    string,
    { ip: string; country: string; requests: number; rateLimited: number }
  >();
  const uaMap = new Map<string, number>();

  let totalCacheHits = 0;
  let totalRateLimited = 0;
  let totalBlockedPolicy = 0;
  let totalErrors = 0;
  let totalLatency = 0;

  for (const ev of matching) {
    const d = new Date(ev.timestamp);
    d.setMinutes(0, 0, 0);
    const bucketKey = d.toISOString();
    const isHit =
      ev.cacheStatus === "HIT" ||
      ev.cacheStatus === "STALE" ||
      ev.cacheStatus === "UPDATING" ||
      ev.statusCode === 304;
    const isRl = ev.limitOutcome === "rate_limited" || ev.statusCode === 429;
    const isErr = ev.statusCode >= 400;

    if (isHit) totalCacheHits++;
    if (isRl) totalRateLimited++;
    if (ev.limitOutcome !== "ok" && ev.limitOutcome !== "rate_limited")
      totalBlockedPolicy++;
    if (isErr) totalErrors++;
    totalLatency += ev.latencyMs;

    const b = bucketMap.get(bucketKey) ?? {
      requests: 0,
      cacheHits: 0,
      rateLimited: 0,
      errors: 0,
      latencySum: 0,
    };
    b.requests++;
    if (isHit) b.cacheHits++;
    if (isRl) b.rateLimited++;
    if (isErr) b.errors++;
    b.latencySum += ev.latencyMs;
    bucketMap.set(bucketKey, b);

    const epKey = `${ev.method} ${ev.routeTemplate}`;
    const ep = endpointMap.get(epKey) ?? {
      route: ev.routeTemplate,
      method: ev.method,
      requests: 0,
      cacheHits: 0,
      rateLimited: 0,
      latencySum: 0,
    };
    ep.requests++;
    if (isHit) ep.cacheHits++;
    if (isRl) ep.rateLimited++;
    ep.latencySum += ev.latencyMs;
    endpointMap.set(epKey, ep);

    cacheMap.set(ev.cacheStatus, (cacheMap.get(ev.cacheStatus) ?? 0) + 1);
    outcomeMap.set(ev.limitOutcome, (outcomeMap.get(ev.limitOutcome) ?? 0) + 1);
    const orig = ev.origin || "(direct)";
    originMap.set(orig, (originMap.get(orig) ?? 0) + 1);

    const ipEntry = ipMap.get(ev.clientIp) ?? {
      ip: ev.clientIp || "unknown",
      country: ev.country || "XX",
      requests: 0,
      rateLimited: 0,
    };
    ipEntry.requests++;
    if (isRl) ipEntry.rateLimited++;
    ipMap.set(ev.clientIp, ipEntry);

    const ua = ev.userAgent || "(none)";
    uaMap.set(ua, (uaMap.get(ua) ?? 0) + 1);
  }

  const totalRequests = matching.length;

  return {
    source: "local_buffer",
    rangeHours,
    totals: {
      requests: totalRequests,
      cacheHits: totalCacheHits,
      cacheHitRate:
        totalRequests > 0
          ? Math.round((totalCacheHits / totalRequests) * 1000) / 10
          : 0,
      rateLimited: totalRateLimited,
      blockedPolicy: totalBlockedPolicy,
      errors: totalErrors,
      avgLatencyMs:
        totalRequests > 0
          ? Math.round((totalLatency / totalRequests) * 10) / 10
          : 0,
    },
    timeseries: Array.from(bucketMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, v]) => ({
        bucket,
        requests: v.requests,
        cacheHits: v.cacheHits,
        rateLimited: v.rateLimited,
        errors: v.errors,
        avgLatencyMs: Math.round((v.latencySum / v.requests) * 10) / 10,
      })),
    endpoints: Array.from(endpointMap.values())
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 15)
      .map((e) => ({
        route: e.route,
        method: e.method,
        requests: e.requests,
        cacheHits: e.cacheHits,
        rateLimited: e.rateLimited,
        avgLatencyMs: Math.round((e.latencySum / e.requests) * 10) / 10,
      })),
    cacheBreakdown: Array.from(cacheMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([status, requests]) => ({ status, requests })),
    limitOutcomes: Array.from(outcomeMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, requests]) => ({ outcome, requests })),
    origins: Array.from(originMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([origin, requests]) => ({ origin, requests })),
    ips: Array.from(ipMap.values())
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 12),
    userAgents: Array.from(uaMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([userAgent, requests]) => ({ userAgent, requests })),
  };
}
