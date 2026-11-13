/**
 * Worker edge cache using Cloudflare's Cache API.
 *
 * Key-authenticated caching runs AFTER authentication, permission evaluation,
 * and quota admission. Allowlisted public routes can use an isolated anonymous
 * cache after the gateway admits anonymous access.
 * Responses returned to clients keep private/unshared cache headers where required
 * while internal Cache API entries carry explicit edge TTLs.
 */

import { bytesToHex } from "./crypto.js";

const CACHE_KEY_ORIGIN = "https://edge-cache.egdata.internal";
const CACHE_VERSION = "v1";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type V1TtlRule = {
  test: RegExp;
  ttlSeconds: number;
};

const V1_TTL_RULES: V1TtlRule[] = [
  {
    test: /^\/v1\/(?:countries|regions|region|free-games\/stats)$/,
    ttlSeconds: DAY,
  },
  {
    test: /^\/v1\/(?:robots\.txt|(?:items-|promotions-|sandboxes\/|profiles\/|items\/)?sitemap\.xml)$/,
    ttlSeconds: HOUR,
  },
  {
    test: /^\/v1\/(?:offers\/[^/]+\/og(?:\.webp)?|sandboxes\/[^/]+\/og(?:\.webp)?)$/,
    ttlSeconds: HOUR,
  },
  {
    test: /^\/v1\/offers\/[^/]+\/(?:hltb|igdb|requirements|age-rating)$/,
    ttlSeconds: HOUR,
  },
  {
    test: /^\/v1\/(?:tags|search\/(?:tags|offer-types|developers|publishers)|offers\/genres|sellers)$/,
    ttlSeconds: 15 * MINUTE,
  },
  {
    test: /^\/v1\/(?:offers\/[^/]+\/(?:achievements|builds|franchises|features|genres|technologies|mappings|media|related|suggestions)|sandboxes\/[^/]+\/(?:achievements|builds)|items\/[^/]+\/builds)$/,
    ttlSeconds: 15 * MINUTE,
  },
  {
    test: /^\/v1\/(?:offers(?:\/(?:top-sellers|top-wishlisted|featured-discounts))?|featured|free-games(?:\/(?:history|mobile|sellers))?|search(?:\/natural-language)?)$/,
    ttlSeconds: 5 * MINUTE,
  },
];

const DEFAULT_V1_TTL_SECONDS = MINUTE;

const LEGACY_SKIP_EXACT = new Set([
  "/",
  "/health",
  "/ping",
  "/robots.txt",
  "/open-api.json",
  "/doc",
  "/ui",
]);

const LEGACY_SKIP_PREFIXES = [
  "/auth",
  "/accounts",
  "/admin",
  "/users",
  "/users-service",
  "/push",
  "/launcher",
  "/catalog",
  "/offers/regen",
  "/items/regen",
  "/search/natural-language",
];

function getDefaultCache(): Cache | null {
  const storage = (globalThis as { caches?: { default?: Cache } }).caches;
  return storage?.default ?? null;
}

export function canonicalSearchParams(search: string): string {
  if (!search || search === "?") return "";
  const params = new URLSearchParams(search);
  // Query parsers commonly use the first value for repeated names. Sort names
  // only; stable sorting preserves the original order of values per name.
  const entries = [...params.entries()].sort(([k1], [k2]) =>
    k1 < k2 ? -1 : k1 > k2 ? 1 : 0,
  );
  if (entries.length === 0) return "";
  const sorted = new URLSearchParams();
  for (const [key, value] of entries) {
    sorted.append(key, value);
  }
  const serialized = sorted.toString();
  return serialized ? `?${serialized}` : "";
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeJsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function hashPostBody(bodyBytes: ArrayBuffer): Promise<string> {
  let payload: BufferSource = bodyBytes;
  try {
    const text = new TextDecoder().decode(bodyBytes);
    const parsed = JSON.parse(text);
    const canonical = JSON.stringify(canonicalizeJsonValue(parsed));
    payload = new TextEncoder().encode(canonical);
  } catch {
    // Non-JSON body: hash raw bytes as-is.
  }
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return bytesToHex(new Uint8Array(digest));
}

function buildCacheLookupRequest(
  namespace: "v1" | "legacy" | "legacy-public",
  pathname: string,
  search: string,
  clientRequest: Request,
  postBodyHash?: string,
): { putRequest: Request; matchRequest: Request } {
  const canonicalQuery = canonicalSearchParams(search);
  const pathPrefix = postBodyHash ? "/post" : "";
  const bodySuffix = postBodyHash
    ? `${canonicalQuery ? "&" : "?"}__body=${postBodyHash}`
    : "";
  const url = `${CACHE_KEY_ORIGIN}/${CACHE_VERSION}/${namespace}${pathPrefix}${pathname}${canonicalQuery}${bodySuffix}`;
  const putRequest = new Request(url, { method: "GET" });

  const conditionalHeaders = new Headers();
  const ifNoneMatch = clientRequest.headers.get("if-none-match");
  if (ifNoneMatch) conditionalHeaders.set("if-none-match", ifNoneMatch);
  const ifModifiedSince = clientRequest.headers.get("if-modified-since");
  if (ifModifiedSince) {
    conditionalHeaders.set("if-modified-since", ifModifiedSince);
  }

  const matchRequest =
    ifNoneMatch || ifModifiedSince
      ? new Request(url, { method: "GET", headers: conditionalHeaders })
      : putRequest;

  return { putRequest, matchRequest };
}

export function v1EdgeCacheTtlSeconds(pathname: string): number {
  for (const rule of V1_TTL_RULES) {
    if (rule.test.test(pathname)) return rule.ttlSeconds;
  }
  return DEFAULT_V1_TTL_SECONDS;
}

const V1_CACHEABLE_POST_PATHS = new Set([
  "/v1/search",
  "/v1/search/natural-language",
]);

export function isV1RequestCacheable(
  method: string,
  pathname: string,
): boolean {
  const upper = method.toUpperCase();
  if (upper === "POST") {
    return V1_CACHEABLE_POST_PATHS.has(pathname);
  }
  if (upper !== "GET" && upper !== "HEAD") return false;
  if (pathname.endsWith("/catalog/hydrate")) return false;
  return true;
}

function hasRangeCondition(request: Request): boolean {
  return request.headers.has("range") || request.headers.has("if-range");
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"))
  );
}

function parseSharedMaxAgeSeconds(headerValue: string | null): number | null {
  if (!headerValue) return null;
  if (
    /(?:^|,)\s*(?:private|no-store|no-cache)\s*(?:,|=|$)/i.test(headerValue)
  ) {
    return null;
  }
  const sMaxAge = /(?:^|,)\s*s-maxage=(\d+)/i.exec(headerValue);
  if (sMaxAge) {
    const seconds = Number(sMaxAge[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(headerValue);
  if (maxAge) {
    const seconds = Number(maxAge[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  return null;
}

export function legacyResponseEdgeTtlSeconds(
  response: Response,
): number | null {
  if (response.status !== 200) return null;
  if (response.headers.has("set-cookie")) return null;
  if (response.headers.has("x-egdata-mitigation")) return null;
  const vary = response.headers.get("vary") ?? "";
  if (vary.trim() === "*" || /\b(?:cookie|authorization)\b/i.test(vary)) {
    return null;
  }
  // CDN-specific directives override Cache-Control. A present directive with
  // no usable positive TTL (including no-store) must not fall through.
  for (const name of ["cloudflare-cdn-cache-control", "cdn-cache-control"]) {
    const value = response.headers.get(name);
    if (value !== null) return parseSharedMaxAgeSeconds(value);
  }
  return parseSharedMaxAgeSeconds(response.headers.get("cache-control"));
}

export function isLegacyRequestCacheable(
  request: Request,
  pathname: string,
): boolean {
  const upper = request.method.toUpperCase();
  if (upper !== "GET" && upper !== "HEAD") return false;
  if (LEGACY_SKIP_EXACT.has(pathname)) return false;
  if (
    LEGACY_SKIP_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return false;
  }
  if (pathname.endsWith("/ownership") || pathname.endsWith("/permissions")) {
    return false;
  }
  // Never share responses when caller sends cookies, session tokens, or non-API-key Authorization
  if (request.headers.has("cookie")) return false;
  if (request.headers.has("x-egdata-session")) return false;
  const auth = request.headers.get("authorization")?.trim();
  if (auth && !/^Bearer\s+egk_/i.test(auth)) return false;
  return true;
}

function stripHopHeadersForStorage(headers: Headers): Headers {
  const stored = new Headers(headers);
  for (const name of [
    "set-cookie",
    "x-request-id",
    "ratelimit",
    "ratelimit-policy",
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-policy",
    "x-egdata-key-tier",
    "cdn-cache-control",
    "cloudflare-cdn-cache-control",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-expose-headers",
  ]) {
    stored.delete(name);
  }
  // Normalize Vary so Cache API will not reject Vary: * or split on Origin/Accept-Encoding
  stored.delete("vary");
  return stored;
}

export type EdgeCacheFetchResult = {
  response: Response;
  cacheStatus: string;
};

// Anonymous entries retain the origin's client-facing freshness and CORS policy.
// Their keys are partitioned by Origin and isolated from post-auth cache entries.
const PUBLIC_HEADERS_METADATA = "x-egdata-cache-public-headers";
const PUBLIC_RESPONSE_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "vary",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-expose-headers",
] as const;

function restorePublicResponse(cached: Response): Response {
  const headers = new Headers(cached.headers);
  const values = JSON.parse(headers.get(PUBLIC_HEADERS_METADATA) ?? "null");
  if (
    !Array.isArray(values) ||
    values.length !== PUBLIC_RESPONSE_HEADERS.length
  ) {
    throw new Error("Invalid public cache metadata");
  }
  PUBLIC_RESPONSE_HEADERS.forEach((name, index) => {
    if (values[index] === null) headers.delete(name);
    else headers.set(name, values[index]);
  });
  headers.delete(PUBLIC_HEADERS_METADATA);
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

/**
 * Reads from or populates Cloudflare's Cache API (`caches.default`) for v1 GET/HEAD
 * operations after API key authentication, permission checks, and quota admission.
 */
export async function fetchV1WithEdgeCache(options: {
  request: Request;
  ctx: ExecutionContext;
  pathname: string;
  search: string;
  fetchUpstream: (upstreamRequest: Request) => Promise<Response>;
}): Promise<EdgeCacheFetchResult> {
  const { request, ctx, pathname, search, fetchUpstream } = options;
  const method = request.method.toUpperCase();
  const isPostJsonEligible =
    method !== "POST" || isJsonContentType(request.headers.get("content-type"));

  if (
    !isPostJsonEligible ||
    !isV1RequestCacheable(method, pathname) ||
    hasRangeCondition(request)
  ) {
    const response = await fetchUpstream(request);
    const cfStatus = response.headers.get("cf-cache-status");
    return {
      response,
      cacheStatus:
        response.status === 304 ? "REVALIDATED" : cfStatus || "DYNAMIC",
    };
  }

  const isCacheablePost = method === "POST";
  let postBodyBytes: ArrayBuffer | undefined;
  let postBodyHash: string | undefined;
  if (isCacheablePost) {
    postBodyBytes = await request.arrayBuffer();
    postBodyHash = await hashPostBody(postBodyBytes);
  }

  const cache = getDefaultCache();
  const { putRequest, matchRequest } = buildCacheLookupRequest(
    "v1",
    pathname,
    search,
    request,
    postBodyHash,
  );

  if (cache) {
    try {
      const cached = await cache.match(matchRequest);
      if (cached) {
        if (cached.status === 304) {
          return {
            response: new Response(null, {
              status: method === "GET" || method === "HEAD" ? 304 : 412,
              headers: cached.headers,
            }),
            cacheStatus: "REVALIDATED",
          };
        }
        return {
          response:
            method === "HEAD"
              ? new Response(null, {
                  status: cached.status,
                  statusText: cached.statusText,
                  headers: cached.headers,
                })
              : cached,
          cacheStatus: "HIT",
        };
      }
    } catch {
      // Cache API errors must never fail API requests; fall through to origin.
    }
  }

  // When Cache API is active and we missed, fetch full GET representation without
  // conditional headers on GET so we can populate the shared edge cache for subsequent
  // callers, then evaluate client If-None-Match locally before returning.
  const canPopulateCache = Boolean(
    cache && (method === "GET" || isCacheablePost),
  );
  let upstreamRequest = isCacheablePost
    ? new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: postBodyBytes,
      })
    : request;
  if (
    canPopulateCache &&
    !isCacheablePost &&
    (request.headers.has("if-none-match") ||
      request.headers.has("if-modified-since"))
  ) {
    const cleanHeaders = new Headers(request.headers);
    cleanHeaders.delete("if-none-match");
    cleanHeaders.delete("if-modified-since");
    upstreamRequest = new Request(request.url, {
      method: request.method,
      headers: cleanHeaders,
    });
  }

  const upstream = await fetchUpstream(upstreamRequest);

  if (upstream.status === 304) {
    return { response: upstream, cacheStatus: "REVALIDATED" };
  }

  const upstreamCacheControl = upstream.headers.get("cache-control") ?? "";
  const originForbidsStore = /\bno-store\b/i.test(upstreamCacheControl);
  const cacheableStatus =
    upstream.status === 200 || (isCacheablePost && upstream.status === 303);

  if (
    canPopulateCache &&
    cache &&
    cacheableStatus &&
    !originForbidsStore &&
    !upstream.headers.has("set-cookie") &&
    !upstream.headers.has("x-egdata-mitigation")
  ) {
    const ttl = v1EdgeCacheTtlSeconds(pathname);
    const toCache = upstream.clone();
    const storedHeaders = stripHopHeadersForStorage(toCache.headers);
    storedHeaders.set("Cache-Control", `public, max-age=${ttl}`);

    const cacheableResponse = new Response(toCache.body, {
      status: upstream.status,
      statusText: toCache.statusText,
      headers: storedHeaders,
    });

    ctx.waitUntil(cache.put(putRequest, cacheableResponse).catch(() => {}));

    // Honor client conditional If-None-Match even when we fetched 200 to warm the cache
    const clientIfNoneMatch = request.headers.get("if-none-match");
    const responseEtag = upstream.headers.get("etag");
    if (
      clientIfNoneMatch &&
      responseEtag &&
      etagMatches(clientIfNoneMatch, responseEtag)
    ) {
      await upstream.body?.cancel().catch(() => {});
      return {
        response: new Response(null, {
          status: method === "GET" || method === "HEAD" ? 304 : 412,
          headers: upstream.headers,
        }),
        cacheStatus: "REVALIDATED",
      };
    }

    return { response: upstream, cacheStatus: "MISS" };
  }

  const cfStatus = upstream.headers.get("cf-cache-status");
  if (cfStatus) {
    return { response: upstream, cacheStatus: cfStatus };
  }
  return {
    response: upstream,
    cacheStatus:
      upstream.status === 200 && !originForbidsStore ? "MISS" : "DYNAMIC",
  };
}

/**
 * Reads from or populates Cloudflare's Cache API (`caches.default`) for legacy
 * unversioned GET/HEAD operations after API key authentication and rate limiting.
 * Explicitly allowlisted anonymous public routes may opt into a separate cache
 * after the gateway's existing anonymous-access decision.
 */
export async function fetchLegacyWithEdgeCache(options: {
  request: Request;
  ctx: ExecutionContext;
  pathname: string;
  search: string;
  fetchUpstream: (upstreamRequest: Request) => Promise<Response>;
  anonymousPublic?: boolean;
}): Promise<EdgeCacheFetchResult> {
  const {
    request,
    ctx,
    pathname,
    search,
    fetchUpstream,
    anonymousPublic = false,
  } = options;
  const method = request.method.toUpperCase();

  if (
    !isLegacyRequestCacheable(request, pathname) ||
    hasRangeCondition(request)
  ) {
    const response = await fetchUpstream(request);
    const cfStatus = response.headers.get("cf-cache-status");
    return {
      response,
      cacheStatus:
        response.status === 304 ? "REVALIDATED" : cfStatus || "DYNAMIC",
    };
  }

  const cache = getDefaultCache();
  const { putRequest, matchRequest } = buildCacheLookupRequest(
    anonymousPublic ? "legacy-public" : "legacy",
    anonymousPublic
      ? `/${encodeURIComponent(request.headers.get("origin") ?? "")}${pathname}`
      : pathname,
    search,
    request,
  );

  if (cache) {
    try {
      const match = await cache.match(matchRequest);
      const cached =
        match && anonymousPublic ? restorePublicResponse(match) : match;
      if (cached) {
        if (cached.status === 304) {
          return {
            response: new Response(null, {
              status: method === "GET" || method === "HEAD" ? 304 : 412,
              headers: cached.headers,
            }),
            cacheStatus: "REVALIDATED",
          };
        }
        return {
          response:
            method === "HEAD"
              ? new Response(null, {
                  status: cached.status,
                  statusText: cached.statusText,
                  headers: cached.headers,
                })
              : cached,
          cacheStatus: "HIT",
        };
      }
    } catch {
      // Fall through to origin on Cache API error
    }
  }

  const canPopulateCache = Boolean(cache && method === "GET");
  let upstreamRequest = request;
  if (
    canPopulateCache &&
    (request.headers.has("if-none-match") ||
      request.headers.has("if-modified-since"))
  ) {
    const cleanHeaders = new Headers(request.headers);
    cleanHeaders.delete("if-none-match");
    cleanHeaders.delete("if-modified-since");
    upstreamRequest = new Request(request.url, {
      method: request.method,
      headers: cleanHeaders,
    });
  }

  const upstream = await fetchUpstream(upstreamRequest);

  if (upstream.status === 304) {
    return { response: upstream, cacheStatus: "REVALIDATED" };
  }

  const ttl = legacyResponseEdgeTtlSeconds(upstream);
  const supportedVary =
    !anonymousPublic ||
    (upstream.headers.get("vary") ?? "")
      .split(",")
      .every((name) =>
        ["", "origin", "accept-encoding"].includes(name.trim().toLowerCase()),
      );
  if (canPopulateCache && cache && ttl !== null && supportedVary) {
    const toCache = upstream.clone();
    const storedHeaders = stripHopHeadersForStorage(toCache.headers);
    storedHeaders.set("Cache-Control", `public, max-age=${ttl}`);
    if (anonymousPublic) {
      storedHeaders.set(
        PUBLIC_HEADERS_METADATA,
        JSON.stringify(
          PUBLIC_RESPONSE_HEADERS.map((name) => upstream.headers.get(name)),
        ),
      );
    }

    const cacheableResponse = new Response(toCache.body, {
      status: 200,
      statusText: toCache.statusText,
      headers: storedHeaders,
    });

    ctx.waitUntil(cache.put(putRequest, cacheableResponse).catch(() => {}));

    const clientIfNoneMatch = request.headers.get("if-none-match");
    const responseEtag = upstream.headers.get("etag");
    if (
      clientIfNoneMatch &&
      responseEtag &&
      etagMatches(clientIfNoneMatch, responseEtag)
    ) {
      await upstream.body?.cancel().catch(() => {});
      return {
        response: new Response(null, {
          status: method === "GET" || method === "HEAD" ? 304 : 412,
          headers: upstream.headers,
        }),
        cacheStatus: "REVALIDATED",
      };
    }

    return { response: upstream, cacheStatus: "MISS" };
  }

  const cfStatus = upstream.headers.get("cf-cache-status");
  if (cfStatus) {
    return { response: upstream, cacheStatus: cfStatus };
  }
  return {
    response: upstream,
    cacheStatus: ttl !== null ? "MISS" : "DYNAMIC",
  };
}

function normalizeWeakEtag(tag: string): string {
  return tag.trim().replace(/^W\//i, "");
}

export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  const target = normalizeWeakEtag(etag);
  if (!target) return false;
  return trimmed
    .split(",")
    .some((candidate) => normalizeWeakEtag(candidate) === target);
}
