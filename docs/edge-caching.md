# Edge caching and bandwidth operations

Anti-abuse enforcement preserves the normal cache rules below and baseline rate
limits. Do not bypass public GET caching to force requests through the origin;
that defeats the origin bandwidth savings. Respect origin no-store for challenges,
truncated mitigations and personalized canary lists. See [anti-abuse rollout](anti-abuse.md).
Cloudflare cache hits skip the origin scorer; use edge-side WAF/rate controls for
those requests. Transform Rules forwarding signals do not enforce cache access.

The API now compresses text responses at the origin and emits explicit
shared-cache headers (`Cache-Control`, `CDN-Cache-Control`) for public GET
endpoints. Cloudflare still does **not** cache JSON by default, so the rules in
this document must be created in the Cloudflare dashboard (or with the
Cloudflare API) before JSON traffic stops reaching the origin.

## Why this matters

- Origin egress is what GCP bills. Cloudflare compressing a response for the
  browser does not reduce the origin -> edge bytes.
- Cloudflare's default cache only covers static file extensions. API JSON
  responses report `cf-cache-status: DYNAMIC` until a Cache Rule makes them
  eligible.
- In the 2026-11-05 capture, 448k of 784k requests were `DYNAMIC`, only 75k
  were cache hits, and 464k returned a full `200` body. The origin therefore
  produced almost every response itself.

## 1. Cache Rule: deterministic catalog GETs

Create a Cache Rule with an expression like:

```text
(http.request.method eq "GET" and (
  http.request.uri.path eq "/offers" or
  http.request.uri.path eq "/offers/top-sellers" or
  http.request.uri.path eq "/offers/top-wishlisted" or
  http.request.uri.path eq "/offers/genres" or
  http.request.uri.path eq "/offers/upcoming" or
  http.request.uri.path eq "/offers/latest-released" or
  http.request.uri.path eq "/offers/featured-discounts" or
  http.request.uri.path eq "/free-games" or
  http.request.uri.path eq "/free-games/stats" or
  http.request.uri.path eq "/countries" or
  http.request.uri.path eq "/regions" or
  http.request.uri.path eq "/tags" or
  http.request.uri.path eq "/search/tags" or
  http.request.uri.path eq "/changelist" or
  (starts_with(http.request.uri.path, "/sandboxes/") and
    ends_with(http.request.uri.path, "/offers")) or
  starts_with(http.request.uri.path, "/collections/") or
  starts_with(http.request.uri.path, "/franchises/") or
  starts_with(http.request.uri.path, "/promotions/") or
  starts_with(http.request.uri.path, "/builds")
))
```

Settings:

- **Cache eligibility:** Eligible for cache.
- **Edge TTL:** respect the origin `CDN-Cache-Control` / `Cache-Control`
  header. The API sends 5 minutes for catalog lists, 1 hour for
  countries/regions/tags and the seller directory, and 1 day for
  `/free-games/stats`.
- **Browser TTL:** respect the origin header (60 seconds for catalog lists).
- **Cache key:** include the full query string. The important parameters are
  `country`, `locale`, `page`, `limit`, `offerType`, `title`, `expand`, and
  `facets`. Exclude the `EGDATA_COUNTRY` cookie from the cache key and require
  clients to send `country` as a query parameter; otherwise country-specific
  prices could leak between visitors. `GET /profiles/{id}` is intentionally
  excluded from this rule because it is large and changes often.
- **CORS:** add the `Origin` request header to the cache key (Cache Rules ->
  Cache Key -> Headers), or serve a fixed `Access-Control-Allow-Origin` for
  public GETs. The API echoes allowed origins, and Cloudflare does not include
  `Vary: Origin` in the cache key by default; without this a cached response
  for `egdata.app` can break requests from `store.epicgames.com`.

## 2. Cache Rule: offer search GET

The new `GET /search/v2/search` alias is edge-cacheable:

```text
(http.request.method eq "GET" and
  http.request.uri.path eq "/search/v2/search")
```

Use the same query-string key policy as above, including `facets` and `expand`.
Edge TTL 5 minutes, browser TTL 60 seconds. Leave `POST /search/v2/search`
uncached (Cloudflare does not cache POST).

## 3. Cache Rule: generated preview images

```text
(http.request.method eq "GET" and (
  ends_with(http.request.uri.path, "/og") or
  ends_with(http.request.uri.path, "/og.webp")
))
```

Edge TTL 1 month, browser TTL 1 day. Exclude cookies from the key; versioned
URLs (`?v=...`) can use a 1-year immutable TTL. The API sends the matching
`Cache-Control`/`CDN-Cache-Control` headers.

## 4. Cache Rule: GraphQL GET (APQ)

The GraphQL endpoint supports GET queries and Automatic Persisted Queries.
Hash-only GETs have a short, stable URL (`?extensions=...&variables=...`) and
are the best GraphQL candidates for edge caching:

```text
(http.request.method eq "GET" and
  http.request.uri.path eq "/graphql" and
  http.request.headers["authorization"][0] eq "")
```

Settings:

- **Cache eligibility:** Eligible for cache.
- **Edge TTL:** respect origin `CDN-Cache-Control` / `Cache-Control`. The API
  sends `max-age=60` for offers/prices/profiles, `max-age=300` for
  items/sandboxes, and `max-age=3600` for builds/assets; the overall response
  uses the minimum hint in the query.
- **Cache key:** include the full query string (`extensions`, `query`,
  `variables`, `operationName`), `Origin`, and exclude cookies. Do not cache a
  request with an `Authorization` header.
- **Bypass:** GraphQL `POST` stays uncached. If a client does not use APQ, its
  GET URL still contains the full query and is cacheable, but the URL is long.

## 5. Bypass rule for personalised and mutation traffic

Create a higher-priority Cache Rule with **Bypass cache**:

```text
(http.request.method ne "GET" or
  starts_with(http.request.uri.path, "/auth") or
  starts_with(http.request.uri.path, "/accounts") or
  starts_with(http.request.uri.path, "/admin") or
  starts_with(http.request.uri.path, "/users") or
  starts_with(http.request.uri.path, "/users-service") or
  starts_with(http.request.uri.path, "/push") or
  starts_with(http.request.uri.path, "/launcher") or
  starts_with(http.request.uri.path, "/catalog") or
  http.request.uri.path eq "/profiles/me" or
  (starts_with(http.request.uri.path, "/graphql") and
    http.request.method ne "GET"))
```

`/catalog/hydrate` intentionally sends `Cache-Control: private, no-store`.
`/graphql` POST is query-dependent and is not cached at the edge; GET is handled
by the GraphQL rule above.

## 6. WAF and rate limiting

Application-level limits are already enforced in `src/middlewares/rate-limit.ts`
(defaults: 1200/min general, 1200/min GraphQL GET/APQ, 30/min GraphQL POST,
300/min interactive search, 60/min detail/image routes, 10/min bulk catalog and
launcher resolution). Each limiter has its own Redis key namespace.
Configure matching Cloudflare Rate Limiting rules so abusive clients are
stopped before the origin. Keep the edge thresholds above the origin limits,
otherwise Cloudflare will throttle normal UI bursts before the app sees them:

- `/graphql` GET: 2400 requests/minute per IP.
- `/graphql` POST: 120 requests/minute per IP, block for 10 minutes.
- `/search/*`: 600 requests/minute per IP.
- `/offers/*/og`, `/sandboxes/*/og`: 120 requests/minute per IP.
- `/profiles/*`, `/sellers/*`: 120 requests/minute per IP.
- `/catalog/*`, `/builds/resolve-launcher-records`: 10 requests/minute per IP.

In the 2026-11-05 capture only 2.42k of 784k requests received a `429`, while
six non-browser agents generated ~30% of traffic (`YisouSpider`,
`ColdScript-Catalog/1.0`, `game-price-compare`, `ORBIT/1.0`, Python aiohttp,
`OyunBul`). Add a Bot Fight Mode / WAF rule or challenge for the catalog and
price-comparison agents that are not expected integrations. Keep search-engine
crawlers allowlisted but rate limited.

## 7. Path-normalised analytics

Cloudflare's Top Paths view does not normalise IDs, so offer/profile/seller
detail routes are scattered across unique paths. The API now returns
`X-Route-Template` (for example `/offers/{id}/og`). Use Logpush or a Transform
Rule to capture that header, or group `clientRequestPath` with a regex that
replaces 24-32 character hex IDs. This is required to measure the detail-route
long tail that the dashboard currently hides.

## 8. Verification checklist

1. Compare `cf-cache-status` before/after: the target is >70% `HIT` for the
   cacheable catalog GETs.
2. Compare origin `200` responses against `304` revalidations; a growing `304`
   share means ETag revalidation is working.
3. Re-run the GCP daily egress report and compare against the 25 GiB/day
   baseline.
4. Check `X-Route-Template` aggregates for `/offers/{id}`, `/profiles/{id}`,
   `/sellers/{id}`, `/offers/{id}/og`, and `/multisearch/offers` to attribute
   the remaining dynamic bytes.
