# Changelog

All notable public API, documentation, release, and sustainability changes should be recorded here.

## Unreleased

- Raised the anti-abuse `unique-id-sweep` threshold from 30 to 60 distinct resource IDs within the rolling 60-second window. Other scoring weights, volume/pagination thresholds, and enforcement behavior remain unchanged.

- Made GET the primary search v2 endpoint. POST now validates and sanitizes filters and returns a bodyless 303 redirect to a deterministic, cacheable GET URL without querying search or response caches. GET pricing defaults to US independently of cookies; POST resolves cookie country into the URL. Updated search validation, docs, OpenAPI, and redirect/cache regression coverage, including real HTTP fetch, CORS headers, compression, ETags and special-character round trips. Documented remaining staging checks and redirect rate-limit accounting.

- Changed high-risk tarpits to bodyless HTTP 204 responses with a CORS-exposed `X-Egdata-Mitigation: tarpit` marker. Existing delays, sleeper limits, no-store headers and HTTP 200 PoW challenges remain unchanged. Updated the public contract and regression tests; deploy compatible frontend handling first.

- Added an operator-only daily PoW cohort report that deduplicates challenge responses and accepted proof replays, separates pending cohorts from those with no solution observed after five minutes, and flags storage saturation. Bounded asynchronous Redis tracking uses trusted fingerprint hashes, not unique-person identities; enforcement and the public protocol are unchanged.

- Added asynchronous server-side PoW outcome counters and an operator report for challenge responses, puzzle issuance/replacement, accepted/rejected proofs, requests admitted with valid sessions, and observe-mode would-challenge/would-tarpit decisions. Existing 24-hour Redis summaries remain bounded and private; no public endpoint, frontend telemetry, or enforcement change.

- Detect out-of-order pagination (10 distinct pages per semantic resource) and route hammering (120 logical requests per concrete resource) within the existing bounded 60-second anti-abuse window. Both share the existing sweep weight and appear in observation summaries; hydration collapsing, caching, and deployment mode remain unchanged. These signals describe behavior, not measured origin bandwidth cost.

- Updated anti-abuse fingerprints/scoring to v2: preserve relative header order while ignoring Apollo/CORS plumbing, collapse offer hydration and typing bursts, and detect sustained distinct-title lookups within the existing bounded 60-second window. Browse routes count as support and deep-only traffic alone adds no risk. Added a 600-second global CORS preflight lifetime and strict HTTPS egdata.app hostname boundaries. Deployment mode remains operator-controlled; rollout stays in observe with canaries disabled.

- Added catalog-search and sandbox-offer traversal scoring using normalized filter fingerprints, including sequential pages up to five seconds apart. Added bounded, asynchronous 24-hour summaries of request scores, reasons, routes, and encoded origin body bytes. Added operator-only fingerprint-scoped trials with automatic expiry and rollback, plus a browser PoW staging harness; ordinary public caching and baseline rate limits remain active.

- Reduced the default GraphQL POST quota from 120 to 30 requests per minute per client IP (`RATE_LIMIT_GRAPHQL_POST_PER_MINUTE`). GraphQL GET/APQ retains its separate 1200/minute quota; throttled requests return 429 with Retry-After.

- Preserved normal CDN caching, ETags and baseline rate limits during anti-abuse enforcement to avoid increasing origin bandwidth. Added unpaginated sales coverage and bounded GraphQL telemetry from executed pagination/ID arguments, including GET variables and APQ. Telemetry now prefers dedicated `ANTI_ABUSE_REDIS_*` or existing private `CACHE_REDIS_*` settings before legacy shared Redis. Rollout remains observational; cache hits need separate edge controls.

- Made PoW conditional on current suspicious behavior: clean clients (risk <= 0.5), including unchanged desktop apps, can access protected data without sessions even in enforcement mode. Suspicious clients require a recent valid session, confirmed abuse retains tarpitting, and historical token scores no longer prevent recovery after risk clears. Updated public docs and OpenAPI to make PoW authentication conditional while preserving existing account requirements.

- Fixed anti-abuse fingerprint spoofing through client-supplied `cf-ja3-hash`/`cf-ja4` headers. Forwarded bot headers are now ignored unless explicitly enabled with authenticated edge forwarding and Cloudflare's managed Bot Management transform; corrected rollout instructions because request-header Transform Rules cannot remove these reserved headers.

- Added opt-in transport/session anti-abuse protection with `POST /auth/challenge`, fingerprint-bound HMAC/PoW sessions, asynchronous Redis sliding-window scoring across rotating IPs/UAs, and HTTP 200 session challenges or bounded tarpits with truncated responses. Enforcement protects catalog/pagination/GraphQL routes, bypasses their legacy IP limits and shared caching, and optionally adds signed synthetic item canaries. Added rollout/client documentation, OpenAPI contracts, tests, and a latency benchmark; defaults remain off until clients and edge forwarding are configured.

- Capped anonymous `GET /offers` at 5 requests per minute per client IP (`RATE_LIMIT_OFFERS_LIST_PER_MINUTE`). The counter is keyed by client identity instead of the request URL, so changing or adding query parameters cannot reset the quota, and the limiter runs on the list handler itself so encoded path variants cannot skip it; throttled responses are `429` with `Retry-After`.

- Fixed the in-process rate-limit fallback to apply the configured window when Redis is unavailable; previously its counters never expired, so a Redis outage could block a client permanently.

- Reverted the compact offer cards, item projections, profile pagination, seller caps, multisearch price removal, and price-history limits after frontend compatibility issues; list endpoints return full offer documents again. Compression, caching, rate limiting, and GraphQL APQ remain. Response-cache keys are versioned so old compact payloads are no longer served after deploy.

- Split GraphQL rate limits by method: cacheable GET/APQ gets 1200/minute (`RATE_LIMIT_GRAPHQL_GET_PER_MINUTE`) while uncached POST gets 120/minute (`RATE_LIMIT_GRAPHQL_POST_PER_MINUTE`). Raised the general limit to 1200/minute and namespaced every limiter's Redis counter so general, search, GraphQL GET/POST, heavy, and bulk requests no longer share one bucket.

- Added GraphQL GET support with Automatic Persisted Queries (Redis-backed hash store with local fallback), Apollo cache-control hints, and CDN-friendly `Cache-Control`/`CDN-Cache-Control` headers for hash URLs; GraphQL POST responses are `no-store`.

- Compressed text responses at the origin and added explicit `Cache-Control` / `CDN-Cache-Control` headers for public GET endpoints; documented the required Cloudflare cache rules, bot controls, and path-normalised analytics in `docs/edge-caching.md`.

- Added Redis-backed anonymous rate limits for general, expensive, and bulk routes with fail-open local fallback, `429` responses, and `Retry-After` headers.

- Added an `X-Route-Template` response header so edge and origin analytics can group id-bearing routes such as `/offers/{id}` and `/profiles/{id}`.

- Changed offer list endpoints to return compact offer cards by default; pass `expand=true` to receive the previous full offer documents.

- Added `GET /search/v2/search`, added `facets=minimal|full|none` to search v2 (default `minimal`), reduced facet bucket sizes, and changed the legacy `POST /search` route to return `410 Gone`.

- Capped GraphQL list page sizes, added query depth/alias/size validation, and made introspection opt-in in production via `GRAPHQL_INTROSPECTION=true`.

- Paginated profile achievements, capped seller offer lists by default, removed the multi-region `prices` map from multisearch offer hits, reduced offer suggestions and price-history payloads, and re-enabled the offer overview response cache.

- Extended generated OG image caching with versioned immutable URLs and longer edge TTLs.

- Added an optional private Redis response cache with bounded, fail-open operations while preserving shared OAuth state, saved searches, and achievement refresh coordination on the existing Redis.

- Restored search v2 response cache reads, isolated normalized pagination in cache keys, and kept release-date search keys stable as time advances.

- Added `GET /offers/{id}/requirements` for resolved Windows and macOS technical requirements, including validated DLC inheritance.

- Added PNG and WebP sandbox OG database summaries with offers, items, asset counts, and the sandbox's last update; allowed sandbox OG paths in `robots.txt` and shared the Takumi renderer with offer cards.

- Redesigned offer OG cards as database summaries with regional price, catalog update date, and latest download size; added `GET /offers/{id}/og.webp` alongside the existing PNG route using Takumi rendering, and allowed offer/item OG image paths in `robots.txt`.

- Reorganized the API docs around developer tasks, added request examples and practical route guidance, and redirected retired guide URLs.

- Enforced offer country restrictions before current-price cache reads, omitted unavailable regions from regional pricing, and preserved access to historical observations after current prices are retired.

- Added validated detected-build technology filtering and documented technology facet counts to `POST /search/v2/search`.
- Routed Epic Store GraphQL profile requests through Node's core HTTP transport with the current Epic Games Launcher identity to avoid Cloudflare challenges against Undici.
- Routed offer, item, and achievement regeneration requests through the signed Temporal job API while preserving existing public endpoint contracts and achievement cooldowns.
- Fixed empty changelog searches to return the latest canonical MongoDB records instead of waiting for OpenSearch indexing.
- Replaced bulk catalog exports with `POST /catalog/hydrate` schema v2, which streams independently bounded, content-aware root graphs directly from authoritative collections for incremental local-first clients.
- Added idempotent catalog resolver indexes and an explicit confirmation-gated command for removing legacy materialized catalog collections after rollout verification.
- Added `POST /builds/resolve-launcher-records` for resolving bounded, path-free Windows manifest metadata to normalized Epic Games Launcher records without guessing ambiguous catalog, asset, or parent relationships.
- Replaced production-captured route snapshots in pull-request CI with deterministic fixture tests and a scheduled public API smoke test that requires no production credentials.
- Added `priceUpdatedAt` sorting to `POST /search/v2/search` for ordering offers by the selected region's latest price update.
- Added `expiryDate` to the GraphQL `Offer` schema.
- Added `GET /builds/{id}/tree` for lazily expanding build manifest directories with recursive directory file and byte totals.
- Fixed build snapshot comparisons and file queries to use the legacy and verified manifest path indexes instead of scanning all files by path.
- Added verified build-manifest history and file comparison endpoints, sanitized build responses, bounded build query validation, and correct historical size fallbacks.
- Hardened build comparisons with Mongo-compatible path ordering, bounded offsets, consistent sanitized Build DTOs, aggregated install options, and exact OpenAPI response contracts.
- Added `POST /search/natural-language` to rank offer vectors with Cloudflare Workers AI and Vectorize, then hydrate the matching offer documents from MongoDB.
- Added public cache headers to sandbox offer list responses so edge caches can absorb repeated crawler traffic.
- Updated Aikido Zen firewall to 1.8.29 and preloaded instrumentation for native ESM server startup.
- Added anonymous Aikido user and rate-limit grouping from Cloudflare client IP and User-Agent fingerprints.
- Sanitized Epic Store GraphQL upstream error logging, detected Cloudflare challenge responses, and sent consistent Epic Store request headers for profile lookups.
- Switched the Google deployment Dockerfile from Bun to Node.js 26 with direct pnpm installation and noninteractive frozen builds for production runtime alignment.
- Added a PowerShell helper script for quoting dotenv values before pasting them into deployment environments.
- Made OpenSearch client configuration lazy and added clear errors for missing, blank, or partial credentials.
- Reduced normal request-path logging volume, removed offer RAM usage logs, and added debug-level request logging with Cloudflare location headers.
- Decoupled production deployment from the live MongoDB integration job while keeping build, docs, and release checks as deploy gates.
- Increased the route snapshot test setup timeout to reduce CI failures during slow live MongoDB connections.
- Removed Redis caching from sitemap XML responses to avoid storing large generated sitemap payloads in Redis.
- Reduced public sitemap crawl fan-out by publishing canonical offer and item URLs instead of every localized or section URL.
- Removed volatile sitemap index timestamps so sitemap responses remain stable and edge-cacheable.
- Added `locale` overlays for REST and GraphQL offer DTO responses, including exact-locale fallback metadata.
- Normalized free-game promotion responses so `countriesBlacklist`, `giveaway.offerId`, and `giveaway.platform` keep a stable shape.
- Documented changelog context/search enrichment fields and made changelist list context enrichment use the shared safe resolver.
- Fixed changelog search responses to hydrate old/new change values and made changelist detail context enrichment more resilient.
- Added a public GraphQL `profile(id)` query for profile identity, highlights, featured games, achievements, and recent activity.
- Fixed GraphQL profile achievements to read Epic unlocked achievement names, descriptions, and icon links from stored achievement metadata.
- Added a GraphQL `sandboxHub` query that aggregates sandbox product data for user-facing product pages.
- Added CodeRabbit configuration to enforce changelog updates and docs/OpenAPI coverage for public endpoint structure changes.
- Tightened the release policy so user-facing and maintainer-facing changes require `CHANGELOG.md` entries.
- Added an API-owned OpenAPI contract for the first public REST documentation slice.
- Added an in-repo Fumadocs docs app scaffold under `apps/docs`.
- Added OpenAPI, route coverage, README command, and lightweight release policy checks.
