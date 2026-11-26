# Run the Rust API locally

The local migration server runs all 154 documented `/v1` operations and serves
`/graphql` with real service connections. The public gateway still uses Node.

## Crate layout

The HTTP surface is split into layers so unrelated routes compile in parallel:

| Crate | Responsibility |
| --- | --- |
| `egdata-api-state` | `AppState`, `ApiConfig` and SSR telemetry buffering |
| `egdata-http-core` | Middleware stack, `/v1` request context, and handler helpers shared by both surfaces |
| `egdata-openapi` | OpenAPI document builders and contract diffing (no routes) |
| `egdata-routes-v1` | `/v1` handlers and route inventory |
| `egdata-routes-legacy` | Unversioned (`/offers`, `/items`, …) handlers |
| `egdata-api` | Binary, runtime wiring, GraphQL HTTP bridge and tooling CLI |
| `egdata-api-test-support`, `egdata-api-oracle` | Test-only doubles and fixture-oracle replay (dev-dependencies) |

`egdata-routes-v1` and `egdata-routes-legacy` do not depend on each other: any
helper they both use lives in `egdata-http-core`, so Cargo compiles the two
surfaces concurrently. Keep it that way when adding shared code.

From the repository root, using the existing Node checkout's dotenv file:

```powershell
node rust/scripts/dev.mjs --env-file "C:/path/to/egdata-api/.env" --port 4001
```

The launcher uses the checkout's `.env` when present. Both `--env-file path`
and `--env-file=path` resolve relative paths from the directory where you run
the command. The launcher runs the pinned Cargo toolchain from `rust/`. MongoDB certificate
paths in the dotenv file resolve relative to that file. The loader preserves
literal dollar signs in service passwords and MongoDB URIs, just like Node's
`dotenv`. Existing process variables take precedence. Stop the foreground
server with Ctrl+C.

Required settings: `MONGO_URL`, `MONGO_CA`, `MONGO_CERT`, and the existing Redis
settings (`REDISHOST`, `REDISPORT`, `REDISPASSWORD`, optionally `REDISUSER` and
`REDISTLS`). Startup connects to MongoDB before accepting HTTP requests.
During a shared Redis outage, Redis-independent endpoints continue serving and
`/v1/health` returns 503. Shared Redis commands wait for reconnection. A
dedicated response cache treats failed reads as misses and skips failed writes.
If `REDISPORT` has no valid TCP port after JavaScript-style `parseInt`
parsing, the origin still starts, and shared Redis commands return an error.
A configured dedicated cache or telemetry endpoint validates its own settings.
Run `node rust/scripts/test-services.mjs --redis-recovery` from the repository
root to exercise startup, health, queued commands and reconnection in both
origins against disposable MongoDB and Redis instances.
Configuration errors are reported without dumping connection strings or secrets.

The launcher explicitly selects development mode, a public development gateway
token, a development cursor secret, and the `rust:local:response:v2:` Redis cache
prefix. The development launcher binds to loopback. Its startup checks use the existing data stores.

Health is available at [http://127.0.0.1:4001/v1/health](http://127.0.0.1:4001/v1/health).
For a GraphQL smoke check, open [the GraphQL endpoint](http://127.0.0.1:4001/graphql?query=%7B__typename%7D)
with an `Accept: application/json` header. Browsers requesting HTML receive the Apollo landing page.
It checks MongoDB and Redis; it does not certify optional services such as search.
The OpenAPI document is at `/v1/open-api.json`. From `rust/`, run
`cargo run -p egdata-api --bin generate-openapi -- --check --require-handlers`
to check the contract and verify every operation has a registered handler.

Other v1 requests retain the gateway context checks. For this local launcher:

```powershell
$headers = @{
  'x-egdata-origin-token' = 'egdata-rust-local-development'
  'x-egdata-worker-token' = 'egdata-rust-local-development'
  'x-egdata-key-id' = 'key_localdev'
  'x-egdata-key-tier' = 'free'
}
Invoke-RestMethod 'http://127.0.0.1:4001/v1/offers?limit=1' -Headers $headers
```

OpenSearch uses `OPENSEARCH_URL` and its configured credentials. Meilisearch,
Vectorize, Epic, notifications and Job API use the existing adapter environment
variables. Session verification uses `NEON_CONNECTION_URI` and opens a Postgres
connection on the first session lookup. For cookie signing, Better Auth and Rust
use the first key in the comma-separated `BETTER_AUTH_SECRETS` list
(`version:secret` entries). If the list is unset or empty, they use
`BETTER_AUTH_SECRET`, falling back to `AUTH_SECRET`. An invalid key list fails
configuration validation. Public catalog requests continue to work if Postgres
is unavailable or its URI is malformed. Session requests that need a database
lookup return an error in either case.

Quote dotenv passwords containing `#` (for example, `OPENSEARCH_PASSWORD='example#value'`)
so dotenv does not treat part or all of the password as a comment. Restart the API
after changing configuration. With the headers above, search can be checked with:

```powershell
Invoke-RestMethod 'http://127.0.0.1:4001/v1/search?title=Fortnite&limit=2' -Headers $headers
```

For an environment with its own gateway/cursor configuration, invoke the binary
directly from `rust/`:

```powershell
cargo run -p egdata-api --bin egdata-api -- --env-file "C:/path/to/egdata-api/.env" --port 4001
```

This respects process variables over dotenv values. Unlike the development
launcher, it does not supply gateway/cursor credentials or change `NODE_ENV`.
Its response-cache prefix defaults to `rust:local:response:v2:` unless explicitly
configured. To run a staging origin on a container network, set `ORIGIN_AUTH_REQUIRED=true` and supply its gateway token, then pass `--bind 0.0.0.0`. That mode checks the five catalog hydration indexes and shares the Node APQ keyspace. Run `pnpm v1:indexes` as an administrative step before serving versioned catalog traffic.

### Dokploy staging deployment

Create a staging application from `codex/rust-staging`. Select the Dockerfile build type, set the build context to the repository root (`.`), use `Dockerfile.rust`, and point the staging HTTPS domain at container port `4000`. The image supplies the start command.

Configure the staging service connections from the secret store. Mount the MongoDB CA and client certificate at the paths in `MONGO_CA` and `MONGO_CERT`, readable by container UID `65532`. For authenticated search, configure `OPENSEARCH_URL`, `OPENSEARCH_USERNAME` and `OPENSEARCH_PASSWORD`. Use the staging Node origin’s cursor signing secret so both origins can read the same pagination tokens.

Set `ORIGIN_AUTH_TOKEN` and `V1_WORKER_TOKEN` to the staging gateway’s `RUST_SHADOW_TOKEN`. Probe `GET /v1/health` over HTTPS with the `x-egdata-origin-token` header and confirm a 200 response before setting `RUST_SHADOW_ORIGIN` on the separate staging gateway. The default gateway configuration serves `api.egdata.app`.

### Packaged origin verification

From the repository root, run the following in PowerShell with Docker available.

```powershell
docker build -f Dockerfile.rust -t egdata-rust-origin:local-migration .
$env:EGDATA_TEST_ORIGIN_IMAGE = "egdata-rust-origin:local-migration"
node rust/scripts/test-services.mjs --compare-origins
Remove-Item Env:EGDATA_TEST_ORIGIN_IMAGE
node rust/scripts/test-services.mjs llvm-cov --locked --workspace --all-targets --fail-under-lines 98 --fail-under-regions 98 -- --include-ignored
```

CI requires at least 98% workspace line coverage and 98% region coverage. The separate HTTP comparison checks observable parity with Node.

LLVM reports the percentage of instrumented lines and regions executed at least
once across the workspace. A single line can contain multiple regions, such as
a cache-hit expression and a fallback closure. The totals include instrumented
test helpers. Both percentages must reach 100%. The Node fixture and packaged
HTTP comparisons separately check that the two origins agree on their responses.
The coverage command starts authenticated OpenSearch alongside MongoDB, Redis,
and Postgres. It compares mapping updates, paginated results, and error statuses
against the Node SDK using a new index for each run.

The comparison starts the production Node router on loopback and the static Rust image on a disposable Compose network. It seeds catalog, price, localization and search records, exercises both origins with `egdata-diff`, and verifies gateway authentication and OpenSearch access. Health service latencies and the search engine's reported execution time are measured separately on each request. The comparator validates each response's ETag against its original bytes before normalizing those measurements.

For staging traffic comparison, provision `RUST_SHADOW_ORIGIN` and the secret `RUST_SHADOW_TOKEN` on the staging gateway. Set that token as the staging Rust origin's origin and worker token. Admitted GET and HEAD requests to v1 that reach the primary origin are copied to this secondary origin. Worker logs report the operation ID, both statuses, changed header names and a body comparison for responses up to 512 KiB. For health checks and the six OpenSearch reads that report engine duration, a `timing-only` result indicates that all fields other than measured durations matched and each supplied ETag was valid for its body. Changes in validator strength are reported separately. The production origin selection still uses `UPSTREAM_API_ORIGIN`.

See [MIGRATION.md](MIGRATION.md) for the verified checkpoint and remaining gaps.

Check the handler HTTP fixtures from the repository root:

```powershell
node rust/scripts/check-http-oracles.mjs
```

This runs the canonical Node handlers with controlled service responses, checks
the recorded fixtures, then replays the requests against Rust. The runner
requires a successful Node case for each registered operation. It compares
HTTP status, selected headers and complete bodies. Collection and promotion
cases also check Mongo filters, aggregation stages, sort priority, Redis keys,
payloads and TTLs. Live-service comparisons are recorded in the migration checkpoint.
The command never rewrites fixtures. After reviewing a canonical Node change,
regenerate a specific suite explicitly, then rerun the check:

```powershell
$env:RUST_ORACLE_WRITE = '1'
pnpm exec vitest run tests/rust-native-oracle.test.ts
Remove-Item Env:RUST_ORACLE_WRITE
node rust/scripts/check-http-oracles.mjs
```
