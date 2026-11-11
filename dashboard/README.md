# egdata Developer Portal & Edge API Gateway (`dashboard/`)

Cloudflare Worker full-stack project implementing:

1. **Developer Portal SPA** (`TanStack Router` + `React Aria Components` styled in the Epic Games Store / `egdata.app` dark palette).
2. **Epic Games OAuth 2.0 Authentication** (`https://www.epicgames.com/id/authorize` + HTTP Basic token exchange against `https://api.epicgames.dev/epic/oauth/v2/token` + `userInfo`, matching `egdata-app/egdata`).
3. **Edge API Gateway** (`worker/proxy.ts`):
   - Validates `X-API-Key` at the Cloudflare edge using an in-isolate memory cache (`30s`) + **Workers KV** (`cacheTtl: 60`) backed by **Cloudflare D1** as the relational source of truth.
   - Enforces fine-grained per-key permissions (**IPv4/IPv6 CIDR allowlists**, **CORS Origin patterns**, **Endpoint path globs**, **HTTP methods**, **Catalog scopes**, and **Expiration**).
   - Enforces per-key legacy rate limits (`120` / `1,200` / `6,000` RPM) in-memory at each Cloudflare PoP via **Workers Rate Limiting bindings**. Version 1 uses exact global quotas in a SQLite-backed `ApiKeyRateLimiter` Durable Object instead: one RPC per request combines the global and any expensive-operation policy, one state row is written only on admission, and over-limit requests return Problem Details before the VM. The immutable object namespace is selected per `RATE_LIMIT_ENVIRONMENT` and internal key ID; never use the raw key as the object name.
   - Forwards the full path and query to the dedicated HTTPS origin with a private origin token, strips client API keys, preserves user JWTs and conditional requests, and streams bodies without buffering. CDN caching requires explicit configuration; stripping API keys alone does not enable caching.
   - Records `0ms` fire-and-forget telemetry to **Workers Analytics Engine** (`egdata_api_usage`).
4. **Rate Limit Upgrade Requests via Cloudflare Email Service** (`env.EMAIL.send` binding).

## Local Development

```sh
# From repository root:
pnpm dashboard:dev
```

Open `http://localhost:4002`. On `localhost` when `EPIC_CLIENT_ID` is not set in `.dev.vars`, clicking **Continue with Epic Games** automatically signs in with a local Epic developer sandbox profile so you can test key creation, CIDR/Origin policies, `/proxy/*` edge requests, analytics charts, and upgrade request forms immediately.

## Production Setup & Secrets

1. Create your D1 database and KV namespace:
   ```sh
   cd dashboard
   npx wrangler d1 create egdata-dashboard-db
   npx wrangler kv namespace create API_KEYS_KV
   ```
   Update `database_id` and `id` in `dashboard/wrangler.jsonc`, then apply migrations:
   ```sh
   pnpm db:migrate:remote
   ```

2. Onboard your sending domain for Cloudflare Email Service:
   ```sh
   npx wrangler email sending enable egdata.app
   ```

3. Set Worker secrets (`dashboard/.dev.vars` locally, `wrangler secret put` in production):
   ```sh
   npx wrangler secret put EPIC_CLIENT_ID
   npx wrangler secret put EPIC_CLIENT_SECRET
   npx wrangler secret put DASHBOARD_SESSION_SECRET
   npx wrangler secret put CF_ACCOUNT_ID
   npx wrangler secret put CF_ANALYTICS_API_TOKEN
   npx wrangler secret put ANTI_ABUSE_EDGE_SECRET
   npx wrangler secret put ORIGIN_AUTH_TOKEN
   ```
   *(Ensure `https://devs.egdata.app/_dashboard/api/auth/epic/callback` is added to your Epic Games Developer Portal redirect URIs.)*

4. Build & deploy:
   ```sh
   pnpm deploy
   ```

## Versioned v1 gateway

The staged versioned API is exposed at `https://devs.egdata.app/proxy/v1` and requires an API key for every data operation. `api.egdata.app` routing is unchanged, and Smart Placement is explicitly disabled so quota latency measurements reflect a normal regional deployment.

- The Worker authenticates the key, maps the operation to an existing permission scope, evaluates IP/Origin/method/path restrictions against `/v1/...`, and calls the `ApiKeyRateLimiter` Durable Object once. Only after admission does it forward trusted key identity (`x-egdata-key-id`, tier, project, request ID, Worker token) to the origin. Caller-supplied internal headers and cookies are stripped.
- `ApiKeyRateLimiter` is a SQLite-backed Durable Object declared in `wrangler.jsonc` with an additive migration (`new_sqlite_classes`). Objects are named `v1:<RATE_LIMIT_ENVIRONMENT>:<internal key id>`; the raw API key is never used as an object name or stored in the object. Keep `RATE_LIMIT_ENVIRONMENT` stable per deployment and never rename the class or delete the migration; either change resets the counters. Rollback should remove v1 exposure (route or origin mount) rather than deleting the Durable Object namespace.
- Apply the Worker deployment once so Wrangler creates the namespace, then deploy origin support before enabling v1 traffic. Run `pnpm v1:indexes` against the catalog database and `pnpm v1:search-mappings` (add `--apply` where a mapping can be added safely) before exposing affected search endpoints.
- Origin configuration: `V1_CURSOR_SECRET` (dedicated at least 32-byte cursor signing secret), `V1_WORKER_TOKEN` (must match the Worker's `ORIGIN_AUTH_TOKEN`; if unset the origin falls back to `ORIGIN_AUTH_TOKEN`), and `V1_PUBLIC_BASE_URL` (absolute base for sitemap indexes and normalized POST-search redirects, for example `https://devs.egdata.app/proxy/v1` in staging). `V1_REQUIRE_WORKER_AUTH=false` is for local tests only.
- Shared HTTP caching stays disabled for v1 (`private, no-cache`; CDN `no-store`). Every v1 data request, including conditional revalidation, passes key authentication and exact quota admission. Origin response caching and ETags remain internal/private.
- Verify staging with authenticated JSON, cursor traversal, batch reads, one image, and one sitemap through `/proxy/v1`; inspect `X-Request-Id`, `RateLimit`, `RateLimit-Policy`, 429 `Retry-After`, RFC 9457 error bodies, Analytics Engine outcomes, and actual Durable Object request/write billing. Use `pnpm v1:latency` with `V1_BENCH_URL`, `V1_BENCH_API_KEY`, and `V1_BENCH_REGION` from Europe, North America, and Asia to record p50/p95 with Smart Placement off. Planning estimate only: 27.14M monthly non-preflight requests imply about $4.05 in incremental Durable Object request charges assuming unused included allowances; one counter-row write per admission remains below the included 50M writes. Measure actual duration and writes in staging rather than treating this as a total-cost guarantee.

## Dedicated VM origin

The dashboard is hosted at `https://devs.egdata.app`, with `https://egdata-dashboard.snpm.workers.dev` retained for testing. The gateway is **staged only**: `/proxy/*` → `https://origin-api.egdata.app/*` → Traefik → `egdata-api-nywbml:4000` on the `egdata-dockploy` VM (`europe-west1-d`). `api.egdata.app` keeps its existing DNS and routing; `wrangler.jsonc` attaches only the dashboard custom domain. Test with `/proxy/health` or `/proxy/countries`. Hostname routing is ready for a future cutover and runs before dashboard/local-prefix routes.

- Create a **DNS-only** A record for `origin-api.egdata.app` pointing to the VM and add that HTTPS domain to the API application in Dokploy. Do not put a public CDN cache in front of this origin hostname: cache hits there could skip origin authentication.
- Generate a cryptographically random token (at least 32 random bytes). Store the same `ORIGIN_AUTH_TOKEN` in the API application's persisted Dokploy environment and in the Worker with `wrangler secret put`. Never commit it, log it, or send it to browser clients. It is separate from `ANTI_ABUSE_EDGE_SECRET`.
- Keep `ORIGIN_AUTH_REQUIRED=false` during staging. The first API middleware protects every path on `ORIGIN_AUTH_HOST` (default `origin-api.egdata.app`), including health, OAuth, preflight and GraphQL. Other hostnames retain existing behavior, even when a token is configured. Missing/incorrect tokens on a protected request return uncacheable `403 ORIGIN_ACCESS_DENIED`; missing server configuration returns `503 ORIGIN_NOT_CONFIGURED`. Host matching uses the actual URL hostname, not caller-controlled forwarding headers. For local proxy testing, configure the same token on both processes, set `ORIGIN_AUTH_REQUIRED=true` on the local API, and use `UPSTREAM_API_ORIGIN=http://localhost:4000`.
- The Worker requires an explicit origin and token, overwrites caller-supplied internal headers, and never follows origin redirects. It returns uncacheable `503 ORIGIN_NOT_CONFIGURED` for invalid configuration and `502 ORIGIN_UNAVAILABLE` for connection failures. `Authorization` user JWTs pass through unchanged.
- `REQUIRE_API_KEY=false` preserves current public client access for this infrastructure rollout. Enable client API-key enforcement separately after portal onboarding. `ALLOW_FIRST_PARTY_ORIGINS` is a browser convenience, not proof of first-party identity.

Verify that public `/health` and a data endpoint still work, the staging Worker reaches the origin, and direct requests to the dedicated origin are rejected. Keep port 4000 unpublished. Internal monitors using the dedicated hostname must supply the token. During staging the existing public API remains intentionally accessible; hostname protection alone does not force all traffic through the Worker.

Only after an explicitly approved production cutover, add `{ "pattern": "api.egdata.app/*", "zone_name": "egdata.app" }` to `routes`, verify the public gateway, and set `ORIGIN_AUTH_REQUIRED=true` to enforce the token across all origin hostnames. Verify CDN caching separately before moving production traffic; caching against the new upstream is not guaranteed by forwarding headers. Do not enable global enforcement before the Worker route is active.

For rollback after a future cutover, disable global enforcement before removing the Worker route. Keep Dokploy environment/domain settings persisted and commit/deploy this middleware before subsequent automated builds; a deployment from older source will not enforce it.
