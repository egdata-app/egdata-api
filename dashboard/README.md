# egdata Developer Portal & Edge API Gateway (`dashboard/`)

Cloudflare Worker full-stack project implementing:

1. **Developer Portal SPA** (`TanStack Router` + `React Aria Components` styled in the Epic Games Store / `egdata.app` dark palette).
2. **Epic Games OAuth 2.0 Authentication** (`https://www.epicgames.com/id/authorize` + HTTP Basic token exchange against `https://api.epicgames.dev/epic/oauth/v2/token` + `userInfo`, matching `egdata-app/egdata`).
3. **Zero-Latency Edge API Key Proxy** (`worker/proxy.ts`):
   - Validates `X-API-Key` at the Cloudflare edge using an in-isolate memory cache (`30s`) + **Workers KV** (`cacheTtl: 60`) backed by **Cloudflare D1** as the relational source of truth.
   - Enforces fine-grained per-key permissions (**IPv4/IPv6 CIDR allowlists**, **CORS Origin patterns**, **Endpoint path globs**, **HTTP methods**, **Catalog scopes**, and **Expiration**).
   - Enforces per-key rate limits (`120` / `1,200` / `6,000` RPM) in-memory at each Cloudflare PoP via **Workers Rate Limiting bindings**.
   - Strips `X-API-Key` before calling `fetch()` upstream so **all valid keys share the exact same Cloudflare CDN Cache & ETag `304` revalidation** without cache fragmentation.
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
   ```
   *(Ensure `https://developers.egdata.app/_dashboard/api/auth/epic/callback` is added to your Epic Games Developer Portal redirect URIs.)*

4. Build & deploy:
   ```sh
   pnpm deploy
   ```
