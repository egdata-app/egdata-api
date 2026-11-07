# Anti-abuse operations

The implementation is opt-in. Even in enforcement mode, clean clients do not need
tokens or a handshake. Only suspicious clients require PoW; confirmed abuse is
tarpitted regardless of token possession. Changing this repository does not
automatically change the deployment's mode.

Pagination scoring includes `page-sweep` for at least 10 distinct positive page
numbers on one semantic resource, regardless of arrival order, and
`route-hammering` for at least 120 logical deep requests to one concrete resource.
Both use the existing 60-second window (at most 128 events) and share the +0.45
sweep cap with sequential traversal, unique IDs, and title lookups. Page breadth
keeps semantic filters separate; route volume ignores filter hashes but preserves
resource IDs. Hydration and typing collapse before route-volume counting, and
repeated GraphQL aliases count once per operation/resource. These are origin-side
behavior signals, not cost measurements: edge hits are invisible, while origin
cache hits and revalidation requests can still be scored. Keep rollout in observe
until response bytes and cache behavior establish whether mitigation saves egress.

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

Fingerprint v2 additionally excludes `apollo-*`, `apollographql-*` and
`access-control-request-*`. Relative header order is preserved, never sorted by
the detector. The version number is part of the hashed profile. Redis risk/trap
keys use `egdata:abuse:v2:{<node>}:events` / `:trap`; summaries and trial switches
also use v2 so old risk/trial state is not mixed with the new scoring rules.
Existing v1 tokens no longer match the fingerprint. Roll out in `observe` with
canaries disabled, let the ten-minute token lifetime elapse before an enforcement
trial, and compare new summaries separately from v1 history. No secret rotation
or new environment variables are required.

Global CORS uses a 600-second preflight max-age. It accepts serialized HTTPS
origins whose hostname is exactly `egdata.app` or ends with `.egdata.app`, plus
explicit development/integration origins. Suffix lookalikes, credentials in the
URL, paths, non-HTTPS subdomains and unexpected ports receive no origin grant.
Keep Apollo's CSRF preflight header: browsers cache preflights per full URL, so
different GraphQL variables still require their own initial preflight. OPTIONS
is handled by CORS and never enters scoring.

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
HTTP 200. Risk > 0.8 takes the tarpit path (HTTP 204, no body, X-Egdata-Mitigation: tarpit). Missing or invalid
tokens alone do not raise risk. Decisions and challenge difficulty use current
behavioral evidence, not a permanent floor from the token's issuance score, so
clients return to normal when that evidence expires. Observe mode does not apply
these mitigations unless an operator explicitly starts the limited trial described
below. Normal desktop clients need no integration changes.

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
- Catalog search GET/POST is deep traffic; lightweight metadata remains support.
  Resolved search filters, locale and region are hashed into a traversal key;
  tracking parameters are ignored, and raw terms are never stored. Sandbox-offer
  traversal is grouped by sandbox and filters, including `/sandboxes/fn/offers`.
- Distinct allowlisted offer hydration reads for the same 32-hex offer ID within
  two seconds collapse into one logical operation. This includes resolved
  GraphQL `OfferOnly`/`OfferPage` offer reads. Repeated same-subroute requests,
  other IDs, non-allowlisted routes and additional pagination do not collapse.
  Top-level `/collections/*`, `/free-games/*`, `/offers/upcoming` and
  `/offers/latest-achievements` are support traffic.
- Search resources include a normalized title SHA-256 (NFKC, whitespace-folded,
  lowercase; empty or fewer than three Unicode code points omitted), method on
  the parent event, and the application-cache outcome when known. Consecutive
  searches less than 800ms apart collapse into a typing chain, retaining only
  its final title. No additional multi-minute state is stored.
- At least 12 raw events are needed beyond mismatch scoring. A sweep adds +0.45
  once if any of these hold: eight consecutive page increments less than five
  seconds apart; 30 distinct resource IDs; or 18 distinct logical title hashes,
  at least 80% distinct among qualifying logical title searches, with at least
  25 seconds between first/last qualifying raw title-search events. Short and
  empty titles do not enter that title ratio or span.
- Cadence uses logical timestamps: at least eight intervals, mean >=50ms and
  <2000ms, CV <0.15 adds +0.20. Sixty logical deep operations add +0.20.
  Twenty raw large searches (limit >=50) requesting at least 1500 total rows add
  +0.20. Limits are demand signals, not actual returned rows. Deep-only ratio
  >=95% adds +0.20 (>=80% adds +0.10) only alongside an active sweep, cadence,
  volume or large-search signal; it remains a diagnostic otherwise. Mismatch
  contributes up to +0.15, total score is capped at 1, and a trap overrides it.
  These are heuristics, not a trained model; library-sync clients can also trigger
  sustained lookup evidence, so calibration and conditional recovery still matter.
- Local feature, risk, and trap LRUs each have 5,000 entries. The queue holds at
  most 2,048 events, yields every 32 events and prioritizes trap propagation when
  full. Observe `scorer.stats` (`processed`, `dropped`, `storeErrors`) when tuning.
  Dropped telemetry and Redis outages reduce detection coverage, not availability.
- Local trap risk is set synchronously before any response and retained ten
  minutes; Redis propagates it asynchronously. Ordinary risk expires after 60
  seconds without updates. Clean common TLS profiles alone cannot convict.
- At most 512 tarpit sleepers per process; excess requests receive the bodyless 204
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
   no-store on challenges, bodyless tarpit responses or canary lists. Normal ETags and
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

## Observation summaries and scoped trials

Minute hashes under `egdata:abuse:summary:v2:<unix-minute>` expire 24 hours after
the minute ends. They count requests once, even when both session and fingerprint
nodes exist, and retain risk bands, score bins, reasons, route categories, method,
action, response status class, encoded body bytes, incomplete streams and untracked
requests. No IPs, session tokens, fingerprint IDs, search terms or resource IDs are
retained in these summaries. Raw scoring windows still expire after 60 seconds.
In-memory aggregation is bounded to 4096 fields/four minute buckets and flushed
asynchronously every five seconds. Failed writes are best-effort losses, not
retried indefinitely; `storeErrors`, `dropped`, `summaryErrors` and `summaryDropped`
are also summarized. Gaps and errors must accompany any interpretation of totals.

The response observer wraps application compression, counts chunks without
buffering, and preserves cache headers/ETags. `bodyBytes` measures origin response
bodies consumed by the server adapter, including partial streams. It excludes
Cloudflare cache hits, TCP/TLS overhead and upstream rejections. It is not a GCP
billing report or a claim of bytes saved. Compare the same route/method before
and during a trial, and verify savings against provider egress metrics.

Run these commands **inside the API container**, using its existing environment:

```sh
node dist/anti-abuse-ops.js report --minutes 1440
node dist/anti-abuse-ops.js status
node dist/anti-abuse-ops.js start-trial --id controlled-check --fingerprint EXACT_SHA256 --route offer-details --seconds 120
node dist/anti-abuse-ops.js stop-trial --id controlled-check
```

The report includes `pow.totals` and `pow.byScope` (observe/enforce/trial), with
zero-filled counters:

| Counter | Meaning |
| --- | --- |
| `observedResponses` | Responses covered by the new PoW instrumentation; older buckets lack these counters. |
| `challengeRequired` | Protected requests actually answered with the challenge-required envelope. |
| `challengeRequested` | Initial handshake requests that issue a puzzle (no submitted proof). |
| `puzzlesIssued` | All puzzle responses, including replacements. |
| `proofsSubmitted` | Well-typed challenge/nonce submissions, whether accepted or rejected. |
| `proofsAccepted` | Submissions accepted by HMAC/fingerprint/PoW verification and issued a session. |
| `proofsRejected` / `puzzlesReplaced` | Submissions rejected and answered with a new puzzle, including expired or fingerprint-mismatched proofs. |
| `invalidHandshakeRequests` | Malformed JSON/body or invalid field types; separate from rejected proofs. |
| `disabledHandshakeRequests` | Handshake handler replies while disabled, only when an observer is attached; production off mode disables telemetry entirely. |
| `passedWithSession` | Requests with a cryptographically valid session admitted to a route, including observe mode; not proof of a successful browser retry or successful route response. |
| `wouldChallenge` / `wouldTarpit` | Observe-only requests whose exact enforcement decision would be challenge/tarpit. Accounts for protected paths and early session expiry; high risk is not mislabeled as a challenge. |

Counters measure requests/attempts, not unique people or challenges: 20 concurrent
requests may receive 20 challenge envelopes but share one handshake, and replaying
an accepted proof counts another acceptance. Do not infer abandonment or a funnel
conversion rate by subtracting these totals. Browser worker failures, closing a
tab and successful frontend rendering are not visible. A session may be valid for
ten minutes but too old for suspicious enforcement after 30 seconds. Handshake
scope follows the global mode, so a scoped trial's handshake is labeled observe.
Response counters are finalized on stream completion/cancellation, including
incomplete responses; inspect the existing incomplete/error/drop metrics too.
These additions use the same bounded asynchronous flush and 24-hour retention,
with no new Redis operation in the request path or public monitoring endpoint.

### Distinct daily PoW cohorts

After deploying cohort instrumentation, run inside the API container:

```sh
node dist/anti-abuse-ops.js cohorts
node dist/anti-abuse-ops.js cohorts --day 2026-11-06
```

The default is the current **UTC day**, independently of `report --minutes`.
Today and yesterday are retained. No existing request counters can be backfilled
into this report. `firstObservedAt: null` means no stored lifecycle events, not
proof of full telemetry coverage.

| Field | Meaning |
|---|---|
| `challenged` | Distinct trusted fingerprint cohorts receiving an enforced challenge that day. |
| `solved` | Those cohorts with at least one accepted proof at or after their first challenge. Replays and parallel responses count once. |
| `pending` | Challenged, no accepted proof observed, and less than five minutes since the first challenge. |
| `noSolutionObserved` | Challenged and no accepted proof observed after at least five minutes. |
| `noPuzzleRequested` | Subset of `noSolutionObserved` with no subsequent puzzle issuance observed. |
| `puzzleRequestedUnsolved` | Remaining subset: puzzle issuance observed, but no accepted proof. |
| `capacityReached` | Daily storage cap reached; new cohorts may be missing. |

`challenged = solved + pending + noSolutionObserved`. Late accepted proofs move
a cohort from pending/no-solution to solved. Later re-challenges do not undo a
day's solved status; use existing request counters for repeated challenge volume.
Handshakes on the following UTC day also update the prior day's cohort, including
when separate API replicas flush out of order. A proof before the first challenge
does not mark that cohort solved. Unsolicited handshakes are not challenged cohorts.

These are **cohorts, not distinct clients or people**. Different clients can share
a transport fingerprint; one client's solve can therefore mark a shared cohort
solved. Fingerprint changes can split one client. “No solution observed” does not
prove ignoring: closing a tab, networking failures and missing telemetry look the
same. Missing trusted edge signals are excluded, and scoped trials/observe mode
are excluded because their handshake scope cannot be attributed reliably.

Only daily domain-separated hashes and lifecycle timestamps are stored, never raw
IP/UA, tokens, cookies, paths or search titles. Redis state is bounded to 10,000
cohorts per UTC day (including handshake-only entries) and expires at the end of
the following day, at most 48 hours. The in-process queue caps at 2,048 cohort/day
entries per flush; Lua writes merge at most 128 entries per call. All Redis work
runs in the existing asynchronous flush. Check `system|cohortDropped`,
`system|cohortUntracked`, and `system|cohortStoreErrors` through the existing report
alongside `capacityReached`; outage/overflow can make this best-effort funnel
incomplete. No public endpoint, frontend integration or scoring change is needed.

The operator-only Redis key `egdata:abuse:trial:v2` selects exact trusted
fingerprints and either `offer-details` (GET `/offers/<32-hex-id>`) or
`catalog-search` (GET/POST `/search/v2/search`). It cannot be enabled by a request
header. The CLI requires observe mode and canaries disabled; it refuses to replace
an existing trial. Durations are capped at 15 minutes, the Redis key has a matching
TTL, and each request also checks expiry. Polling occurs every two seconds;
deletion rolls back on the next poll, and Redis errors immediately clear the local
trial. The baseline mode, ordinary caches and rate limits remain unchanged.
Do not select real-user fingerprints until frontend challenge recovery is ready.
Shared fingerprints are cohorts, not identities.

`pnpm exec tsx scripts/anti-abuse-staging.ts` starts an isolated loopback Hono
harness with no production DB or Redis access. Open its printed URL and run the
checks, or set `PLAYWRIGHT_MODULE` to an installed Playwright `index.mjs` and run
`node scripts/anti-abuse-browser-smoke.mjs <loopback-url>` with Chrome installed.
It exercises real Web Worker SHA-256, concurrent on-demand recovery, early expiry,
bodyless tarpit responses and tokenless desktop requests. This is contract validation,
not validation of the production frontend; its PoW handler must still be built.

After deployment, `node dist/anti-abuse-production-check.js --run` performs a
controlled production check while mode remains observe. It uses a random header
name to isolate its own fingerprint, seeds only that fingerprint's risk, activates
a two-minute scoped trial, solves real PoW, verifies retry/tarpit behavior and
removes the trial in a finally block. Probe URLs deliberately miss the cache;
normal cache rules are untouched. It cannot run with canaries enabled or replace
an existing trial. Synthetic trial results are not evidence of savings on real
scraper traffic. The frontend rollout remains a separate prerequisite.

For Redis integration tests, point `ANTI_ABUSE_TEST_REDIS_URL` at an isolated test
instance (for example `redis://127.0.0.1:16379`) and run `pnpm exec vitest run
tests/anti-abuse-redis.test.ts`. These tests use unique keys and delete only those
keys. Without that explicit variable they are skipped; application Redis settings
are never used. The tests verify atomic window bounds/expiry, duplicate timestamp
retention, cross-instance pagination scoring, and sticky trap propagation.

A local Node 22 benchmark on 2026-11-05 (2,000 samples, concurrency 1) measured
0.098 ms p95 for fingerprint + HMAC verification + cached risk and 0.118 ms added
p95 through Hono. These are warm local results, not production latency guarantees.

`pnpm exec tsx scripts/replay-abuse-sample.ts <timestamped-sample.json>
<legacy-scorer.mjs>` compares a sanitized request slice offline against a legacy
module exporting `extractFingerprint` and `analyzeEvents`. It applies each
version's grouping/window bounds, reconstructs known OfferOnly/OfferPage reads,
and reports skipped unknown GraphQL operations. It does not access Redis/network
or invent missing timestamps/titles. Earlier aggregate-only reports cannot be
exactly replayed; label synthetic regressions separately from captured traces.

### Tarpit client contract

Enforced high-risk requests return HTTP 204 with `X-Egdata-Mitigation: tarpit`,
exposed via CORS, and no body. The existing 3–5 second sleep, cancellation,
512-sleeper cap and private/no-store headers remain. PoW challenges still return
the existing HTTP 200 JSON envelope. Clients should surface a recoverable error
for marked 204s, avoid automatic retries/PoW and successful-data caching, and
allow manual retry later. Deploy frontend handling before the backend change.
