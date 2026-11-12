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
4. **Rate Limit Upgrade Requests** with email notifications and an administrator review queue.

## Usage and platform overview

Usage keeps the existing dashboard theme and adds request, processing-time, and
error charts; request-weighted p50/p95/p99; previous-period comparisons; response
status, cache, and access-check breakdowns; and searchable, sortable, paginated
tables for endpoints, applications, keys, origins, IPs, and user agents. Endpoint
details retain the selected app/key/time window. CSV export traverses every
matching page with a fixed end time and escapes spreadsheet formulas. Late
analytics ingestion may still change results within that window.

Administrators can select **All projects** on both Overview and Usage. This
includes recorded gateway traffic from every owner, with app/key names and
rankings of endpoints and keys hitting limits. The scope is shared between the
two screens during navigation. Changing scope or the selected project clears
incompatible Usage drilldown filters. Normal developers remain owner-scoped;
project/key query parameters cannot widen that boundary. Each global request
checks the current D1 `user_roles` admin role, not session role claims. Names
are enriched from D1 without exposing key secrets, hashes, or prefixes.

Private session-authenticated reporting endpoints (outside the public API
OpenAPI/operation registry):

- `GET /_dashboard/api/analytics`: summary, previous totals, time series,
  status/cache/access breakdowns and five app/key/endpoint highlights.
- `GET /_dashboard/api/analytics/table`: one page of a dimension, with
  `{ rows, hasMore, offset, end, source }`.

Both accept `hours` (integer 1–720, default 24), `scope` (`project` by default,
  or admin-only `all`), optional `projectId`, `keyId`, exact `route`, HTTP
`method`, and ISO UTC `end`. The optional end time must be within the past
60 days or at most one minute in the future. Tables also accept `dimension`
(`endpoints`, `projects`, `keys`, `origins`, `ips`, `userAgents`), `search`
(at most 180 characters), `sort` (`requests`, `cacheHitRate`, `rateLimited`,
`blockedPolicy`, `errorRate`, `avgLatencyMs`, `p95LatencyMs`), `direction`
(`asc`/`desc`), `offset` (0–1,000,000), and `limit` (1–100, default 25).
App/key search matches names or IDs. Invalid parameters return 400; unsigned
requests return 401; unauthorized global scope returns 403; analytics service
failures return 503 without leaking upstream details.

Remote queries use Analytics Engine sampling weights, including weighted
percentiles. Counts may be estimates. Equal-length previous/current windows
are adjacent and non-overlapping. Buckets are UTC-aligned (5 minutes for up to
6 hours, hourly for up to 48 hours, 6-hourly for up to 7 days, daily otherwise);
the UI displays the viewer's timezone. Complete remote results fill empty time
buckets. The bounded in-isolate preview buffer is labeled incomplete and never
fabricates historical zeroes or previous-period comparisons. Remote failures
remain errors instead of silently substituting that buffer.

HTTP errors include all 4xx/5xx, including 429s; the error chart separates 429s
from other errors. Access allowed does not mean the upstream returned success.
Processing time includes gateway checks and is not end-to-end client latency.
The dashboard covers instrumented gateway requests, not uninstrumented origin
traffic. No quota enforcement or public REST/GraphQL behavior changes here.

## Administrator roles and request reviews

Apply `0004_limit_request_reviews.sql` before deploying this Worker/UI. It adds
`user_roles(user_id, role, created_at)` alongside the existing `users` table,
project-level custom RPM, and request review audit fields. The migration grants
`admin` to existing Epic account `ac7b3a70e3ce4652b49c38e648001d9e`.
It does not create a synthetic user. In a fresh database, sign in first and then
insert the role for that exact account ID. Users without a role remain ordinary
developers; email addresses, display names, and cookie role claims never grant
administrator access. Roles are checked in D1 on every admin request.

```sql
-- Grant only after verifying the intended user's Epic account ID.
INSERT INTO user_roles(user_id, role) VALUES ('<epic-account-id>', 'admin');
-- Revoke without waiting for the user's session to expire.
DELETE FROM user_roles WHERE user_id='<epic-account-id>' AND role='admin';
```

Admins see **Review limit requests** on **Rate Limits**, across all projects.
The queue has Pending / Approved / Declined filters, 25-request pages, request
details, and an explicit confirmation with an optional note visible to the
requester. Approval applies the requested RPM to existing non-revoked keys and
to future keys; custom requests use the enterprise tier plus the exact custom
RPM. The API console reads the project's current limit on each request. Legacy
gateway traffic continues to use tier defaults, and expensive v1 policy caps
remain unchanged. Declining leaves quotas unchanged.

The decision, reviewer ID, timestamp, note, project quota, and existing key
quotas are committed in one D1 transaction. A second decision returns 409.
Cache invalidation follows the commit; existing keys can take up to five minutes
to refresh even if KV invalidation fails. Request admission and review never
reset quota counters. The review flow sends no additional emails.

Private session-authenticated endpoints (not part of the public API contract):

- `GET /_dashboard/api/auth/session` includes `isAdmin` and project `customRpm`.
- `GET /_dashboard/api/admin/limit-requests?status=pending&offset=0` returns
  `{ requests, hasMore }`, sorted oldest first. Valid statuses: pending, approved,
  declined; offset: integer 0–1,000,000. Default status: pending; page size: 25.
- `POST /_dashboard/api/admin/limit-requests/:requestId/review` accepts
  `{ decision: "approved" | "declined", note?: string }` (note: at most 2,000
  characters), and returns `{ request, quotaPropagationSeconds }`.
- Admin endpoints require a valid session (401), the D1 admin role (403), and
  same-origin mutations (403). Invalid fields return 400, missing requests 404,
  and already-reviewed requests 409. The existing owner-only request history
  includes `reviewedBy`, `reviewedAt`, and `reviewNote`.

For email notifications, `ADMIN_EMAIL` must be a verified Cloudflare destination
address. An Email Routing alias pointing to a verified inbox is not itself a
verified destination.

## Local Development

```sh
# From repository root:
pnpm dashboard:dev
```

Open `http://localhost:4002`. On `localhost` when `EPIC_CLIENT_ID` is not set in `.dev.vars`, clicking **Continue with Epic Games** automatically signs in with a local Epic developer sandbox profile so you can test key creation, CIDR/Origin policies, `/proxy/*` edge requests, analytics charts, and upgrade request forms immediately.

Local demo authentication requires `ENABLE_DEV_AUTH=true` and a localhost request. Deployed sessions always require `DASHBOARD_SESSION_SECRET` (at least 16 characters). Apply local migrations before starting the dashboard.

Key revocation and permission changes can take up to five minutes to propagate
through the bounded metadata cache. Credentials are never stored in that cache.

## Production Setup & Secrets

1. Create your D1 database and KV namespace:
   ```sh
   cd dashboard
   npx wrangler d1 create egdata-dashboard-db
   npx wrangler kv namespace create API_KEYS_KV
   ```
   Set the KV namespace `id` in `dashboard/wrangler.jsonc`. Keep D1 configured by
   `database_name` without `database_id`: Wrangler resolves the existing database
   by name on first deployment and inherits the matching deployed `DB` binding
   on subsequent deployments. This avoids regenerating the D1 binding, which can
   fail with Cloudflare error `10021` even while the database is healthy. The
   existing dashboard database is `c0ea5b25-0361-4487-95cc-58803bdeb22d`; do not
   replace it or change `database_name` to work around a deployment failure.
   Remote D1 commands still require an explicit ID. `wrangler.migrations.jsonc`
   pins that ID for `db:migrate:remote`; use `--config wrangler.migrations.jsonc`
   for other remote D1 commands. For a new account, set the newly created database
   ID in that migrations configuration. Local development and local migrations both use
   the name-based binding in `wrangler.jsonc`. Then apply migrations:
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
   pnpm run deploy
   ```

## Versioned v1 gateway

The staged versioned API is exposed at `https://devs.egdata.app/proxy/v1` and requires an API key for every data operation. `api.egdata.app` routing is unchanged, and Smart Placement is explicitly disabled so quota latency measurements reflect a normal regional deployment.

- The Worker authenticates the key, maps the operation to an existing permission scope, evaluates IP/Origin/method/path restrictions against `/v1/...`, and calls the `ApiKeyRateLimiter` Durable Object once. Only after admission does it forward trusted key identity (`x-egdata-key-id`, tier, project, request ID, Worker token) to the origin. Caller-supplied internal headers and cookies are stripped.
- `ApiKeyRateLimiter` is a SQLite-backed Durable Object declared in `wrangler.jsonc` with an additive migration (`new_sqlite_classes`). Objects are named `v1:<RATE_LIMIT_ENVIRONMENT>:<internal key id>`; the raw API key is never used as an object name or stored in the object. Keep `RATE_LIMIT_ENVIRONMENT` stable per deployment and never rename the class or delete the migration; either change resets the counters. Rollback should remove v1 exposure (route or origin mount) rather than deleting the Durable Object namespace.
- Apply the Worker deployment once so Wrangler creates the namespace, then deploy origin support before enabling v1 traffic. Run `pnpm v1:indexes` against the catalog database and `pnpm v1:search-mappings` (add `--apply` where a mapping can be added safely) before exposing affected search endpoints.
- Origin configuration: `V1_CURSOR_SECRET` (dedicated at least 32-byte cursor signing secret), `V1_WORKER_TOKEN` (must match the Worker's `ORIGIN_AUTH_TOKEN`; if unset the origin falls back to `ORIGIN_AUTH_TOKEN`), and `V1_PUBLIC_BASE_URL` (absolute base for sitemap indexes and normalized POST-search redirects, for example `https://devs.egdata.app/proxy/v1` in staging). `V1_REQUIRE_WORKER_AUTH=false` is for local tests only.
- Shared HTTP caching stays disabled on outgoing v1 client responses (`private, no-cache`; CDN `no-store`) so browsers and intermediaries never bypass authentication or per-key quota admission. Inside the Worker, after API key verification, permission checks, and Durable Object quota admission succeed, cacheable GET/HEAD operations read from and populate Cloudflare's Cache API (`caches.default`) with normalized URLs, stripped per-key/CORS headers, and conditional `ETag` (`304 REVALIDATED`) support.
- Verify staging with authenticated JSON, cursor traversal, batch reads, one image, and one sitemap through `/proxy/v1`; inspect `X-Request-Id`, `RateLimit`, `RateLimit-Policy`, 429 `Retry-After`, RFC 9457 error bodies, Analytics Engine outcomes, and actual Durable Object request/write billing. Use `pnpm v1:latency` with `V1_BENCH_URL`, `V1_BENCH_API_KEY`, and `V1_BENCH_REGION` from Europe, North America, and Asia to record p50/p95 with Smart Placement off. Planning estimate only: 27.14M monthly non-preflight requests imply about $4.05 in incremental Durable Object request charges assuming unused included allowances; one counter-row write per admission remains below the included 50M writes. Measure actual duration and writes in staging rather than treating this as a total-cost guarantee.

## Dedicated VM origin

### Temporary API console sessions

The API Reference offers **Start 10-minute session** for the selected project.
No existing API key secret is recovered or persisted in the browser. The opaque
console credential stays in page memory, expires server-side after ten minutes,
and requires the same signed-in dashboard cookie on every request. It is accepted
only on the configured dashboard origin under `/proxy/v1/`, with same-origin
browser request metadata. An Origin header by itself is not authentication.
Project ownership and the current project tier are checked on each console request.

All sessions for a project use one stable `console_<projectId>` quota identity.
Renewing a session, opening another tab, or signing in again cannot reset its
minute counters or expensive-operation limits. Analytics includes these requests
under **API console**, and durable endpoint usage includes them for alerts.
Console credentials are stored only as hashes in `console_sessions`, separately
from public API keys. Their lifetime is independent of retained usage history.
Ending a session revokes it; logout revokes all console sessions for that dashboard
login. Project changes and leaving the explorer clear credentials and request
revocation. Expired records are removed by the daily scheduled cleanup.

Apply D1 migrations `0003_console_sessions.sql` and
`0005_dashboard_session_revocations.sql` before deploying this Worker/UI change.
Dashboard logout revocation is stored in D1 so it is visible to auth checks
without KV's cross-location cache delay. No new secret or VM deployment is
needed. Existing public API keys and
legacy endpoints retain their authentication and routing. Static v1 registry
paths now take precedence over parameter paths for quota/usage attribution
(for example, `/v1/offers/genres` is `listOfferGenres`, not `getOffer`).

The dashboard is hosted at `https://devs.egdata.app` (`workers_dev` is disabled so `/_dashboard/api` is served only on the configured custom domain). The gateway is **staged only**: `/proxy/*` → `https://origin-api.egdata.app/*` → Traefik → `egdata-api-nywbml:4000` on the `egdata-dockploy` VM (`europe-west1-d`). `api.egdata.app` keeps its existing DNS and routing; `wrangler.jsonc` attaches only the dashboard custom domain. Test with `/proxy/health` or `/proxy/countries`. Hostname routing is ready for a future cutover and runs before dashboard/local-prefix routes.

- Create a **DNS-only** A record for `origin-api.egdata.app` pointing to the VM and add that HTTPS domain to the API application in Dokploy. Do not put a public CDN cache in front of this origin hostname: cache hits there could skip origin authentication.
- Generate a cryptographically random token (at least 32 random bytes). Store the same `ORIGIN_AUTH_TOKEN` in the API application's persisted Dokploy environment and in the Worker with `wrangler secret put`. Never commit it, log it, or send it to browser clients. It is separate from `ANTI_ABUSE_EDGE_SECRET`.
- Keep `ORIGIN_AUTH_REQUIRED=false` during staging. The first API middleware protects every path on `ORIGIN_AUTH_HOST` (default `origin-api.egdata.app`), including health, OAuth, preflight and GraphQL. Other hostnames retain existing behavior, even when a token is configured. Missing/incorrect tokens on a protected request return uncacheable `403 ORIGIN_ACCESS_DENIED`; missing server configuration returns `503 ORIGIN_NOT_CONFIGURED`. Host matching uses the actual URL hostname, not caller-controlled forwarding headers. For local proxy testing, configure the same token on both processes, set `ORIGIN_AUTH_REQUIRED=true` on the local API, and use `UPSTREAM_API_ORIGIN=http://localhost:4000`.
- The Worker requires an explicit origin and token, overwrites caller-supplied internal headers, and never follows origin redirects. It returns uncacheable `503 ORIGIN_NOT_CONFIGURED` for invalid configuration and `502 ORIGIN_UNAVAILABLE` for connection failures. `Authorization` user JWTs pass through unchanged.
- `REQUIRE_API_KEY=false` preserves current public client access for this infrastructure rollout. Enable client API-key enforcement separately after portal onboarding. `ALLOW_FIRST_PARTY_ORIGINS` is a browser convenience, not proof of first-party identity.

Verify that public `/health` and a data endpoint still work, the staging Worker reaches the origin, and direct requests to the dedicated origin are rejected. Keep port 4000 unpublished. Internal monitors using the dedicated hostname must supply the token. During staging the existing public API remains intentionally accessible; hostname protection alone does not force all traffic through the Worker.

Only after an explicitly approved production cutover, add `{ "pattern": "api.egdata.app/*", "zone_name": "egdata.app" }` to `routes`, verify the public gateway, and set `ORIGIN_AUTH_REQUIRED=true` to enforce the token across all origin hostnames. Verify CDN caching separately before moving production traffic; caching against the new upstream is not guaranteed by forwarding headers. Do not enable global enforcement before the Worker route is active.

For rollback after a future cutover, disable global enforcement before removing the Worker route. Keep Dokploy environment/domain settings persisted and commit/deploy this middleware before subsequent automated builds; a deployment from older source will not enforce it.
