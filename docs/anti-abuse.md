# Anti-abuse operations

The implementation is opt-in. Even in enforcement mode, clean clients do not need
tokens or a handshake. Only suspicious clients require PoW; confirmed abuse is
tarpitted regardless of token possession. Changing this repository does not
automatically change the deployment's mode.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTI_ABUSE_MODE` | `off` | `off`, `observe` (score only), or `enforce` |
| `ANTI_ABUSE_SECRET` | none | At least 32 random secret bytes; shared by all instances |
| `ANTI_ABUSE_EDGE_SECRET` | none | Independent random secret for authenticated edge forwarding |
| `ANTI_ABUSE_TRUST_BOT_HEADERS` | `false` | Trust forwarded JA3/JA4 only after enabling Cloudflare's managed Bot Management header transform |
| `ANTI_ABUSE_CANARIES` | `false` | Append synthetic records to `GET /items` in enforcement mode |
| `ANTI_ABUSE_REDIS_HOST` | unset | Private Redis host for telemetry; prefer the API's region/private network |
| `ANTI_ABUSE_REDIS_PORT` | `6379` | Dedicated telemetry Redis port |
| `ANTI_ABUSE_REDIS_USER` / `ANTI_ABUSE_REDIS_PASSWORD` | unset | Dedicated telemetry credentials |
| `ANTI_ABUSE_REDIS_TLS` | `false` | Enable TLS for the dedicated telemetry connection |

Telemetry selects a complete connection configuration in this order:
`ANTI_ABUSE_REDIS_*`, then the existing `CACHE_REDIS_*` response-cache configuration,
then legacy `REDISHOST`, `REDISPORT`, `REDISUSER`, `REDISPASSWORD`, and `REDISTLS`.
Credentials/TLS are never inherited from a different target. Dedicated settings
without their matching host fail startup. Use the GCP-local/private Redis target;
a configured hostname does not by itself prove locality. If neither local host
is set, the backward-compatible shared Redis fallback may still be cross-cloud.
The connection has a 500 ms command timeout,
no offline command queue, and a five-second failure backoff. No Redis calls are
awaited on a request. Rotating the session secret invalidates all tokens/challenges.

Asynchronous telemetry still consumes bandwidth: each tracked node sends an event
and retrieves up to 128 recent events. A session plus fingerprint updates two nodes.
Co-locate telemetry before rollout and measure Redis traffic separately from HTTP
response bytes. Moving the target starts new shared observation windows; it does
not migrate historical telemetry or change account/session secrets.

## Cloudflare trust boundary

This API runs on Node; `Request.cf` is normally absent. Cloudflare Workers can
read native `cf.tlsCipher`, `cf.tlsVersion`, `cf.httpProtocol`, `cf.asn` and, when
available, `cf.botManagement.ja3Hash`/`ja4`. Native cf properties are trusted.

For this Node deployment, use a Cloudflare request-header Transform Rule matching
`http.host eq "api.egdata.app"`. A forwarding Worker is not required. Configure
the following **Set** operations so client-supplied values are overwritten, and
use HTTPS between Cloudflare and the origin:

| Header | Transform Rule operation/value |
| --- | --- |
| `x-egdata-edge-secret` | Set static: the same secret as API `ANTI_ABUSE_EDGE_SECRET` |
| `x-egdata-tls-cipher` | Set dynamic: `cf.tls_cipher` |
| `x-egdata-tls-version` | Set dynamic: `cf.tls_version` |
| `x-egdata-http-protocol` | Set dynamic: `http.request.version` |
| `x-egdata-asn` | Set dynamic: `to_string(ip.src.asnum)` |

Do not add Remove operations for `cf-ja3-hash` or `cf-ja4`: Cloudflare prohibits
modifying or removing these reserved names in request-header Transform Rules.
The API ignores these forwarded bot headers by default, even when the edge
secret is valid. Keep `ANTI_ABUSE_TRUST_BOT_HEADERS` unset or `false` for this
rollout; no additional environment variable is required.

Only set `ANTI_ABUSE_TRUST_BOT_HEADERS=true` after enabling and verifying the
managed **Add bot protection headers** transform, which requires Enterprise with
Bot Management and supplies authoritative values. A valid edge secret is still
required. Native `Request.cf.botManagement` properties remain trusted without
this flag. Changing whether bot headers are trusted can change fingerprints and
require clients to obtain new sessions.

Remove `x-egdata-header-order` unless a trusted capture explicitly overwrites it.
Original header order must not be inferred from Fetch iteration. Setting the edge
secret while leaving this optional header client-controlled would allow spoofing.

Do not trust JA headers merely because their names start with `cf-`. Without the
edge secret, forwarded signals are ignored. Restrict direct origin access and
redact the edge secret, session header, and cookies from infrastructure logs. An
edge integration is a deployment prerequisite, not automatically provisioned here.

**Exact browser header order cannot be reconstructed from Fetch Headers.** Fetch
normalizes/sorts names, and Cloudflare may reorder them before Node sees them.
Use original order only if a trusted edge capture exposes it; otherwise omit the
header. The fallback records Node `incoming.rawHeaders` order (origin hop), or
normalized Fetch order. Header name casing is normalized. Session/authorization,
body, cache, proxy and connection headers are excluded so acquiring a cookie or
switching from challenge POST to catalog GET does not invalidate the session.
The hash contains the remaining ordered header keys, client-hint presence, JA4
(preferred)/JA3, TLS/protocol profile and ASN. IP and UA **values** are excluded.
Changing ASNs creates a different bucket; this is not universal device identity.

Cloudflare references:
- [Request cf properties](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [JA3/JA4 availability and missing values](https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/)
- [Managed Bot Management headers](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/)
- [Transform Rule fields and functions](https://developers.cloudflare.com/rules/transform/request-header-modification/reference/fields-functions/)
- [Request-header restrictions](https://developers.cloudflare.com/rules/transform/request-header-modification/)

Wrangler authentication was checked during implementation. The available OAuth
permissions include zone read but do not list zone analytics read; no live zone
traffic analysis was used to calibrate these thresholds.

## Scoring and resource budgets

For protected routes in `enforce` mode, risk <= 0.5 serves normal data without a
session. Risk > 0.5 and <= 0.8 requires a valid fingerprint-bound session less
than 30 seconds old; otherwise the API returns `SESSION_CHALLENGE_REQUIRED` with
HTTP 200. Risk > 0.8 takes the existing tarpit/truncation path. Missing or invalid
tokens alone do not raise risk. Decisions and challenge difficulty use current
behavioral evidence, not a permanent floor from the token's issuance score, so
clients return to normal when that evidence expires. Observe mode never applies
these mitigations. Normal desktop clients need no integration changes.

- Each event updates session and (when trusted transport exists) fingerprint nodes.
  Page progression and unique resource IDs connect requests across rotating IPs
  and sessions. Redis atomically merges each node's last 60 seconds, capped at 128
  events. A random event suffix prevents identical timestamps from collapsing.
- `/sales` and `/active-sales` are protected even without pagination parameters.
  GraphQL captures executed field names and resolved `page`/`id` arguments through
  Apollo, covering POST, GET variables, literal/default arguments and APQ. At most
  32 field features are recorded per request. Aliases do not create new route names
  or inflate HTTP request counts. Raw query text/variables are not stored. GraphQL
  telemetry is queued after execution, so its current request uses prior evidence.
- Scores combine deep/support ratio, eight rapid sequential page transitions or
  30 unique resource IDs, low inter-arrival coefficient of variation, volume,
  and weak header/transport mismatch evidence. At least 12 events are needed
  beyond weak mismatch scoring. These are tunable heuristics, not a trained model.
- Local feature, risk, and trap LRUs each have 5,000 entries. The queue holds at
  most 2,048 events, yields every 32 events and prioritizes trap propagation when
  full. Observe `scorer.stats` (`processed`, `dropped`, `storeErrors`) when tuning.
  Dropped telemetry and Redis outages reduce detection coverage, not availability.
- Local trap risk is set synchronously before any response and retained ten
  minutes; Redis propagates it asynchronously. Ordinary risk expires after 60
  seconds without updates. Clean common TLS profiles alone cannot convict.
- At most 512 tarpit sleepers per process; excess requests receive the truncated
  response immediately to avoid turning protection into a resource exhaustion
  mechanism. Disconnect signals cancel sleeps. No origin catalog/database work
  runs for confirmed abuse. No shared data, prices or purchase links are altered.
- Canary insertion parses only `/items` list JSON (already capped to 50 rows)
  after route caching. It is optional and outside the token/risk fast-path budget.
  Canary IDs are keyed HMACs, not a fixed public string that can trivially frame
  another fingerprint. Configure client filtering before enabling.

## Rollout and validation

1. Configure secrets and trusted forwarding, keep direct origin inaccessible.
2. Deploy the API with `ANTI_ABUSE_MODE=observe`, a separate random
   `ANTI_ABUSE_SECRET`, the matching `ANTI_ABUSE_EDGE_SECRET`, and
   `ANTI_ABUSE_CANARIES=false`. No frontend handshake is required to observe
   anonymous fingerprint traffic. Monitor queue drops/store errors and evaluate false positives
   against real browsing and nonbrowser API consumers. Common browser profiles can
   collide, particularly behind large ASNs. Do not treat a fingerprint as a person.
3. Ship on-demand challenge recovery in the frontend and clients that should
   recover automatically if flagged. Proactive initialization is optional; clean
   clients, including desktop apps, can keep fetching without changes. Browser
   workers should perform SHA-256 search without blocking UI; mobile solve times
   are not guaranteed by the bit difficulty. Cookies work on HTTPS same-site
   requests; use the session header for cross-site clients and localhost HTTP.
4. **Preserve Cloudflare caching** for ordinary public GETs, including GraphQL/APQ
   and preview images. Keep the policies in `edge-caching.md`; never override origin
   no-store on challenges, truncated responses or canary lists. Normal ETags and
   existing baseline IP limits remain active in enforcement, including when there
   are no trusted fingerprint or session tracking keys. Baseline limits can still
   return 429; PoW does not exempt clients from them.
5. Keep `observe` and canaries disabled while comparing origin bytes, cache HIT/MISS
   rates, Redis bytes, queue drops and false positives on actual client traces.
   A cache HIT does not reach this origin scorer or its limits. Configure separate
   Cloudflare WAF/rate controls before cache lookup when cache-access enforcement
   is needed; authenticated header forwarding alone does not provide this.
   See [Cloudflare's request ordering](https://developers.cloudflare.com/cache/interaction-cloudflare-products/waf-snippets/).
   Only then consider origin `enforce` for requests that reach the API. Do not
   claim calibration against named crawlers without replaying their real traffic.
   Low-rate crawlers below the heuristic thresholds can still pass. Canaries stay
   optional and require frontend filtering; cache hits will not receive them.
6. Run `pnpm exec vitest run tests/anti-abuse.test.ts`, `pnpm exec tsx
   scripts/benchmark-anti-abuse.ts`, `pnpm openapi:generate`, `pnpm docs:check`, and
   `pnpm release:check`. The benchmark reports fast-path and full Hono overhead;
   production p95/p99 under load still need measurement. Redis synchronization is
   eventual and cannot guarantee immediate global enforcement on cold instances.

The feature flag and canary flag are intentionally separate. Mode `off` creates
no Redis connection and requires no secret. Unknown modes and weak signing keys
fail startup rather than silently enabling insecure sessions.

For Redis integration tests, point `ANTI_ABUSE_TEST_REDIS_URL` at an isolated test
instance (for example `redis://127.0.0.1:16379`) and run `pnpm exec vitest run
tests/anti-abuse-redis.test.ts`. These tests use unique keys and delete only those
keys. Without that explicit variable they are skipped; application Redis settings
are never used. The tests verify atomic window bounds/expiry, duplicate timestamp
retention, cross-instance pagination scoring, and sticky trap propagation.

A local Node 22 benchmark on 2026-11-05 (2,000 samples, concurrency 1) measured
0.098 ms p95 for fingerprint + HMAC verification + cached risk and 0.118 ms added
p95 through Hono. These are warm local results, not production latency guarantees.
