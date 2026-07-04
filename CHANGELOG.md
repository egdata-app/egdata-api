# Changelog

All notable public API, documentation, release, and sustainability changes should be recorded here.

## Unreleased

- Increased the route snapshot test setup timeout to reduce CI failures during slow live MongoDB connections.
- Removed Redis caching from sitemap XML responses to avoid storing large generated sitemap payloads in Redis.
- Reduced offer sitemap pages to 5 offers each to keep localized `hreflang` sitemap XML responses smaller.
- Added locale-prefixed offer URLs with `hreflang` alternates to the public offer sitemap pages.
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
