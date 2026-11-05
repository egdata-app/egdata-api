# Anti-abuse operations

The implementation is opt-in so the frontend can ship its handshake before the
API requires tokens. It is not deployed by changing this repository alone.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTI_ABUSE_MODE` | `off` | `off`, `observe` (score only), or `enforce` |
| `ANTI_ABUSE_SECRET` | none | At least 32 random secret bytes; shared by all instances |
| `ANTI_ABUSE_EDGE_SECRET` | none | Independent random secret for authenticated edge forwarding |
| `ANTI_ABUSE_CANARIES` | `false` | Append synthetic records to `GET /items` in enforcement mode |

Existing `REDISHOST`, `REDISPORT`, `REDISUSER`, `REDISPASSWORD`, and `REDISTLS`
configure a dedicated telemetry connection. It has a 500 ms command timeout,
no offline command queue, and a five-second failure backoff. No Redis calls are
awaited on a request. Rotating the session secret invalidates all tokens/challenges.

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

Remove `cf-ja3-hash`, `cf-ja4`, and `x-egdata-header-order` unless Cloudflare
explicitly overwrites them with trusted values. Setting the edge secret while
leaving these optional headers client-controlled would allow spoofed signals.
JA3/JA4 can be supplied by Bot Management when available; original header order
requires a trusted capture source and must not be inferred from Fetch iteration.

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

Wrangler authentication was checked during implementation. The available OAuth
permissions include zone read but do not list zone analytics read; no live zone
traffic analysis was used to calibrate these thresholds.

## Scoring and resource budgets

- Each event updates session and (when trusted transport exists) fingerprint nodes.
  Page progression and unique resource IDs connect requests across rotating IPs
  and sessions. Redis atomically merges each node's last 60 seconds, capped at 128
  events. A random event suffix prevents identical timestamps from collapsing.
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
3. Ship the challenge handshake in the frontend and other API clients. Browser
   workers should perform SHA-256 search without blocking UI; mobile solve times
   are not guaranteed by the bit difficulty. Cookies work on HTTPS same-site
   requests; use the session header for cross-site clients and localhost HTTP.
4. **Before enforcement**, bypass Cloudflare caching for all protected routes and
   pagination requests; purge existing entries. Remove any Edge TTL rules that
   override origin no-store. Cached responses otherwise bypass the origin gate.
   This supersedes catalog, GraphQL and preview-image caching in `edge-caching.md`.
5. Enable `enforce`, then optionally canaries after the UI filters synthetic IDs.
   Preview-image and sitemap consumers also need sessions under the current route
   policy. Coordinate their usage before enforcing. Observe/off mode restores
   existing IP rate limits and cache behavior. Upstream Aikido/Cloudflare controls
   and normal account authorization remain independent of this middleware.
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
