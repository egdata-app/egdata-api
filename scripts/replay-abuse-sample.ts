/** Offline replay of sanitized, timestamped request samples. No network or Redis.
 * Usage: tsx scripts/replay-abuse-sample.ts sample.json legacy-scorer.mjs
 * Legacy module must export extractFingerprint and analyzeEvents from the old revision.
 * This reconstructs the captured request slice, not missing historical/cache-hit traffic.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  extractFingerprint,
  isProtectedPath,
  isSupportPath,
  normalizedAbusePath,
} from "../src/middleware/anti-abuse.js";
import {
  logicalOperations,
  offerHydrationResource,
} from "../src/services/abuse-operations.js";
import {
  type AbuseEvent,
  analyzeEvents,
} from "../src/services/abuse-scorer.js";
import { searchAbuseResource } from "../src/services/abuse-search.js";
import { regions } from "../src/utils/countries.js";

interface CapturedRequest {
  at: number;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  headerNames: string[];
  country: string;
}
interface Capture {
  start: string;
  end: string;
  requests: CapturedRequest[];
}
const [input, legacyPath] = process.argv.slice(2);
if (!input || !legacyPath)
  throw new Error(
    "Pass a timestamped sample JSON and legacy scorer module path",
  );
const sample = JSON.parse(
  readFileSync(input, "utf8").replace(/^\uFEFF/, ""),
) as Capture;
if (!Array.isArray(sample.requests))
  throw new Error(
    "Aggregate-only reports cannot be exactly replayed; use timestamped requests",
  );
const legacy = (await import(pathToFileURL(legacyPath).href)) as {
  extractFingerprint: typeof extractFingerprint;
  analyzeEvents: typeof analyzeEvents;
};
const groups = new Map<
  string,
  {
    events: AbuseEvent[];
    before: Map<string, AbuseEvent[]>;
    uas: Set<string>;
    countries: Set<string>;
    asn: string;
    methods: Record<string, number>;
    routes: Record<string, number>;
  }
>();
const skipped = { options: 0, unsupportedGraphql: 0, outsideScope: 0 };
for (const request of sample.requests) {
  if (request.method === "OPTIONS") {
    skipped.options++;
    continue;
  }
  const path = normalizedAbusePath(request.path);
  const params = new URLSearchParams(
    Object.entries(request.query).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  const oldSupport =
    /^\/(?:search(?:\/tags)?|featured|countries|regions|tags|offers\/genres)$/.test(
      path,
    );
  const support = isSupportPath(path),
    protectedRoute = isProtectedPath(path, params);
  if (!protectedRoute && !support) {
    skipped.outsideScope++;
    continue;
  }
  const headers: Record<string, string> = {
    ...request.headers,
    "x-egdata-edge-secret": "replay",
  };
  const raw = new Request(`https://api.test${path}`, { headers });
  const options = { edgeSecret: "replay", rawHeaderNames: request.headerNames };
  const fp = extractFingerprint(raw, options),
    oldFp = legacy.extractFingerprint(raw, options);
  const event: AbuseEvent = {
    at: request.at,
    method: request.method,
    route: path,
    support,
    deep: protectedRoute && !support,
    mismatch: fp.riskScore,
    page: /^\d{1,9}$/.test(params.get("page") ?? "")
      ? Number(params.get("page"))
      : undefined,
    itemId: /^\/(?:offers|items|sellers)\/([^/]+)/.exec(path)?.[1],
    ...offerHydrationResource(path, request.method, params),
  };
  if (path === "/graphql") {
    const payload = request.method === "POST" ? request.body : request.query;
    const name = payload?.operationName;
    const variables = payload?.variables as { id?: string } | undefined;
    if (
      !["OfferOnly", "OfferPage"].includes(String(name)) ||
      !variables?.id ||
      !/^[a-f0-9]{32}$/.test(variables.id)
    ) {
      skipped.unsupportedGraphql++;
      continue;
    }
    event.resources = [
      {
        route: "/graphql/Query.offer",
        itemId: variables.id,
        hydrationId: variables.id,
        hydrationRoute: `graphql:${name}`,
      },
    ];
  }
  if (path === "/search/v2/search") {
    const payload = request.method === "POST" ? request.body : request.query;
    if (payload && typeof payload === "object") {
      const country = String(request.query.country ?? "US");
      const region =
        Object.keys(regions).find((key) =>
          regions[key].countries.includes(country),
        ) ?? "US";
      const resource = searchAbuseResource(
        payload,
        Math.max(Number(payload.page ?? 1), 1),
        Math.min(Number(payload.limit ?? 10), 100),
        region,
        String(request.query.locale ?? "en-US"),
      );
      if (resource) event.resources = [resource];
      event.page = undefined;
    }
  }
  const oldEvent = {
    ...event,
    support: oldSupport,
    deep: protectedRoute && !oldSupport,
  };
  let group = groups.get(fp.fingerprintHash);
  if (!group) {
    group = {
      events: [],
      before: new Map(),
      uas: new Set(),
      countries: new Set(),
      asn: headers["x-egdata-asn"],
      methods: {},
      routes: {},
    };
    groups.set(fp.fingerprintHash, group);
  }
  group.events.push(event);
  const before = group.before.get(oldFp.fingerprintHash) ?? [];
  before.push(oldEvent);
  group.before.set(oldFp.fingerprintHash, before);
  group.uas.add(headers["user-agent"]);
  group.countries.add(request.country);
  group.methods[request.method] = (group.methods[request.method] ?? 0) + 1;
  const route = path.replace(/\/[a-f0-9]{32}(?=\/|$)/g, "/{id}");
  group.routes[route] = (group.routes[route] ?? 0) + 1;
}
const end = Date.parse(sample.end);
const window = (events: AbuseEvent[]) =>
  events
    .filter((e) => e.at > end - 60000)
    .sort((a, b) => a.at - b.at)
    .slice(-128);
const comparisons = [...groups]
  .map(([fingerprint, group]) => {
    const events = window(group.events),
      operations = logicalOperations(events);
    const before = [...group.before].map(([fp, entries]) => ({
      fingerprint: fp.slice(0, 12),
      requests: window(entries).length,
      ...legacy.analyzeEvents(window(entries)),
    }));
    return {
      fingerprint: fingerprint.slice(0, 12),
      asn: group.asn,
      uas: [...group.uas],
      countries: [...group.countries],
      capturedRequests: group.events.length,
      retainedEvents: events.length,
      logicalOperations: operations.length,
      logicalTitles: new Set(
        operations
          .flatMap((e) => e.resources ?? [])
          .map((r) => r.titleHash)
          .filter(Boolean),
      ).size,
      methods: group.methods,
      routes: group.routes,
      before,
      after: analyzeEvents(events),
    };
  })
  .sort(
    (a, b) =>
      Math.max(...b.before.map((v) => v.score), b.after.score) -
        Math.max(...a.before.map((v) => v.score), a.after.score) ||
      b.capturedRequests - a.capturedRequests,
  );
console.log(
  JSON.stringify(
    {
      start: sample.start,
      end: sample.end,
      note: "Offline reconstruction of this captured request slice only. No inference of missing events or titles from earlier aggregate reports. Known OfferOnly/OfferPage operations reconstructed; unknown GraphQL documents skipped. Titles/parameters are allowlisted; no cache outcome inferred.",
      skipped,
      comparisons,
    },
    null,
    2,
  ),
);
