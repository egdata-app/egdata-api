# egdata API

TypeScript REST API and GraphQL server for Epic Games Store data used by egdata.app.

## Development

Install dependencies:

```sh
pnpm install
```

Run the API locally on port `4000`:

```sh
pnpm dev
```

Open:

```txt
http://localhost:4000
```

Start Redis when working with routes that depend on cache:

```sh
sudo service redis-server start
```

Response caches can use a separate Redis on the API's private network:

```txt
CACHE_REDIS_HOST=egdata-response-cache-xus1cb
CACHE_REDIS_PORT=6379
CACHE_REDIS_PASSWORD=... # deployment secret; never commit it
CACHE_REDIS_USER=default
CACHE_REDIS_TLS=false
```

Without `CACHE_REDIS_HOST`, response caching continues to use the existing
`REDISHOST` / `REDISPORT` / `REDISPASSWORD` connection. When a dedicated cache is
configured, its credentials and TLS settings are independent. Cache connection
failures become misses and failed writes are skipped, with bounded command times.

Keep the existing `REDIS*` settings pointed at shared Redis: OAuth state, saved
search definitions (`q:*`), and achievement refresh status/cooldowns remain there.
Do not use Dokploy's own Redis for application data. The dedicated response cache
may use LRU eviction and can start empty; existing response TTLs still apply.
In Dokploy, keep its external port unset, use a 256 MiB `maxmemory` limit with
`allkeys-lru`, and allow 512 MiB container memory for Redis overhead. For this
disposable cache, disable RDB snapshots and AOF. Removing the `CACHE_REDIS_*`
settings and redeploying rolls the API back to its original Redis connection.

Offer, item, and achievement regeneration routes submit signed jobs to the Temporal job API. Production must provide:

```txt
JOB_API_BASE_URL=https://jobs.egdata.app
JOB_API_KEY_ID=egdata-api
JOB_API_SECRET=... # at least 32 bytes; store only in the deployment secret manager
```

The backend key should be scoped only to `jobs:submit:offer-regen`, `jobs:submit:item-regen`, and `jobs:submit:achievement-refresh`. The API fails closed instead of reporting a successful regeneration when durable workflow acceptance cannot be confirmed.

Natural-language offer search requires a Cloudflare API token with Workers AI Read and Vectorize Read permissions:

```txt
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
VECTORIZE_INDEX_NAME=egdata-offers
```

`VECTORIZE_INDEX_NAME` is optional and defaults to `egdata-offers`. The endpoint uses the same `@cf/baai/bge-base-en-v1.5` embeddings as the backend indexing job.

## Bandwidth Controls

Text responses are gzip-compressed at the origin. Public GET responses also emit
`Cache-Control` and `CDN-Cache-Control` headers; Cloudflare Cache Rules must be
configured to actually cache JSON (see [`docs/edge-caching.md`](docs/edge-caching.md)).

Anonymous rate limits are configurable. Defaults are intentionally conservative
for automated traffic but generous for normal browsing:

```txt
RATE_LIMIT_ENABLED=true
RATE_LIMIT_GENERAL_PER_MINUTE=1200
RATE_LIMIT_GRAPHQL_GET_PER_MINUTE=1200
RATE_LIMIT_GRAPHQL_POST_PER_MINUTE=120
RATE_LIMIT_SEARCH_PER_MINUTE=300
RATE_LIMIT_HEAVY_PER_MINUTE=60
RATE_LIMIT_BULK_PER_MINUTE=10
GRAPHQL_INTROSPECTION=false
```

`RATE_LIMIT_ENABLED=false` disables application limits (useful for local tests).
The rate limiter uses shared Redis with a bounded command timeout and falls back
to an in-process store if Redis is unavailable.

The general limit also applies to every route, so keep
`RATE_LIMIT_GENERAL_PER_MINUTE` at or above the route-specific limits you set.
For example, GraphQL GET is effectively capped by the lower of the general and
`RATE_LIMIT_GRAPHQL_GET_PER_MINUTE` values.

Each limiter uses its own Redis key namespace, so general, search, GraphQL GET,
GraphQL POST, heavy, and bulk requests do not consume each other's counters.

GraphQL additionally caps list page sizes, query depth, aliases, and query size.
Introspection is disabled in production unless `GRAPHQL_INTROSPECTION=true`.
Read queries can use `GET /graphql`, including Apollo Automatic Persisted
Queries; successful GET responses carry CDN cache headers, while POST responses
are `no-store`. See [`docs/edge-caching.md`](docs/edge-caching.md) and the
[GraphQL profile guide](apps/docs/content/docs/graphql-profiles.mdx).

## Catalog Hydration

`POST /catalog/hydrate` streams bounded NDJSON graphs directly from the catalog collections for item, asset, and release-app identifiers. Clients persist only their discovered roots and revalidate with content hashes.

After the direct resolver has been verified, legacy materialized catalog collections can be removed with the explicit confirmation-gated command documented in the catalog hydration guide.

## Build And Checks

```sh
pnpm build
pnpm start
pnpm typecheck
pnpm biome check .
pnpm test
```

## Versioned v1 API

`/v1` is the versioned read-only REST contract. It is staged at `https://devs.egdata.app/proxy/v1`; legacy `api.egdata.app` routing is unchanged until an explicit cutover. v1 requires API keys and exact per-key quotas at the Worker, uses `{ data, meta }` responses, signed forward cursors, and RFC 9457 Problem Details. See `apps/docs/content/docs/versioned-api.mdx` and `dashboard/README.md` for deployment and verification steps.

Maintainer checks:

```bash
pnpm openapi:generate   # regenerates legacy + v1 OpenAPI and the Worker route table
pnpm openapi:check      # rejects undocumented v1 handlers and unexplained public coverage gaps
pnpm docs:check
pnpm changelog:generate
pnpm release:check --base origin/main
```

Origin operators must apply `pnpm v1:indexes` and `pnpm v1:search-mappings` before enabling affected v1 search endpoints. Cursor signing uses the dedicated `V1_CURSOR_SECRET`; Worker provenance uses `V1_WORKER_TOKEN`/`ORIGIN_AUTH_TOKEN`.

## OpenAPI And Docs

The API owns its OpenAPI contract in `src/openapi/**` and generates the committed artifact at `openapi/egdata.openapi.json`.

```sh
pnpm openapi:generate
pnpm openapi:check
pnpm docs:dev
pnpm docs:build
pnpm docs:check
```

The Fumadocs app lives in `apps/docs` and consumes the generated OpenAPI artifact without importing the runtime Hono app.

## Testing

The test suite is split into two tiers:

- **Deterministic tests** — pure helpers and fixture-backed route tests using committed SeaQA offer/item data and mocked infrastructure. These require no live services or credentials and gate pull requests.
- **Live smoke tests** (`tests/live-smoke.test.ts`) — minimal identity and response checks for stable public offer, item, sandbox, and build records. These run on a schedule and can be invoked manually.

```sh
# Full deterministic suite, no service credentials required
pnpm test

# Focused unit and fixture-backed route subset
pnpm test:unit

# Public production smoke checks, no credentials required
pnpm test:live
```

Route documentation coverage is enforced by `pnpm openapi:check`, which discovers Hono routes from source and requires every route to be documented or explicitly classified.

## Release Notes

Public API behavior changes need validated records in `changes/records/`, with every affected stable operation ID, concrete before/after behavior, client actions, and verification. Use `pnpm changelog:new`, `pnpm changelog:generate`, and `pnpm changelog:check --base origin/main`. API/gateway/shared code also needs an impact assessment (`pnpm changelog:assess --base origin/main`), including explicit no-impact reasons. Documentation-only and unrelated maintenance need no public entries. See [release policy](docs/release-policy.md).
