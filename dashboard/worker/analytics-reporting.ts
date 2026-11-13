import type { AdminUsage } from "./admin-types.js";
import { type ApiTelemetryEvent, getLocalTelemetry } from "./analytics.js";
import type {
  AnalyticsDashboardSummary,
  UsageDimension,
  UsageFilters,
  UsageMetrics,
  UsageRow,
  UsageTableFilters,
  UsageTableResult,
} from "./analytics-types.js";
import { UNATTRIBUTED_LEGACY_ID } from "./analytics-types.js";
import type { DashboardEnv } from "./types.js";

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
} satisfies Record<UsageDimension, string[]>;
const unattributedLabel = "Unattributed legacy traffic";
const unattributedDetail = "No verified API key or project";

// Escape both string delimiters and backslashes before interpolating SQL text.
function literal(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
function windowFor(p: UsageFilters) {
  const end = new Date(
    Math.floor(new Date(p.end ?? Date.now()).getTime() / 1000) * 1000,
  ).toISOString();
  return {
    end,
    start: new Date(Date.parse(end) - p.hours * 3600_000).toISOString(),
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
  return `WHERE ${parts.join(" AND ")}`;
}
const metricSql = `SUM(_sample_interval * double1) AS requests,
  SUM(_sample_interval * double4) AS cacheHits,
  SUM(_sample_interval * double3) AS rateLimited,
  SUM(_sample_interval * if(blob7 != 'ok' AND blob7 != 'rate_limited' AND blob7 != 'monthly_quota_exceeded', 1, 0)) AS blockedPolicy,
  SUM(_sample_interval * double5) AS errors,
  100 * SUM(_sample_interval * double4) / SUM(_sample_interval * double1) AS cacheHitRate,
  100 * SUM(_sample_interval * double5) / SUM(_sample_interval * double1) AS errorRate,
  SUM(_sample_interval * double2) / SUM(_sample_interval) AS avgLatencyMs,
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
    cacheHitRate: n("cacheHitRate"),
    rateLimited: n("rateLimited"),
    blockedPolicy: n("blockedPolicy"),
    errors: n("errors"),
    errorRate: n("errorRate"),
    avgLatencyMs: n("avgLatencyMs"),
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

function eventsFor(p: Params): Event[] {
  const { start, end } = windowFor(p);
  return getLocalTelemetry().filter(
    (e) =>
      e.timestamp >= start &&
      e.timestamp < end &&
      (p.ownerEpicId === null || e.ownerEpicId === p.ownerEpicId) &&
      (!p.apiVersion ||
        p.apiVersion === "all" ||
        (e.routeTemplate === "/v1" || e.routeTemplate.startsWith("/v1/")
          ? "v1"
          : "legacy") === p.apiVersion) &&
      (!p.projectId || e.projectId === p.projectId) &&
      (!p.keyId || e.keyId === p.keyId) &&
      (!p.route || e.routeTemplate === p.route) &&
      (!p.method || e.method === p.method),
  );
}
function aggregate(events: Event[]): UsageMetrics {
  const requests = events.length;
  const latencies = events
    .map((e) => Math.max(0, e.latencyMs))
    .sort((a, b) => a - b);
  const quantile = (q: number) =>
    latencies[Math.min(requests - 1, Math.floor(q * requests))] ?? 0;
  const cacheHits = events.filter(
    (e) =>
      ["HIT", "STALE", "UPDATING", "REVALIDATED"].includes(e.cacheStatus) ||
      e.statusCode === 304,
  ).length;
  const errors = events.filter((e) => e.statusCode >= 400).length;
  return metrics({
    requests,
    cacheHits,
    cacheHitRate: requests ? (cacheHits / requests) * 100 : 0,
    rateLimited: events.filter(
      (e) =>
        e.statusCode === 429 ||
        e.limitOutcome === "rate_limited" ||
        e.limitOutcome === "monthly_quota_exceeded",
    ).length,
    blockedPolicy: events.filter(
      (e) =>
        !["ok", "rate_limited", "monthly_quota_exceeded"].includes(
          e.limitOutcome,
        ),
    ).length,
    errors,
    errorRate: requests ? (errors / requests) * 100 : 0,
    avgLatencyMs: requests
      ? latencies.reduce((a, b) => a + b, 0) / requests
      : 0,
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
  }
}
function usageRow(
  values: string[],
  dimension: UsageDimension,
  m: UsageMetrics,
): UsageRow {
  const [label, detail = ""] = values;
  return {
    ...m,
    id: JSON.stringify(values),
    label,
    detail,
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
  if (!rows.length || !["projects", "keys"].includes(dimension)) return rows;
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
  // Defense in depth for internal callers; routes also validate all query parameters.
  if (
    !Object.hasOwn(dimensions, dimension) ||
    ![
      "requests",
      "cacheHitRate",
      "rateLimited",
      "blockedPolicy",
      "errorRate",
      "avgLatencyMs",
      "p95LatencyMs",
    ].includes(sort) ||
    !["asc", "desc"].includes(direction) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
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
    const result = await sql(
      env,
      `SELECT ${cols.map((col, i) => `${col} AS d${i}`).join(", ")}, ${metricSql} FROM egdata_api_usage ${where(p)}${filter} GROUP BY ${aliases.join(", ")} ORDER BY ${sort} ${direction.toUpperCase()}, ${aliases.map((alias) => `${alias} ASC`).join(", ")} LIMIT ${limit + 1} OFFSET ${offset} FORMAT JSON`,
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
    if (p.search)
      rows = rows.filter(
        (row) =>
          row.label.toLowerCase().includes((p.search ?? "").toLowerCase()) ||
          ids.includes(row.label),
      );
    rows.sort(
      (a, b) =>
        (direction === "asc" ? a[sort] - b[sort] : b[sort] - a[sort]) ||
        a.label.localeCompare(b.label) ||
        a.detail.localeCompare(b.detail),
    );
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

export async function queryDashboardAnalytics(
  env: DashboardEnv,
  params: UsageFilters & AnalyticsAccess & { quotaProjectIds?: string[] },
): Promise<AnalyticsDashboardSummary> {
  const p = { ...params, end: windowFor(params).end };
  const { start, end } = windowFor(p);
  const bucketMinutes =
    p.hours <= 6 ? 5 : p.hours <= 48 ? 60 : p.hours <= 168 ? 360 : 1440;
  const bucketMs = bucketMinutes * 60_000;
  let totals: UsageMetrics, previous: UsageMetrics | null;
  let timeseries: AnalyticsDashboardSummary["timeseries"];
  let quotaTimeseries: AnalyticsDashboardSummary["quotaTimeseries"];
  let cacheBreakdown: AnalyticsDashboardSummary["cacheBreakdown"];
  let limitOutcomes: AnalyticsDashboardSummary["limitOutcomes"];
  let statusCodes: AnalyticsDashboardSummary["statusCodes"];
  const quotaProjectIds = params.quotaProjectIds;
  const breakdown = async (col: string) =>
    sql(
      env,
      `SELECT ${col} AS label, SUM(_sample_interval * double1) AS requests FROM egdata_api_usage ${where(p)} GROUP BY ${col} ORDER BY requests DESC FORMAT JSON`,
    );
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
        `SELECT ${metricSql} FROM egdata_api_usage ${where(p)} FORMAT JSON`,
      ),
      sql(
        env,
        `SELECT ${metricSql} FROM egdata_api_usage ${where({ ...p, end: start })} FORMAT JSON`,
      ),
      sql(
        env,
        `SELECT toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS bucket, ${metricSql} FROM egdata_api_usage ${where(p)} GROUP BY bucket ORDER BY bucket ASC FORMAT JSON`,
      ),
      breakdown("blob6"),
      breakdown("blob7"),
      breakdown("blob5"),
      quotaQuery,
    ]);
    totals = metrics(results[0][0]);
    previous = metrics(results[1][0]);
    timeseries = results[2].map((row) => ({
      ...metrics(row),
      bucket: new Date(
        `${String(row.bucket).replace(" ", "T").replace(/Z$/, "")}Z`,
      ).toISOString(),
    }));
    cacheBreakdown = results[3].map((r) => ({
      status: String(r.label),
      requests: Number(r.requests),
    }));
    limitOutcomes = results[4].map((r) => ({
      outcome: String(r.label),
      requests: Number(r.requests),
    }));
    statusCodes = results[5].map((r) => ({
      status: String(r.label),
      requests: Number(r.requests),
    }));
    if (results[6]) {
      quotaTimeseries = results[6].map((row) => ({
        bucket: new Date(
          `${String(row.bucket).replace(" ", "T").replace(/Z$/, "")}Z`,
        ).toISOString(),
        requests: Number(row.requests),
      }));
    }
    const populated = new Map(timeseries.map((point) => [point.bucket, point]));
    timeseries = [];
    for (
      let t = Math.floor(Date.parse(start) / bucketMs) * bucketMs;
      t < Date.parse(end);
      t += bucketMs
    ) {
      const bucket = new Date(t).toISOString();
      timeseries.push(populated.get(bucket) ?? { ...metrics(), bucket });
    }
  } else {
    const events = eventsFor(p);
    totals = aggregate(events);
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
  const [endpoints, projects, keys] = await Promise.all([
    queryUsageTable(env, {
      ...p,
      dimension: "endpoints",
      limit: 5,
      sort: "rateLimited",
    }),
    queryUsageTable(env, { ...p, dimension: "projects", limit: 5 }),
    queryUsageTable(env, {
      ...p,
      dimension: "keys",
      limit: 5,
      sort: "rateLimited",
    }),
  ]);
  return {
    source: source(env),
    scope: p.ownerEpicId === null ? "all" : "project",
    rangeHours: p.hours,
    start,
    end,
    bucketMinutes,
    totals,
    previous,
    timeseries,
    ...(quotaTimeseries !== undefined ? { quotaTimeseries } : {}),
    cacheBreakdown,
    limitOutcomes,
    statusCodes,
    endpoints: endpoints.rows,
    projects: projects.rows,
    keys: keys.rows,
  };
}
