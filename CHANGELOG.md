# Changelog

All notable public API, documentation, release, and sustainability changes should be recorded here.

## Unreleased

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
