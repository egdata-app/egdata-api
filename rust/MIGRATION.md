# Rust migration checkpoint - 2026-11-18

## Active migration, November 18, 2026

The Dokploy staging candidate is on `codex/rust-staging`, based on `c717420`. Build `Dockerfile.rust` from the repository root and route the staging origin to container port 4000. Production still serves Node.

| Area | Verification |
| --- | --- |
| REST contracts | Rust builds both published OpenAPI files from declarative inputs in `openapi/source/` and v1 operation metadata. The Node document builders independently reproduced both files byte-for-byte. All 154 documented v1 operations and 120 documented legacy operations have registered handlers. The root directory also passed its mounted-route test. |
| HTTP comparison | The frozen workspace passed 2,724 v1 HTTP fixtures across all 154 documented operations and 1,933 legacy HTTP fixtures across all 120 documented legacy operations. The Node fixture run passed 132 tests in 76 suites. Three environment-specific tests were skipped there. The service-backed command exercises real OpenSearch separately. The fixtures include 295 search cases, 50 dedicated current and weekly collection cases, 104 promotion cases, 191 offer relationship cases, 198 legacy top-level reads, and 190 build cases. The collection cases exercise regional prices, historical identifiers, ranked joins, continuation tokens, sparse cached pages and unavailable dependencies. Run `node rust/scripts/check-http-oracles.mjs` for current counts. |
| Identity and GraphQL | Both origins use `private, no-store` on `/profiles/me`. Packaged comparisons with Better Auth’s real migration and sign-up flow against disposable Postgres confirmed anonymous 401, linked account 200, conditional 304 and revoked-session 401. The GraphQL timestamp fixtures distinguish missing, null and stored values. The Apollo HTTP request parser matched the reference media negotiation, including callback JSON, repeated headers, parameters and error precedence, with 317/317 lines and 455/455 regions executed. A GraphQL coverage run reached 100% of 7,007 lines and 11,429 regions. A subsequent v1 profile run reached 100% of 1,327 lines and 2,687 regions with 108 canonical traces and 92 service-failure replays. |
| Native images | Five Node-to-Rust render comparisons passed across offers, sandboxes, free games, collections and Game Awards. The three editorial cards matched the Node image dimensions and met their pixel tolerances. The legacy editorial and OG HTTP cases cover injected dependency failures, typed catalog joins and malformed historical modules. Both OG upload handlers reproduce the Node response, URL and cache write for missing, null, numeric and ordinary object image IDs. Mongo upserts match operator-shaped document IDs as literal values in Rust. The packaged Game Awards responses preserve completion order for translated and unmatched categories. |
| Packaged origin | The static Linux image runs as an unprivileged user. Startup was verified against disposable MongoDB with X.509, Redis and Postgres. The real OpenSearch title lookup returned the seeded offer from both APIs. A differential run through the Node listener and packaged Rust listener passed 259/259 cases, including current and weekly collections with Decimal128 prices and rank metadata, authenticated item and changelog search with literal JSON metadata, GraphQL callback content negotiation, both localized Game Awards projections, a historical price with top-level currency, a native Decimal128 price rounded to 350 cents on the offer and discovery routes, Mongo-backed GraphQL achievements and a comparison between verified build manifests. The fixture supplies the external Epic profile identity through each origin’s isolated response cache. Both listeners returned the seeded achievement, game, 25 XP and random offer through the public profile routes. Both media endpoints returned byte-identical bodies and ETags for literal `$oid` and `$date` metadata, dates at both ends of JavaScript’s range, and a BSON date beyond that range. Four age-rating reads per listener verified the full and region-specific responses using ObjectId and Decimal128 sandbox keys. Each origin also accepted the other origin's signed item-list and item-changelog cursors against real MongoDB records with ObjectId and Decimal128 identifiers. Six additional multi-root NDJSON streams matched on record hashes, missing items, known roots and known records, including a historical date-only catalog timestamp. |
| Operations | Both freshly built origins served Redis-independent requests with shared Redis down, reported degraded health, resumed a queued read after recovery and recovered their dedicated cache independently. The eight two-origin startup and recovery tests also covered the first saved-query read after an idle disconnect, malformed shared Redis ports, and session lookup with an invalid optional Postgres URI. The Rust index command ran twice after startup created catalog indexes. APQ registrations shared the Node Redis keyspace in origin mode and used an isolated prefix in loopback mode. The Rust and Node reporting and trial CLIs passed a cross-language test against disposable Redis. Both mapping tools correctly identify OpenSearch keyword multi-fields and agree before and after applying a missing field on a disposable index. The search adapter passed 108 Node SDK comparisons and an authenticated OpenSearch 2.19.2 test covering two pages, missing indexes and rejected credentials. Its scoped LLVM run covered 898/898 lines and 1,521/1,521 regions. |
| Release | The staging candidate passed 490 Rust tests with disposable services and zero failures or skips. LLVM covered 83,990 of 84,528 lines (99.36%) and 136,036 of 137,335 regions (99.05%). The CI minimum is 99% for each metric. OpenAPI and docs checks passed. Validate the release assessment with `pnpm release:check --base c7174208a44ee65985ec14027fa6c26f1384fb9c` for this branch. Staging traffic comparison and production cutover remain pending. |

The frozen Windows binary passed live MongoDB/Redis health, OpenSearch title search and country list checks on loopback port 4002.

See [the runtime guide](README.md) for local startup, packaged service comparisons and the full coverage command. The staging Worker has an opt-in comparison path for admitted v1 reads. It uses a separately configured Rust staging origin and token. No production traffic has moved.

Node and Rust now resolve authenticated Epic users through the live Better Auth session and its Epic provider account. The private users-service checks token activity and verifies the returned account against the subject. The packaged comparison signs its cookies with the first rotating Better Auth key while a different legacy key is configured. The public startup check also passed with the optional session database unavailable. The session regression tests cover missing, ambiguous, expired, revoked and other-user records. An existing unlinked session needs an Epic provider link to use these private handlers. Their private and internal route classifications are retained.

Both origins now update a review by its authenticated owner and offer, and check its stored edition history when saving an edit. A concurrent edit triggers a fresh read. A deleted review returns 404. Both packaged origins passed eight owner-authenticated review and ownership requests apiece. Checks included persisted BSON, one insert after duplicate submission, preserved document identity and metadata, and both competing edits retained. Product lookup now resolves the Mongo connection after startup. The dated release record covers the resulting public review lists, summaries and profile counts in REST and GraphQL. The remaining Discord OAuth difference is separate: Rust requires a single-use, session-bound state value in the callback. Node's existing redirect flow still needs a cutover decision.

The [resource benchmark](bench/README.md) records 33,680 requests on a Windows desktop. Startup idle RSS was 160.1 MiB for Node and 37.3 MiB for Rust. Origin CPU per request fell 61–88% across four workloads. Two single-round Ubuntu/WSL2 runs against disposable services each served 8,420 requests. Peak RSS on one CPU was 298.0 MiB for Node and 44.3 MiB for Rust. On two CPUs it was 334.5 MiB and 36.2 MiB respectively. Repeat on the target VM before making capacity decisions.

### Next steps for this worktree

1. Mirror admitted v1 reads through the staging gateway to the designated Rust staging origin. Review differences in status, headers, JSON, image and stream results. The comparison checks each supplied ETag before discounting a timing difference.
2. Run the CPU and resident-memory benchmark on the designated VM with identical workloads and service configuration for Node and Rust. Preserve the machine details, CPU affinity and per-workload results with the run.
3. Keep both workspace coverage metrics at or above 99% and rerun the Node comparisons, disposable service tests, packaged Linux origin checks, OpenAPI, docs and release assessment after changes. Prioritize mismatches that affect the responses or resources measured in staging.
4. Resolve the Discord OAuth state behavior before switching traffic for that flow. Keep the Node rollback target through rollout and soak.

Earlier sections below are historical checkpoints.

## Original Gemini scope

Migrate the Node origin to five Rust crates while retaining REST, GraphQL, middleware,
serialization and image behavior. Verify against the existing Node implementation,
with an original target of 100% line and region coverage. The November 18 decision sets both thresholds to 99%. The actual v1
registry has **154** operations (the original plan's 155 counted a string).

## Work resumed here

- Repaired missing imports/dependencies and incomplete tests so all five crates build.
- Confirmed that `egdata-infra/src/port_adapters.rs` already implements the 19 service
  ports; its tests now run as part of the workspace. This is not proof of full service
  parity or real MongoDB/Redis/Postgres integration.
- Connected existing system/native/stats/franchise/game-awards and OG groups to a
  shared v1 router. Route registration also supplies the implementation inventory.
- Added countries, regions, country-to-region and catalog hydration HTTP handlers.
  Hydration validates content type, request bytes, string limits, identifiers and
  hashes, resolves one root per poll, bounds each NDJSON line, isolates per-root
  failures, skips ETag buffering, and stops starting roots when the body is dropped.
- Wired v1 context, ETags, cache policy, preflights and 404/405 Problem Details.
  This is the **v1 router**, not the finished global middleware/server stack.
- Matched Hono's first-value query semantics and Zod's grouped unknown-key errors,
  using a local Node probe. Verified metadata ETag digests against Node serialization.
- Implemented an OpenAPI CLI. It independently reconstructs all 154 v1 operation
  objects from Rust metadata; shared info/tags/servers/components still come from
  the canonical contract during migration. Tests check JSON structure **and byte
  order** after compact serialization. Legacy OpenAPI generation remains in Node.
- Made differential OpenAPI case loading deterministic across serde feature sets;
  explicitly enabled JSON insertion-order preservation for Node-compatible ETags.
- Added `rust/.gitignore` for build/coverage output. Formatted the Rust workspace.
- Extended release assessment to include Rust sources and Cargo/toolchain files.
  The assessment classifies the inactive migration explicitly, and a regression
  test verifies that changing Rust source invalidates the assessment digest.

## Parallel route wave (GPT 6 Luna workers)

- Registered 57 additional handlers: 13 offer routes, 9 build routes (including
  launcher resolution), 22 item/seller/sandbox routes, and 13 search/multisearch routes.
- Added offer list/discovery/detail/bulk handlers with signed keyset pagination,
  regional prices, localization, event aggregation, rankings, achievement fallback,
  and compatible Node cache payloads. Twelve behavioral tests check port requests,
  cursors, cache hits, validation, localization and error handling.
- Added launcher-record resolution against item/asset/offer/subitem collections,
  including parent-game identity, ambiguity and unsupported results, custom attributes,
  strict bounded input and batch ordering. Seven tests include **53 validation fixtures
  generated from the current Node Zod schema**. `node rust/scripts/check-launcher-fixtures.mjs`
  checks those fixtures against the source; `--write` refreshes their expected output.
- Build list/files/history/tree/items now issue and validate signed continuations;
  install-options aggregation/cache and build-summary timestamp formatting were audited.
  At that checkpoint, comparison was still incomplete (addressed in the next wave).
- Catalog handlers have nine focused tests; search has six. Cursor encoding errors now
  propagate as Problem Details instead of returning a broken continuation page.
- Corrected shared cache handling: empty parameter maps retain the Node key's trailing
  colon, and a cached JSON null is a miss (false/zero/empty strings remain cache hits).
- Resolved and validated cursor secrets when loading application configuration,
  including trimmed primary/dev secrets and the Node test-environment fallback.
- The remaining workers' handlers are still migration work in progress. Registration
  does not certify data, error, cursor, cache, collation or performance parity.

## Registered-handler parity wave (GPT 6 Luna workers)

No routes were added in this wave: the inventory remains **86/154**.

- Build comparison now reads projected, sorted Mongo cursors through a lazy stream
  port, merges snapshots incrementally, and returns Node-shaped summaries, warnings,
  cache payloads and signed path continuations. The driver uses batches of 256.
  Page/top-file storage is bounded; the directory-delta map still grows with unique
  directories, as it does in Node. Tests exercise the actual HTTP route and a fixture
  generated by executing the canonical TypeScript comparison helper.
- Search V2 now has its own query/filter/sort/facet builder and offer-card projection,
  regional prices, localization, 60-second cache, and `search.offers` cursor binding.
  Regression tests inspect OpenSearch request bodies and CSV/price/order normalization.
  Natural-language search now uses the requested locale and aligns body validation,
  success envelopes and upstream errors; this is not a complete search differential run.
- Item bulk routes now use Node cache keys/payloads and field-level validation errors.
  Item changelog and offer cache wrappers were repaired, regional bulk-offer queries
  now pass body parsing, and identifiers use JavaScript UTF-16 length semantics. Seller sorting uses ICU
  collation, with Node-generated accented-name fixtures for six locales. Set
  `NODE_ICU_LOCALE` to the Node origin's `Intl.Collator().resolvedOptions().locale`
  before comparing/deploying across hosts; the default is the host locale. Fixtures
  were generated with Node ICU 77.1; matching these cases is not proof that every
  ICU version orders every Unicode string identically.
- Sandbox handlers now use the Node cache keys, payloads and TTLs, without refreshing
  entries on cache hits. Fixed virtual assets/stats, asset null ordering and UTF-16
  comparisons, namespace cursor BSON types, base-game selection, canonical offer
  ordering before localization, changelog context hydration and its separate cache.
  Tests include all ten sandbox cache-hit shapes, paging, query bounds and fixtures
  executed from the Node merged-asset helper.
- Shared CSV parsing now sorts UTF-16 code units like JavaScript, including astral
  characters. The Mongo stream adapter is also exercised against the existing mock
  wire server; live Mongo integration has not been run.

Recheck Node-derived fixtures from the repository root:

```powershell
node rust/scripts/check-launcher-fixtures.mjs
node rust/scripts/check-collation-fixtures.mjs
pnpm exec tsx rust/scripts/check-sandbox-fixtures.ts
node rust/scripts/generate-build-compare-oracle.mjs --check
node rust/scripts/check-item-bulk-fixtures.mjs
node rust/scripts/check-og-fixtures.mjs
node rust/scripts/check-franchise-number-fixtures.mjs
```

## Follow-up registered-handler parity wave (GPT 6 Luna workers)

The inventory remains **86/154**; no routes were added.

- Changelog search now follows the canonical **v1** implementation: blank queries
  use the 60-second Mongo cache and signed timestamp/ObjectId keyset pagination;
  text queries use the v1 OpenSearch query, exclusion filters, ordering, cursor
  binding, result metadata and retryable upstream error. Query bounds use UTF-16
  lengths and Zod-compatible grouped errors. Regression tests check cache reuse,
  serialized hits, the second-page BSON predicate and exact search request fields.
  Earlier notes incorrectly listed document/value hydration as missing here: that
  is legacy route behavior and is not part of the current Node v1 handler.
- Item builds now use the Node cache key, array payload and 120-second TTL, with
  normalized/validated item IDs. HTTP tests cover miss/write/hit behavior without
  extra Mongo reads or TTL refresh. Seller stats now retain BSON i64 aggregate
  counts; the HTTP fixture verifies combined free-game and mobile-freebie totals.
- Franchise achievement XP and time-to-beat totals now coerce numeric strings,
  booleans and supported JSON values like Node's `Number(value) || 0`. Nineteen
  Node-executed cases include malformed input, arrays, radix strings, BOM whitespace
  and exponent overflow, alongside a franchise HTTP regression.
- OG metadata now matches Node's price scaling/display precision and currency
  symbols, September/date-only formatting, nullish date fallback, stable download
  timestamp ties and empty-platform fallback. Fixtures execute the canonical Node
  price expression and helpers for 180 prices, nine download selections and seven
  dates. HTTP tests capture the metadata passed to the renderer. This does not
  establish pixel/cover/font parity of the native rendering path.
- Live verification on 2026-11-17 passed against the real service adapters:
  recent changelog pages contain distinct records and repeat reads are stable;
  text changelog search, full-facet offer search, item builds (43 summaries in the
  sampled item) and seller stats return HTTP 200. The updated development server
  is running on `127.0.0.1:4001` with startup logs under ignored `rust/target/`.

## Canonical HTTP fixture wave (GPT 6 Luna workers)

- Added 47 Node-executed HTTP fixtures for native routes (22), item/seller routes
  (8), offers (8), and search/multisearch (9).
  The Node suites execute the existing handlers and
  business services with mocked external I/O. Rust comparisons check response
  status, selected protocol headers and complete JSON/text bodies. Wrapper layers
  are aligned per suite; this is not a full live origin-to-origin comparison.
- Native cases cover robots/HEAD, sitemap indexes and pages, aliases, malformed
  dates, database failures, validation and conditional requests. Fixed ETags on
  error responses, wildcard conditional behavior, and 304 header handling to match
  the installed Hono 4.12.18 implementation. Invalid persisted sitemap dates now
  produce the same generic error instead of malformed XML.
- Catalog cases cover direct/linked/missing item offers, bulk selection, seller
  cover preference and fallback, and combined seller statistics. Fixed the seller
  cover lookup's collection name to `game_positions`.
- Offer cases cover a priced list, cache hits and malformed-cache recovery,
  localized detail, country-ineligible price exclusion, event discovery and query
  validation. These cases confirmed existing behavior without an offer handler fix.
- Search cases cover item serialization, seller aggregation, natural-language
  results, validation and configuration/upstream/internal errors. Fixed item custom
  attributes, result metadata, seller serialization/order, and error classification.
  The Vectorize adapter preserves upstream error provenance so the HTTP layer can
  distinguish the canonical 502, 503 and 500 responses.
- `node rust/scripts/check-http-oracles.mjs` checks the canonical Node fixtures and
  runs the Rust comparison tests without rewriting expected output. See the README
  for deliberate regeneration. Registration remains 86 of 154 operations.
- Restarted the local API after verification on 2026-11-17. Live MongoDB/Redis
  health, title search, item/seller multisearch, offers and robots return HTTP 200;
  matching robots ETags return an empty 304, and query errors now include ETags.

## HTTP and service-call parity follow-up (GPT 6 Luna workers)

- Expanded to 115 canonical Node HTTP cases: native 22, search 35, catalog 16,
  offers 19 and assets 23. The checker also reports distinct documented operations
  covered (26), so fixture count is not confused with handler coverage.
- Seller multisearch now uses Node's 300-second cache key/payload and fail-open
  behavior. Fixtures exercise hits, malformed entries, read/write outages,
  OpenSearch/Mongo failures, empty queries and JavaScript limit coercion, including
  huge numbers and BOM/NEL whitespace. Recorded OpenSearch requests and seller
  cache write keys/TTLs are compared with Rust calls.
- Item multisearch now defaults to 20 results, sends Node's `track_total_hits`
  and missing-value sort options, and uses the canonical 60-second cache with
  cursor-specific keys. Fixed cursor bindings and source serialization/identity.
  Fixtures cover first/next pages, cursor rejection, service/cache failures,
  empty filters and validation, including exact cache keys and TTLs.
- Offer comparisons now cover populated discovery/ranking, bulk slug/existence
  lookups, event detail and signed cursor first/next pages and binding rejection.
  An injectable wall clock gives Node and Rust the same cursor timestamp without
  omitting signatures or ETags from comparisons. Runtime construction uses UTC now.
- Catalog fixtures add regional exclusion, locale fallback, invalid query/locale,
  duplicate IDs and empty/missing bulk results. These comparisons confirmed existing
  Rust behavior; actual translated item offers and their cache variants remain open.
- Added asset HTTP and service-call comparisons for cache key/payload/TTL, hits,
  malformed/null/false cache values, cache outages, missing/database-failure results,
  HEAD, nested documents and encoded identifiers. Fixed shared error `instance`
  path decoding to match Hono and identifier trimming to use JavaScript whitespace.
  Valid encoded delimiters/percent signs, Unicode, BOM/NEL and UTF-16 limits are
  covered. Malformed UTF-8 path extraction is not established by these fixtures.
- Live verification after restart on 2026-11-17: MongoDB/Redis health and offer,
  item and seller search return HTTP 200. Item search defaults to 20 and repeated
  item/seller reads are stable. Upcoming-offer and item-search cursor requests
  return distinct next records with stable repeats. Encoded asset errors contain
  the canonical decoded instance path.

## Seller, item, region and saved-search comparisons

- Compared seller directory and offer responses, including duplicate sellers, empty
  results, response-cache hits and database failures. The populated seller case also
  compares the offers filter and the regional price lookup sent to MongoDB.
- Compared both a French translation with EURO pricing and the missing-translation
  fallback for item offers. Additional cases cover a cached negative result and
  recovery from malformed cache data.
- Countries and regions now have HTTP comparisons including HEAD, conditional GET,
  unknown keys and duplicate country parameters. Country and locale parsing follow
  JavaScript whitespace rules for leading BOM and NEL characters.
- Saved-search reads now use the shared Redis connection and its `q:` keys.
  Computed counts use the separate regional response cache. Tests record which keys
  each service reads and check validation order, serialization and missing IDs.
- Search redirect fixtures compare the status, cache policy and complete Location.
  Redirects and sitemap indexes use the public base URL loaded at startup, including
  configuration supplied through an explicit dotenv file.
- The restarted loopback server matched all 13 regional HTTP fixtures. Live requests
  also verified a canonical search redirect, the missing saved-query response,
  country validation before lookup, an OpenSearch title result, the seller directory
  and a seller's offers. Positive saved-query and translated item cases use fixtures.

## Build pagination, catalog reads and saved-query counts

- Added HTTP comparisons for the build list, history, files and tree. The fixtures
  freeze the clock and feed Node-issued signed continuations into Rust, including
  the transition to records with missing timestamps in an ascending build list.
- Fixed a live build-list 500 by accepting BSON dates and whole-number double byte
  counts from the ingestion client. The list resolves executable items using their
  release information before serializing the public item fields.
- Item detail, item assets, sandbox detail and sandbox items have new comparisons
  for populated and empty responses, missing records and namespace fallback.
  Success responses and response-cache helpers use JavaScript number formatting.
  This fixed an item-assets ETag difference on whole-number BSON doubles.
- Saved-query count comparisons verify the uncached regional MongoDB aggregation,
  the serialized cache entry and its 300-second expiry. Replaying the request
  against the same cache returns the first result with a single total aggregation.
  The price lookup sorts by update time and takes the latest matching price.
- Live Node and Rust handlers connected to the same MongoDB data matched on 19
  comparisons, including first pages and exchanged cursors for the build list
  in both directions, history, files, tree, items and sandboxes. Cursor issue times
  vary on live requests. The deterministic build fixtures compare the token bytes.
  The populated saved-query count comparison used fixture data.

## Local runtime wiring

- Added `runtime.rs` and `runtime_adapters.rs`: dotenv/process configuration,
  certificate paths relative to the dotenv file, required MongoDB/Redis startup
  checks, concrete adapters, optional-service configuration errors, loopback HTTP
  serving, origin authentication, CORS, the existing v1 stack and graceful shutdown.
- `node rust/scripts/dev.mjs --env-file <Node-checkout>/.env --port 4001` runs the
  real API with a development gateway token/cursor secret and an isolated Redis
  response-cache prefix. See [README.md](README.md) for requests and restart steps.
- Live checks on 2026-11-17: health confirms MongoDB and Redis; countries, offers,
  items and sandboxes return HTTP 200. Offer cursor continuation returns a distinct
  next record; repeated reads are stable and missing gateway context is rejected.
- OpenSearch authentication is verified after quoting the local dotenv password,
  whose leading `#` was parsed as a comment. No credential rotation was needed.
  Live title search exposed an unsupported `missing` option on the `_score` sort;
  Rust now omits it, matching Node. On 2026-11-17, title search with full/minimal/no
  facets, default search, explicit field sorting and offer multisearch returned
  HTTP 200. Cursor continuation returned a distinct record and repeated reads
  were stable. All 10 search tests and API all-targets Clippy passed after the fix.
- No index/schema provisioning, background jobs, public route switch or deployment
  was performed. GraphQL, legacy REST and the missing v1 handlers remain unfinished.

## Collections, promotions, free games, catalog discovery and profiles

The local router reached 118 documented operations with these five families.
Real Node and Rust reads matched for current and historical collection positions,
promotion lists, regional promotion offers, localized covers, free games and
giveaway history. Both origins accepted each other's continuation tokens for
collections, promotion offers and giveaway history.

Live comparisons found that changelist reads need the `changelogs_v2` collection,
ungrouped tag responses omit the group field, and autocomplete requires the
same Mongo text collation on its list and count queries. After those fixes,
the live comparisons matched for all three reads. Live offer and free-game
searches returned HTTP 200 through authenticated OpenSearch. Search timing
varies per request.

The new fixtures check database filters and aggregation stages, Redis behavior,
cursor handling and localized prices. In particular, a translation can have a
missing fetch timestamp and still supply the offer title. Full profile responses
are compared through the gateway context and ETag middleware.

## Offer prices and historical pagination

At this checkpoint the five offer-price reads brought the local router to **123 of 154** documented
operations. All **393 Node HTTP fixtures** across 19 suites passed against Rust.
They include price and fairness lookups, grouped and regional history, historical
price fallback, exchange rates, country eligibility, native Mongo sort options
and a Node-issued cursor containing a BSON ObjectId. The local API returned
matching populated responses against real services for all five reads.
All 277 workspace tests passed. Workspace formatting, all-target Clippy,
OpenAPI equivalence, documentation and the release impact check also passed.

The infrastructure crate passes 42 tests. Instrumentation of its source reports
**7,547 of 7,809 lines (96.64%)** and **11,984 of 12,521 regions (95.71%)**.
The following wave covered the remaining 31 offer-detail operations.

## All 154 versioned operations registered

The local Rust origin now serves every documented `/v1` operation. The last
31 handlers cover offer relationships, metadata, insights, changelogs and
reviews. The OpenAPI inventory test requires an actual handler for each method
and path. The differential runner requires a successful canonical Node response
for each operation and replays the fixtures against the mounted Rust router.
The 23 fixture suites cover 455 HTTP cases. A separate Hono middleware test
checks the outer server. All 283 tests in the Rust workspace passed.

Live comparisons included a Node-issued changelog cursor continued by Rust,
review hydration and summaries, populated builds and technologies, bundle and
collection members in French, giveaway history and achievement sets. The HTTP
fixtures also cover sparse builds, string build identifiers and DLC requirements
inherited from a different offer. Live requests to all 31 newly mounted
operations matched Node for the sampled offers, including expected 404s.
The outer listener also matched Hono on identity, gzip and deflate responses,
ETags, CORS preflight and HEAD requests for the countries endpoint.

The infrastructure coverage run passed 43 tests and measured 7,590 of 7,853
lines (96.65%) and 12,104 of 12,640 regions (95.76%). Global middleware beyond
the versioned routes, GraphQL, legacy REST and the workspace coverage and cutover
gates remain open.

## Earlier verified checkpoint

- Rust serves 86 of the 154 documented v1 operations. The HTTP comparison runner
  now requires a successful canonical Node request for each registered operation.
  Coverage includes builds, search, catalog reads, system, statistics, franchises,
  awards, the hydration stream, OG images and redirects.
- All 284 Node HTTP fixtures pass against Rust. The workspace passes 268 Rust
  tests across the API (147), core (73), diff runner (7), GraphQL scaffold (1)
  and infrastructure (40).
- Comparative fixtures cover two different build snapshots, including file changes,
  signed continuation tokens and a cache hit seeded from Node. Search fixtures
  also replay Node cursors and use captured cache writes.
- A real MongoDB hydration comparison caught different hashes for identical asset
  sizes. The resolver and NDJSON writer now share JavaScript number formatting.
  Live requests match for populated and missing roots, a Node-supplied graph hash,
  and individual known-record hashes. Hydration timestamps vary by request.
- Live Node and Rust responses matched for OpenAPI, health, an invalid homepage
  country, a missing franchise and localized game awards. Health latency was
  validated independently on each origin. Fixtures additionally check chart
  aggregation pipelines, annual count filters and shared Redis failures.
- Actual OG renders are compared at 1200 × 630 in PNG and WebP. A deterministic
  cover and the fallback layout exercise both offer and sandbox templates. Across
  eight comparisons, mean absolute RGB channel error was 0.418–1.085 on the
  0–255 scale. The Rust image test also checks fresh renders against its saved images.
- Live OpenSearch reads exposed three differences: multisearch offer prices,
  offer-type ordering, and a Mongo version field leaking into changelog search.
  After the fixes, populated responses matched Node with service timings and
  cursor issue timestamps normalized. Authenticated POST search returned the
  same 303 redirect destination on both origins.
- Rust formatting and workspace/all-targets Clippy pass with warnings denied.
- All 13 endpoint release-policy tests pass.
- The Rust OpenAPI check matches all 154 operation definitions.
- `pnpm openapi:generate` and `pnpm changelog:generate` produced no semantic changes.
- `pnpm docs:check` passes after `pnpm --filter @egdata/docs generate` creates local
  Fumadocs collections. `pnpm release:check --base HEAD` passes with the refreshed
  assessment of 88 Rust source/build files isolated from the public origin.
- The 100% coverage gate **does not pass**. Before runtime wiring, the workspace measured **91.00%
  lines and 90.12% regions** (33,827 lines; 57,222 regions), including compiled test
  helpers and process entrypoints. This improves on the preceding wave's 88.42%/
  87.33%, but substantial untested branches remain. No exclusions or lowered
  thresholds were introduced in that wave. All 227 pre-runtime tests passed under
  coverage; coverage has not been remeasured after runtime and follow-up parity work.
- Biome reports pre-existing issues in the release-policy files; the workflow already
  documents that repository-wide Biome/typecheck are not clean baseline gates.
- Live verification covers selected routes. A full differential run, traffic
  mirroring and production cutover remain outstanding.

## Local GraphQL checkpoint, November 18

The local origin serves `GET /graphql` and `POST /graphql` through the shared HTTP middleware. The Rust schema uses the canonical SDL and Apollo introspection metadata. Request handling includes persisted queries, validation limits, response negotiation, ETags and GET cache directives. The benchmark launcher and local API keep their Redis writes in separate namespaces.

Nine live comparisons matched the Node origin on body bytes, HTTP status, ETag, cache headers, Vary and route template. They covered a populated offer and its relationships, an item and its linked offers, a build, a sandbox, a missing build, the query root and an invalid field. The HTTP fixtures also replay Apollo output coercion, nullable fields, unions, validation, persisted-query registration and conditional requests. Profile aggregation, uncommon validation errors and the shared telemetry path still need end-to-end verification.

## Commands

Run Rust commands from `rust/` so the pinned toolchain is selected:

```powershell
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets
cargo run -p egdata-api --bin generate-openapi -- --check
cargo run -p egdata-api --bin generate-openapi -- --inventory
cargo run -p egdata-api --bin generate-openapi -- --output target/v1.openapi.json
```

Check that each documented operation has a handler and that the generated contract matches:

```powershell
cargo run -p egdata-api --bin generate-openapi -- --check --require-handlers
```

The workspace missed the original threshold at this checkpoint. The current service-backed coverage command is in the [runtime guide](README.md).

From the repository root, use the actual PR base when it differs from this checkpoint's
base (`c717420`). Refresh the assessment after any Rust source/build change and preserve
concrete no-impact explanations only while they remain true:

```powershell
pnpm changelog:assess --base HEAD --id rust-migration-resume
# Complete the generated assessment before checking.
pnpm release:check --base HEAD
pnpm docs:check
```

## Known gaps within the registered handlers

Registration and local tests do not establish full Node parity. Keep production
routing on Node while these and the readiness gates remain outstanding.

- Every registered operation has representative Node HTTP coverage. Additional
  cursor, cache failure, localization and unusual document cases can still expose
  differences, especially with live service data.
- Search/multisearch routes still need broader cursor, cache, filter and locale
  fixtures beyond the selected HTTP/error cases and prior offer-search fixes.
  Legacy changelog document/value hydration remains work for the legacy phase.
- Seller and item offer reads have representative HTTP comparisons. Multi-page
  seller data, additional locales, malformed persisted rows and inherited system/OG
  behavior still need broader verification. Collation depends on the
  configured locale and ICU data version.
- Build comparison stream tests cover representative inputs, cache reuse and cursors;
  large live snapshots, malformed persisted rows and cancellation under real Mongo
  load still require integration testing. Directory aggregation is not constant-space.
- The workspace coverage gate remains below 100%. Do not introduce exclusions or
  lower the threshold to make the migration appear ready.

## Next work

1. Run the registered-handler comparisons across all 154 operations and extend
   the live checks as new persisted document shapes are found.
2. Complete the global middleware stack beyond the local listener and adapter
   construction now in place. Anti-abuse middleware is currently only a marker
   type; challenge handling, telemetry, SSR telemetry and complete middleware ordering
   remain outstanding. Keep v1 isolated from anonymous anti-abuse/rate-limit policy.
3. Expand the registered GraphQL resolver and validation comparisons, especially
   profile aggregation, cache failures and live service error paths.
4. Port legacy REST, authenticated writes/admin handlers and native OG cards.
5. Close meaningful coverage gaps, add real service integration fixtures, run the
   differential oracle across every implemented operation, and visually verify OGs.
6. Finish operational CLIs, Rust CI/container tooling and contract inventory cutover.
   Retain Node until runtime parity and all readiness gates pass. Production cutover
   and removal of Node have not happened.
