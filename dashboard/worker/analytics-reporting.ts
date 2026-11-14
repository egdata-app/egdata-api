import type { AdminUsage } from "./admin-types.js";
import { type ApiTelemetryEvent, getLocalTelemetry } from "./analytics.js";
import type {
  AnalyticsDashboardSummary,
  UsageDimension,
  UsageFilters,
  UsageMetrics,
  UsageRow,
  UsageSort,
  UsageTableFilters,
  UsageTableResult,
} from "./analytics-types.js";
import { UNATTRIBUTED_LEGACY_ID } from "./analytics-types.js";
import type { DashboardEnv } from "./types.js";
import { generatedV1Routes } from "./v1-routes.generated.js";

/** Only a route that has checked the DB admin role may supply a null owner. */
export type AnalyticsAccess = { ownerEpicId: string | null };
type Params = UsageTableFilters & AnalyticsAccess;
type Event = ApiTelemetryEvent & { timestamp: string };
type SqlRow = Record<string, string | number | null>;
const dimensions = {
  endpoints: ["blob3", "blob4"],
  projects: ["blob2"],
  keys: ["blob1", "blob2"],
  // Also redact historical rows in SQL, before grouping/search/pagination.
  origins: ["if(blob8 = '(direct)' OR blob8 = '', '(direct)', '(present)')"],
  ips: ["blob11"],
  userAgents: ["if(blob12 = 'privacy-v1', blob10, 'legacy (redacted)')"],
  statusCodes: ["blob5"],
  limitOutcomes: ["blob7"],
  cacheStatuses: ["blob6"],
  policies: ["if(blob14 = '', '(none)', blob14)"],
} satisfies Record<UsageDimension, string[]>;
const unattributedLabel = "Unattributed legacy traffic";
const unattributedDetail = "No verified API key or project";

const v1RouteMetaByKey = new Map<
  string,
  { operationId: string; scope: string; expensive?: string }
>();
for (const route of generatedV1Routes) {
  for (const method of route.methods) {
    v1RouteMetaByKey.set(`${method}:${route.path}`, {
      operationId: route.operationId,
      scope: route.scope,
      expensive: route.expensive,
    });
    if (method === "GET") {
      v1RouteMetaByKey.set(`HEAD:${route.path}`, {
        operationId: route.operationId,
        scope: route.scope,
        expensive: route.expensive,
      });
    }
  }
}

// Escape both string delimiters and backslashes before interpolating SQL text.
function literal(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
function windowFor(p: UsageFilters) {
  const endMs = Math.floor(new Date(p.end ?? Date.now()).getTime() / 1000) * 1000;
  const end = new Date(endMs).toISOString();
  const startMs = p.start
    ? Math.floor(new Date(p.start).getTime() / 1000) * 1000
    : endMs - p.hours * 3600_000;
  const start = new Date(startMs).toISOString();
  const hours = Math.max(1, Math.round(((endMs - startMs) / 3600_000) * 100) / 100);
  return {
    end,
    start,
    hours,
    spanMs: Math.max(60_000, endMs - startMs),
  };
}
function where(p: Params) {
  const { start, end } = windowFor(p);
  const parts = [
    `timestamp >= toDateTime('${start.slice(0, 19).replace("T", " ")}')`,
    `timestamp < toDateTime('${end.slice(0, 19).replace("T", " ")}')`,
  ];
  if (p.ownerEpicId !== null) parts.push(`index1 = ${literal(p.ownerEpicId)}`);
  const isV1 = "(blob3 = '/v1' OR startsWith(blob3, '/v1/'))";
  if (p.apiVersion === "v1") parts.push(isV1);
  if (p.apiVersion === "legacy") parts.push(`NOT ${isV1}`);
  if (p.projectId) parts.push(`blob2 = ${literal(p.projectId)}`);
  if (p.keyId) parts.push(`blob1 = ${literal(p.keyId)}`);
  if (p.route) parts.push(`blob3 = ${literal(p.route)}`);
  if (p.method) parts.push(`blob4 = ${literal(p.method)}`);
  if (p.statusClass && p.statusClass !== "all") {
    parts.push(`startsWith(blob5, ${literal(p.statusClass[0])})`);
  }
  if (p.statusCode) parts.push(`blob5 = ${literal(p.statusCode)}`);
  if (p.limitOutcome) parts.push(`blob7 = ${literal(p.limitOutcome)}`);
  if (p.cacheStatus) parts.push(`blob6 = ${literal(p.cacheStatus)}`);
  if (p.country) parts.push(`blob11 = ${literal(p.country)}`);
  if (p.clientCategory) {
    parts.push(
      `if(blob12 = 'privacy-v1', blob10, 'legacy (redacted)') = ${literal(p.clientCategory)}`,
    );
  }
  if (p.originPresence === "present") {
    parts.push("blob8 != '(direct)' AND blob8 != ''");
  } else if (p.originPresence === "direct") {
    parts.push("(blob8 = '(direct)' OR blob8 = '')");
  }
  if (p.policyFamily) {
    parts.push(
      p.policyFamily === "(none)"
        ? "blob14 = ''"
        : `blob14 = ${literal(p.policyFamily)}`,
    );
  }
  if (p.excludeConsole) parts.push("NOT startsWith(blob1, 'console_')");
  return `WHERE ${parts.join(" AND ")}`;
}
const metricSql = `SUM(_sample_interval * double1) AS requests,
  SUM(_sample_interval * double4) AS cacheHits,
  SUM(_sample_interval * (double1 - double4)) AS cacheMisses,
  SUM(_sample_interval * double3) AS rateLimited,
  SUM(_sample_interval * if(blob7 != 'ok' AND blob7 != 'rate_limited' AND blob7 != 'monthly_quota_exceeded' AND blob7 != 'period_quota_exceeded' AND blob7 != 'expensive_budget_exceeded', 1, 0)) AS blockedPolicy,
  SUM(_sample_interval * double5) AS errors,
  SUM(_sample_interval * if(startsWith(blob5, '2'), double1, 0)) AS status2xx,
  SUM(_sample_interval * if(startsWith(blob5, '3'), double1, 0)) AS status3xx,
  SUM(_sample_interval * if(startsWith(blob5, '4'), double1, 0)) AS status4xx,
  SUM(_sample_interval * if(startsWith(blob5, '5'), double1, 0)) AS status5xx,
  100 * SUM(_sample_interval * double4) / SUM(_sample_interval * double1) AS cacheHitRate,
  100 * SUM(_sample_interval * double5) / SUM(_sample_interval * double1) AS errorRate,
  SUM(_sample_interval * double2) / SUM(_sample_interval) AS avgLatencyMs,
  SUM(_sample_interval * if(double4 = 1, double2, 0)) / SUM(_sample_interval * if(double4 = 1, double1, 0)) AS avgHitLatencyMs,
  SUM(_sample_interval * if(double4 = 0 AND blob6 != 'EDGE_BLOCK', double2, 0)) / SUM(_sample_interval * if(double4 = 0 AND blob6 != 'EDGE_BLOCK', double1, 0)) AS avgMissLatencyMs,
  SUM(_sample_interval * double6) / SUM(_sample_interval * double1) AS avgUpstreamLatencyMs,
  SUM(_sample_interval * double7) / SUM(_sample_interval * double1) AS avgResponseBytes,
  quantileExactWeighted(0.5)(double2, _sample_interval) AS p50LatencyMs,
  quantileExactWeighted(0.95)(double2, _sample_interval) AS p95LatencyMs,
  quantileExactWeighted(0.99)(double2, _sample_interval) AS p99LatencyMs`;

function metrics(row: SqlRow = {}): UsageMetrics {
  const n = (key: string) =>
    Number.isFinite(Number(row[key]))
      ? Math.round(Number(row[key]) * 10) / 10
      : 0;
  return {
    requests: n("requests"),
    cacheHits: n("cacheHits"),
    cacheMisses: n("cacheMisses"),
    cacheHitRate: n("cacheHitRate"),
    rateLimited: n("rateLimited"),
    blockedPolicy: n("blockedPolicy"),
    errors: n("errors"),
    errorRate: n("errorRate"),
    status2xx: n("status2xx"),
    status3xx: n("status3xx"),
    status4xx: n("status4xx"),
    status5xx: n("status5xx"),
    avgLatencyMs: n("avgLatencyMs"),
    avgHitLatencyMs: n("avgHitLatencyMs"),
    avgMissLatencyMs: n("avgMissLatencyMs"),
    avgUpstreamLatencyMs: n("avgUpstreamLatencyMs"),
    avgResponseBytes: n("avgResponseBytes"),
    p50LatencyMs: n("p50LatencyMs"),
    p95LatencyMs: n("p95LatencyMs"),
    p99LatencyMs: n("p99LatencyMs"),
  };
}

async function sql(env: DashboardEnv, query: string): Promise<SqlRow[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_API_TOKEN)
    throw new Error("Usage history is not configured.");
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}` },
      body: query,
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok)
    throw new Error(
      `Usage history is unavailable (${res.status}). Please retry.`,
    );
  const result = (await res.json()) as { data?: SqlRow[] };
  if (!Array.isArray(result.data))
    throw new Error("Usage history returned an invalid response.");
  return result.data;
}
function remote(env: DashboardEnv) {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_API_TOKEN);
}
function source(env: DashboardEnv): UsageTableResult["source"] {
  return remote(env) ? "cloudflare_analytics_engine" : "local_buffer";
}

function matchesFilter(e: Event, p: Params): boolean {
  const { start, end } = windowFor(p);
  if (e.timestamp < start || e.timestamp >= end) return false;
  if (p.ownerEpicId !== null && e.ownerEpicId !== p.ownerEpicId) return false;
  if (p.apiVersion && p.apiVersion !== "all") {
    const version =
      e.routeTemplate === "/v1" || e.routeTemplate.startsWith("/v1/")
        ? "v1"
        : "legacy";
    if (version !== p.apiVersion) return false;
  }
  if (p.projectId && e.projectId !== p.projectId) return false;
  if (p.keyId && e.keyId !== p.keyId) return false;
  if (p.route && e.routeTemplate !== p.route) return false;
  if (p.method && e.method !== p.method) return false;
  if (p.statusClass && p.statusClass !== "all") {
    const expected = Number(p.statusClass[0]);
    if (Math.floor(e.statusCode / 100) !== expected) return false;
  }
  if (p.statusCode && String(e.statusCode) !== p.statusCode) return false;
  if (p.limitOutcome && e.limitOutcome !== p.limitOutcome) return false;
  if (p.cacheStatus && e.cacheStatus !== p.cacheStatus) return false;
  if (p.country && e.country !== p.country) return false;
  if (p.clientCategory && (e.userAgent || "unknown") !== p.clientCategory)
    return false;
  if (p.originPresence === "present" && (e.origin === "(direct)" || !e.origin))
    return false;
  if (p.originPresence === "direct" && e.origin && e.origin !== "(direct)")
    return false;
  if (p.policyFamily) {
    const policy = e.policyFamily || "(none)";
    if (policy !== p.policyFamily) return false;
  }
  if (p.excludeConsole && e.keyId.startsWith("console_")) return false;
  return true;
}

function eventsFor(p: Params): Event[] {
  return getLocalTelemetry().filter((e) => matchesFilter(e, p));
}
function isCacheHitEvent(e: Event) {
  return (
    ["HIT", "STALE", "UPDATING", "REVALIDATED"].includes(e.cacheStatus) ||
    e.statusCode === 304
  );
}
function isRateLimitedEvent(e: Event) {
  return (
    e.statusCode === 429 ||
    e.limitOutcome === "rate_limited" ||
    e.limitOutcome === "monthly_quota_exceeded" ||
    e.limitOutcome === "period_quota_exceeded" ||
    e.limitOutcome === "expensive_budget_exceeded"
  );
}
function aggregate(events: Event[]): UsageMetrics {
  const requests = events.length;
  const latencies = events
    .map((e) => Math.max(0, e.latencyMs))
    .sort((a, b) => a - b);
  const quantile = (q: number) =>
    latencies[Math.min(requests - 1, Math.floor(q * requests))] ?? 0;
  const hitEvents = events.filter(isCacheHitEvent);
  const missEvents = events.filter(
    (e) => !isCacheHitEvent(e) && e.cacheStatus !== "EDGE_BLOCK",
  );
  const cacheHits = hitEvents.length;
  const cacheMisses = requests - cacheHits;
  const errors = events.filter((e) => e.statusCode >= 400).length;
  const status2xx = events.filter(
    (e) => e.statusCode >= 200 && e.statusCode < 300,
  ).length;
  const status3xx = events.filter(
    (e) => e.statusCode >= 300 && e.statusCode < 400,
  ).length;
  const status4xx = events.filter(
    (e) => e.statusCode >= 400 && e.statusCode < 500,
  ).length;
  const status5xx = events.filter((e) => e.statusCode >= 500).length;
  const avg = (list: number[]) =>
    list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
  return metrics({
    requests,
    cacheHits,
    cacheMisses,
    cacheHitRate: requests ? (cacheHits / requests) * 100 : 0,
    rateLimited: events.filter(isRateLimitedEvent).length,
    blockedPolicy: events.filter(
      (e) =>
        ![
          "ok",
          "rate_limited",
          "monthly_quota_exceeded",
          "period_quota_exceeded",
          "expensive_budget_exceeded",
        ].includes(e.limitOutcome),
    ).length,
    errors,
    errorRate: requests ? (errors / requests) * 100 : 0,
    status2xx,
    status3xx,
    status4xx,
    status5xx,
    avgLatencyMs: avg(latencies),
    avgHitLatencyMs: avg(hitEvents.map((e) => Math.max(0, e.latencyMs))),
    avgMissLatencyMs: avg(missEvents.map((e) => Math.max(0, e.latencyMs))),
    avgUpstreamLatencyMs: avg(
      events.map((e) => Math.max(0, e.upstreamLatencyMs ?? 0)),
    ),
    avgResponseBytes: avg(
      events.map((e) => Math.max(0, e.responseBytes ?? 0)),
    ),
    p50LatencyMs: quantile(0.5),
    p95LatencyMs: quantile(0.95),
    p99LatencyMs: quantile(0.99),
  });
}
function groups<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = map.get(k) ?? [];
    group.push(item);
    map.set(k, group);
  }
  return map;
}

/** Call only after verifying the database admin role. One query per list page. */
export async function getAdminUsage(
  env: DashboardEnv,
  dimension: "users" | "projects",
  ids: string[],
): Promise<AdminUsage> {
  const params = { hours: 24, ownerEpicId: null };
  const window = windowFor(params);
  const byId: AdminUsage["byId"] = Object.fromEntries(
    ids.map((id) => [id, metrics()]),
  );
  if (!ids.length) return { byId, source: source(env), ...window };
  try {
    if (remote(env)) {
      const column = dimension === "users" ? "index1" : "blob2";
      const rows = await sql(
        env,
        `SELECT ${column} AS id, ${metricSql}
        FROM egdata_api_usage ${where({ ...params, end: window.end })}
        AND ${column} IN (${ids.map(literal).join(",")}) GROUP BY ${column} FORMAT JSON`,
      );
      for (const row of rows) {
        if (typeof row.id === "string" && ids.includes(row.id))
          byId[row.id] = metrics(row);
      }
    } else {
      const grouped = groups(
        eventsFor({ ...params, end: window.end }),
        (event) =>
          dimension === "users" ? event.ownerEpicId : event.projectId,
      );
      for (const id of ids) byId[id] = aggregate(grouped.get(id) ?? []);
    }
    return { byId, source: source(env), ...window };
  } catch (error) {
    console.error("Admin usage unavailable", { error });
    return { byId: {}, source: "unavailable", ...window };
  }
}
function eventDimensions(e: Event, dimension: UsageDimension): string[] {
  switch (dimension) {
    case "endpoints":
      return [e.routeTemplate, e.method];
    case "projects":
      return [e.projectId];
    case "keys":
      return [e.keyId, e.projectId];
    case "origins":
      return [e.origin || "(direct)"];
    case "ips":
      return [e.country || "XX", "Country only"];
    case "userAgents":
      return [e.userAgent || "(none)"];
    case "statusCodes":
      return [String(e.statusCode)];
    case "limitOutcomes":
      return [e.limitOutcome || "ok"];
    case "cacheStatuses":
      return [e.cacheStatus || "DYNAMIC"];
    case "policies":
      return [e.policyFamily || "(none)"];
  }
}
function statusDetail(status: string): string {
  const code = Number(status);
  if (code >= 500) return "Server / upstream error";
  if (code === 429) return "Rate or quota limit";
  if (code >= 400) return "Client or access error";
  if (code >= 300) return "Redirect / not modified";
  if (code >= 200) return "Success";
  return "HTTP status";
}
function usageRow(
  values: string[],
  dimension: UsageDimension,
  m: UsageMetrics,
): UsageRow {
  const [label, detail = ""] = values;
  const resolvedDetail =
    dimension === "statusCodes"
      ? statusDetail(label)
      : dimension === "policies"
        ? label === "(none)"
          ? "Standard route"
          : "Policy / budget family"
        : detail;
  return {
    ...m,
    id: JSON.stringify(values),
    label,
    detail: resolvedDetail,
    ...(dimension === "endpoints" ? { route: label, method: detail } : {}),
    ...(dimension === "projects" ? { projectId: label } : {}),
    ...(dimension === "keys" ? { keyId: label, projectId: detail } : {}),
  };
}

async function enrich(
  env: DashboardEnv,
  rows: UsageRow[],
  dimension: UsageDimension,
  owner: string | null,
) {
  if (!rows.length) return rows;
  if (dimension === "endpoints") {
    return rows.map((row) => {
      const meta = row.route
        ? v1RouteMetaByKey.get(`${row.method ?? "GET"}:${row.route}`)
        : undefined;
      return meta
        ? {
            ...row,
            operationId: meta.operationId,
            scope: meta.scope,
            ...(meta.expensive ? { expensive: meta.expensive } : {}),
          }
        : row;
    });
  }
  if (!["projects", "keys"].includes(dimension)) return rows;
  // Per-page prepared lookups avoid disclosing key hashes, prefixes, or credentials.
  const results = await env.DB.batch(
    rows.map((row) => {
      const query =
        dimension === "projects"
          ? "SELECT name, owner_epic_id AS owner FROM projects WHERE id=?"
          : "SELECT k.name, p.name AS project, k.owner_epic_id AS owner FROM api_keys k LEFT JOIN projects p ON p.id=k.project_id WHERE k.id=?";
      return env.DB.prepare(query).bind(
        dimension === "projects" ? row.projectId : row.keyId,
      );
    }),
  );
  return rows.map((row, i) => {
    if (
      (dimension === "projects" ? row.projectId : row.keyId) ===
      UNATTRIBUTED_LEGACY_ID
    )
      return { ...row, label: unattributedLabel, detail: unattributedDetail };
    const meta = results[i].results?.[0] as
      | { name: string; project?: string; owner: string }
      | undefined;
    if (!meta || (owner !== null && meta.owner !== owner))
      return {
        ...row,
        detail: row.keyId?.startsWith("console_")
          ? "API console"
          : "Historical activity",
      };
    return {
      ...row,
      label: meta.name,
      detail:
        dimension === "keys"
          ? (meta.project ?? row.projectId ?? "")
          : (row.projectId ?? ""),
    };
  });
}

async function searchIds(
  env: DashboardEnv,
  p: Params,
  dimension: UsageDimension,
): Promise<string[]> {
  const table = dimension === "projects" ? "projects" : "api_keys";
  const stmt = env.DB.prepare(
    `SELECT id FROM ${table} WHERE (instr(lower(name), lower(?)) > 0 OR instr(lower(id), lower(?)) > 0)${p.ownerEpicId === null ? "" : " AND owner_epic_id=?"}${p.projectId ? ` AND ${dimension === "projects" ? "id" : "project_id"}=?` : ""}`,
  );
  const bindings: string[] = [p.search ?? "", p.search ?? ""];
  if (p.ownerEpicId !== null) bindings.push(p.ownerEpicId);
  if (p.projectId) bindings.push(p.projectId);
  const { results } = await stmt.bind(...bindings).all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (
    p.ownerEpicId === null &&
    `${unattributedLabel} ${unattributedDetail}`
      .toLowerCase()
      .includes((p.search ?? "").toLowerCase())
  )
    ids.push(UNATTRIBUTED_LEGACY_ID);
  return ids;
}

const ALLOWED_SORTS: readonly UsageSort[] = [
  "requests",
  "cacheHitRate",
  "errors",
  "errorRate",
  "rateLimited",
  "blockedPolicy",
  "avgLatencyMs",
  "p50LatencyMs",
  "p95LatencyMs",
  "p99LatencyMs",
  "label",
];

export async function queryUsageTable(
  env: DashboardEnv,
  params: Params,
): Promise<UsageTableResult> {
  const p = { ...params, end: windowFor(params).end };
  const dimension = p.dimension ?? "endpoints";
  const offset = p.offset ?? 0;
  const limit = p.limit ?? 25;
  const sort = p.sort ?? "requests";
  const direction = p.direction ?? "desc";
  const minRequests = p.minRequests ?? 0;
  // Defense in depth for internal callers; routes also validate all query parameters.
  if (
    !Object.hasOwn(dimensions, dimension) ||
    !ALLOWED_SORTS.includes(sort) ||
    !["asc", "desc"].includes(direction) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(minRequests) ||
    minRequests < 0
  )
    throw new Error("Invalid usage table query");
  const namedSearch = Boolean(
    p.search && ["projects", "keys"].includes(dimension),
  );
  const ids = namedSearch ? await searchIds(env, p, dimension) : [];
  let rows: UsageRow[];
  if (remote(env)) {
    const cols = dimensions[dimension];
    let filter = "";
    if (p.search) {
      const textMatch = `position(lowerUTF8(${literal(p.search)}) IN lowerUTF8(${cols[0]})) > 0`;
      filter = ` AND (${textMatch}${ids.length ? ` OR ${cols[0]} IN (${ids.map(literal).join(",")})` : ""})`;
    }
    // Analytics Engine resolves GROUP BY and ORDER BY cleanly against the projected
    // dN aliases, avoiding expression re-evaluation or constant-grouping errors.
    const aliases = cols.map((_, i) => `d${i}`);
    const having = minRequests > 0 ? ` HAVING requests >= ${minRequests}` : "";
    const orderBy =
      sort === "label"
        ? aliases.map((alias) => `${alias} ${direction.toUpperCase()}`).join(", ")
        : `${sort} ${direction.toUpperCase()}, ${aliases.map((alias) => `${alias} ASC`).join(", ")}`;
    const result = await sql(
      env,
      `SELECT ${cols.map((col, i) => `${col} AS d${i}`).join(", ")}, ${metricSql} FROM egdata_api_usage ${where(p)}${filter} GROUP BY ${aliases.join(", ")}${having} ORDER BY ${orderBy} LIMIT ${limit + 1} OFFSET ${offset} FORMAT JSON`,
    );
    rows = result.map((r) => {
      const values = cols.map((_, i) => String(r[`d${i}`] ?? ""));
      if (dimension === "ips") values.push("Country only");
      return usageRow(values, dimension, metrics(r));
    });
  } else {
    rows = Array.from(
      groups(eventsFor(p), (e) =>
        JSON.stringify(eventDimensions(e, dimension)),
      ),
      ([key, events]) =>
        usageRow(JSON.parse(key), dimension, aggregate(events)),
    );
    if (minRequests > 0) {
      rows = rows.filter((row) => row.requests >= minRequests);
    }
    if (p.search)
      rows = rows.filter(
        (row) =>
          row.label.toLowerCase().includes((p.search ?? "").toLowerCase()) ||
          ids.includes(row.label),
      );
    rows.sort((a, b) => {
      if (sort === "label") {
        const cmp = a.label.localeCompare(b.label) || a.detail.localeCompare(b.detail);
        return direction === "asc" ? cmp : -cmp;
      }
      const left = Number(a[sort] ?? 0);
      const right = Number(b[sort] ?? 0);
      return (
        (direction === "asc" ? left - right : right - left) ||
        a.label.localeCompare(b.label) ||
        a.detail.localeCompare(b.detail)
      );
    });
    rows = rows.slice(offset, offset + limit + 1);
  }
  return {
    rows: await enrich(env, rows.slice(0, limit), dimension, p.ownerEpicId),
    hasMore: rows.length > limit,
    offset,
    end: p.end,
    source: source(env),
  };
}

const LATENCY_BUCKETS = [
  { key: "latLt50", label: "<50 ms" },
  { key: "lat50to150", label: "50–150 ms" },
  { key: "lat150to500", label: "150–500 ms" },
  { key: "lat500to1000", label: "500 ms–1 s" },
  { key: "latGte1000", label: ">1 s" },
] as const;

export async function queryDashboardAnalytics(
  env: DashboardEnv,
  params: UsageFilters & AnalyticsAccess & { quotaProjectIds?: string[] },
): Promise<AnalyticsDashboardSummary> {
  const win = windowFor(params);
  const p = { ...params, end: win.end };
  const { start, end, hours, spanMs } = win;
  const previousParams: Params = params.start
    ? {
        ...p,
        start: new Date(Date.parse(start) - spanMs).toISOString(),
        end: start,
      }
    : { ...p, end: start };
  const bucketMinutes =
    hours <= 2 ? 1 : hours <= 6 ? 5 : hours <= 48 ? 60 : hours <= 168 ? 360 : 1440;
  const bucketMs = bucketMinutes * 60_000;
  let totals: UsageMetrics, previous: UsageMetrics | null;
  let timeseries: AnalyticsDashboardSummary["timeseries"];
  let previousTimeseries: AnalyticsDashboardSummary["previousTimeseries"];
  let quotaTimeseries: AnalyticsDashboardSummary["quotaTimeseries"];
  let latencyDistribution: AnalyticsDashboardSummary["latencyDistribution"];
  let cacheBreakdown: AnalyticsDashboardSummary["cacheBreakdown"];
  let limitOutcomes: AnalyticsDashboardSummary["limitOutcomes"];
  let statusCodes: AnalyticsDashboardSummary["statusCodes"];
  let countryBreakdown: AnalyticsDashboardSummary["countryBreakdown"];
  let clientBreakdown: AnalyticsDashboardSummary["clientBreakdown"];
  let policyBreakdown: AnalyticsDashboardSummary["policyBreakdown"];
  const quotaProjectIds = params.quotaProjectIds;
  const breakdown = async (col: string, limit?: number) =>
    sql(
      env,
      `SELECT ${col} AS label, SUM(_sample_interval * double1) AS requests FROM egdata_api_usage ${where(p)} GROUP BY label ORDER BY requests DESC${limit ? ` LIMIT ${limit}` : ""} FORMAT JSON`,
    );
  const latencyBucketSql = `SUM(_sample_interval * if(double2 < 50, double1, 0)) AS latLt50,
    SUM(_sample_interval * if(double2 >= 50 AND double2 < 150, double1, 0)) AS lat50to150,
    SUM(_sample_interval * if(double2 >= 150 AND double2 < 500, double1, 0)) AS lat150to500,
    SUM(_sample_interval * if(double2 >= 500 AND double2 < 1000, double1, 0)) AS lat500to1000,
    SUM(_sample_interval * if(double2 >= 1000, double1, 0)) AS latGte1000`;
  if (remote(env)) {
    const quotaQuery =
      quotaProjectIds && quotaProjectIds.length > 0
        ? sql(
            env,
            `SELECT toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS bucket, SUM(_sample_interval * double1) AS requests FROM egdata_api_usage ${where(p)} AND blob7 = 'ok' AND blob2 IN (${quotaProjectIds.map(literal).join(", ")}) GROUP BY bucket ORDER BY bucket ASC FORMAT JSON`,
          )
        : Promise.resolve(quotaProjectIds ? [] : undefined);
    const results = await Promise.all([
      sql(
        env,
        `SELECT ${metricSql}, ${latencyBucketSql} FROM egdata_api_usage ${where(p)} FORMAT JSON`,
      ),
      sql(
        env,
        `SELECT ${metricSql} FROM egdata_api_usage ${where(previousParams)} FORMAT JSON`,
      ),
      sql(
        env,
        `SELECT toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS bucket, ${metricSql} FROM egdata_api_usage ${where(p)} GROUP BY bucket ORDER BY bucket ASC FORMAT JSON`,
      ),
      sql(
        env,
        `SELECT toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS bucket, SUM(_sample_interval * double1) AS requests, SUM(_sample_interval * double5) AS errors, SUM(_sample_interval * double2) / SUM(_sample_interval) AS avgLatencyMs, quantileExactWeighted(0.95)(double2, _sample_interval) AS p95LatencyMs FROM egdata_api_usage ${where(previousParams)} GROUP BY bucket ORDER BY bucket ASC FORMAT JSON`,
      ),
      breakdown("blob6"),
      breakdown("blob7"),
      breakdown("blob5"),
      breakdown("blob11", 8),
      breakdown("if(blob12 = 'privacy-v1', blob10, 'legacy (redacted)')"),
      breakdown("if(blob14 = '', '(none)', blob14)", 8),
      quotaQuery,
    ]);
    const totalsRow = results[0][0] ?? {};
    totals = metrics(totalsRow);
    latencyDistribution = LATENCY_BUCKETS.map((b) => ({
      label: b.label,
      requests: Math.round(Number(totalsRow[b.key] ?? 0)),
    }));
    previous = metrics(results[1][0]);
    timeseries = results[2].map((row) => ({
      ...metrics(row),
      bucket: new Date(
        `${String(row.bucket).replace(" ", "T").replace(/Z$/, "")}Z`,
      ).toISOString(),
    }));
    const prevPopulated = new Map(
      results[3].map((row) => {
        const bucketIso = new Date(
          `${String(row.bucket).replace(" ", "T").replace(/Z$/, "")}Z`,
        ).toISOString();
        const alignedTime = Date.parse(bucketIso) + spanMs;
        return [
          Math.floor(alignedTime / bucketMs) * bucketMs,
          {
            requests: Math.round(Number(row.requests ?? 0) * 10) / 10,
            errors: Math.round(Number(row.errors ?? 0) * 10) / 10,
            avgLatencyMs: Number.isFinite(Number(row.avgLatencyMs))
              ? Math.round(Number(row.avgLatencyMs) * 10) / 10
              : 0,
            p95LatencyMs: Number.isFinite(Number(row.p95LatencyMs))
              ? Math.round(Number(row.p95LatencyMs) * 10) / 10
              : 0,
          },
        ];
      }),
    );
    cacheBreakdown = results[4].map((r) => ({
      status: String(r.label),
      requests: Number(r.requests),
    }));
    limitOutcomes = results[5].map((r) => ({
      outcome: String(r.label),
      requests: Number(r.requests),
    }));
    statusCodes = results[6].map((r) => ({
      status: String(r.label),
      requests: Number(r.requests),
    }));
    countryBreakdown = results[7].map((r) => ({
      country: String(r.label || "XX"),
      requests: Number(r.requests),
    }));
    clientBreakdown = results[8].map((r) => ({
      category: String(r.label || "unknown"),
      requests: Number(r.requests),
    }));
    policyBreakdown = results[9]
      .filter((r) => String(r.label) && String(r.label) !== "(none)")
      .map((r) => ({
        policy: String(r.label),
        requests: Number(r.requests),
      }));
    if (results[10]) {
      quotaTimeseries = results[10].map((row) => ({
        bucket: new Date(
          `${String(row.bucket).replace(" ", "T").replace(/Z$/, "")}Z`,
        ).toISOString(),
        requests: Number(row.requests),
      }));
    }
    const populated = new Map(timeseries.map((point) => [point.bucket, point]));
    timeseries = [];
    previousTimeseries = [];
    for (
      let t = Math.floor(Date.parse(start) / bucketMs) * bucketMs;
      t < Date.parse(end);
      t += bucketMs
    ) {
      const bucket = new Date(t).toISOString();
      timeseries.push(populated.get(bucket) ?? { ...metrics(), bucket });
      const prevPoint = prevPopulated.get(t);
      previousTimeseries.push({
        bucket,
        requests: prevPoint?.requests ?? 0,
        errors: prevPoint?.errors ?? 0,
        avgLatencyMs: prevPoint?.avgLatencyMs ?? 0,
        p95LatencyMs: prevPoint?.p95LatencyMs ?? 0,
      });
    }
  } else {
    const events = eventsFor(p);
    totals = aggregate(events);
    latencyDistribution = [
      { label: "<50 ms", requests: events.filter((e) => e.latencyMs < 50).length },
      {
        label: "50–150 ms",
        requests: events.filter((e) => e.latencyMs >= 50 && e.latencyMs < 150)
          .length,
      },
      {
        label: "150–500 ms",
        requests: events.filter((e) => e.latencyMs >= 150 && e.latencyMs < 500)
          .length,
      },
      {
        label: "500 ms–1 s",
        requests: events.filter((e) => e.latencyMs >= 500 && e.latencyMs < 1000)
          .length,
      },
      { label: ">1 s", requests: events.filter((e) => e.latencyMs >= 1000).length },
    ];
    // An isolate's bounded buffer cannot establish coverage of a previous period.
    previous = null;
    timeseries = Array.from(
      groups(events, (e) =>
        new Date(
          Math.floor(Date.parse(e.timestamp) / bucketMs) * bucketMs,
        ).toISOString(),
      ),
      ([bucket, grouped]) => ({ ...aggregate(grouped), bucket }),
    ).sort((a, b) => a.bucket.localeCompare(b.bucket));
    const counts = (key: (e: Event) => string) =>
      Array.from(groups(events, key), ([label, list]) => ({
        label,
        requests: list.length,
      })).sort((a, b) => b.requests - a.requests);
    cacheBreakdown = counts((e) => e.cacheStatus).map((r) => ({
      status: r.label,
      requests: r.requests,
    }));
    limitOutcomes = counts((e) => e.limitOutcome).map((r) => ({
      outcome: r.label,
      requests: r.requests,
    }));
    statusCodes = counts((e) => String(e.statusCode)).map((r) => ({
      status: r.label,
      requests: r.requests,
    }));
    countryBreakdown = counts((e) => e.country || "XX")
      .slice(0, 8)
      .map((r) => ({
        country: r.label,
        requests: r.requests,
      }));
    clientBreakdown = counts((e) => e.userAgent || "unknown").map((r) => ({
      category: r.label,
      requests: r.requests,
    }));
    policyBreakdown = counts((e) => e.policyFamily || "")
      .filter((r) => r.label !== "")
      .slice(0, 8)
      .map((r) => ({
        policy: r.label,
        requests: r.requests,
      }));
    if (quotaProjectIds) {
      const allowedProjects = new Set(quotaProjectIds);
      const quotaEvents = events.filter(
        (e) => e.limitOutcome === "ok" && allowedProjects.has(e.projectId),
      );
      quotaTimeseries = Array.from(
        groups(quotaEvents, (e) =>
          new Date(
            Math.floor(Date.parse(e.timestamp) / bucketMs) * bucketMs,
          ).toISOString(),
        ),
        ([bucket, grouped]) => ({ bucket, requests: grouped.length }),
      ).sort((a, b) => a.bucket.localeCompare(b.bucket));
    }
  }
  const [
    endpoints,
    busiestEndpoints,
    slowestEndpoints,
    errorEndpoints,
    projects,
    keys,
    busiestKeys,
  ] = await Promise.all([
    queryUsageTable(env, {
      ...p,
      dimension: "endpoints",
      limit: 5,
      sort: "rateLimited",
    }),
    queryUsageTable(env, {
      ...p,
      dimension: "endpoints",
      limit: 5,
      sort: "requests",
    }),
    queryUsageTable(env, {
      ...p,
      dimension: "endpoints",
      limit: 5,
      sort: "p95LatencyMs",
    }),
    queryUsageTable(env, {
      ...p,
      dimension: "endpoints",
      limit: 5,
      sort: "errors",
    }),
    queryUsageTable(env, { ...p, dimension: "projects", limit: 5 }),
    queryUsageTable(env, {
      ...p,
      dimension: "keys",
      limit: 5,
      sort: "rateLimited",
    }),
    queryUsageTable(env, {
      ...p,
      dimension: "keys",
      limit: 5,
      sort: "requests",
    }),
  ]);
  return {
    source: source(env),
    scope: p.ownerEpicId === null ? "all" : "project",
    rangeHours: hours,
    start,
    end,
    bucketMinutes,
    totals,
    previous,
    timeseries,
    ...(previousTimeseries !== undefined ? { previousTimeseries } : {}),
    ...(quotaTimeseries !== undefined ? { quotaTimeseries } : {}),
    latencyDistribution,
    cacheBreakdown,
    limitOutcomes,
    statusCodes,
    countryBreakdown,
    clientBreakdown,
    policyBreakdown,
    endpoints: endpoints.rows,
    busiestEndpoints: busiestEndpoints.rows,
    slowestEndpoints: slowestEndpoints.rows,
    errorEndpoints: errorEndpoints.rows,
    projects: projects.rows,
    keys: keys.rows,
    busiestKeys: busiestKeys.rows,
  };
}
