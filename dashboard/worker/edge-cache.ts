/**
 * Post-authentication, post-quota Worker edge cache using Cloudflare's Cache API.
 *
 * Caching runs strictly AFTER API key authentication, permission evaluation, and
 * quota admission so cached responses never bypass access control or rate limits.
 * Responses returned to clients keep private/unshared cache headers where required
 * while internal Cache API entries carry explicit edge TTLs.
 */

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
    test: /^\/v1\/(?:tags|search\/(?:tags|offer-types|developers|publishers)|offers\/genres|sellers)$/,
    ttlSeconds: 15 * MINUTE,
  },
  {
    test: /^\/v1\/(?:offers\/(?:top-sellers|top-wishlisted|featured-discounts)|featured|free-games(?:\/(?:history|mobile|sellers))?)$/,
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

function canonicalSearchParams(search: string): string {
  if (!search || search === "?") return "";
  const params = new URLSearchParams(search);
  const entries = [...params.entries()].sort(
    ([k1, v1], [k2, v2]) => k1.localeCompare(k2) || v1.localeCompare(v2),
  );
  if (entries.length === 0) return "";
  const sorted = new URLSearchParams();
  for (const [key, value] of entries) {
    sorted.append(key, value);
  }
  const serialized = sorted.toString();
  return serialized ? `?${serialized}` : "";
}

function buildCacheLookupRequest(
  namespace: "v1" | "legacy",
  pathname: string,
  search: string,
  clientRequest: Request,
): { putRequest: Request; matchRequest: Request } {
  const url = `${CACHE_KEY_ORIGIN}/${CACHE_VERSION}/${namespace}${pathname}${canonicalSearchParams(search)}`;
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

export function isV1RequestCacheable(
  method: string,
  pathname: string,
): boolean {
  const upper = method.toUpperCase();
  if (upper !== "GET" && upper !== "HEAD") return false;
  if (pathname.endsWith("/catalog/hydrate")) return false;
  return true;
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
  const cdnTtl = parseSharedMaxAgeSeconds(
    response.headers.get("cloudflare-cdn-cache-control") ??
      response.headers.get("cdn-cache-control"),
  );
  if (cdnTtl !== null) return cdnTtl;
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

  if (!isV1RequestCacheable(method, pathname)) {
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
    "v1",
    pathname,
    search,
    request,
  );

  if (cache) {
    try {
      const cached = await cache.match(matchRequest);
      if (cached) {
        if (cached.status === 304) {
          return {
            response: new Response(null, {
              status: 304,
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

  const upstreamCacheControl = upstream.headers.get("cache-control") ?? "";
  const originForbidsStore = /\bno-store\b/i.test(upstreamCacheControl);

  if (
    canPopulateCache &&
    cache &&
    upstream.status === 200 &&
    !originForbidsStore &&
    !upstream.headers.has("set-cookie") &&
    !upstream.headers.has("x-egdata-mitigation")
  ) {
    const ttl = v1EdgeCacheTtlSeconds(pathname);
    const toCache = upstream.clone();
    const storedHeaders = stripHopHeadersForStorage(toCache.headers);
    storedHeaders.set("Cache-Control", `public, max-age=${ttl}`);

    const cacheableResponse = new Response(toCache.body, {
      status: 200,
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
          status: 304,
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
 */
export async function fetchLegacyWithEdgeCache(options: {
  request: Request;
  ctx: ExecutionContext;
  pathname: string;
  search: string;
  fetchUpstream: (upstreamRequest: Request) => Promise<Response>;
}): Promise<EdgeCacheFetchResult> {
  const { request, ctx, pathname, search, fetchUpstream } = options;
  const method = request.method.toUpperCase();

  if (!isLegacyRequestCacheable(request, pathname)) {
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
    "legacy",
    pathname,
    search,
    request,
  );

  if (cache) {
    try {
      const cached = await cache.match(matchRequest);
      if (cached) {
        if (cached.status === 304) {
          return {
            response: new Response(null, {
              status: 304,
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
  if (canPopulateCache && cache && ttl !== null) {
    const toCache = upstream.clone();
    const storedHeaders = stripHopHeadersForStorage(toCache.headers);
    storedHeaders.set("Cache-Control", `public, max-age=${ttl}`);

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
          status: 304,
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
