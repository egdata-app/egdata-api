# egdata API

TypeScript REST API and GraphQL server for Epic Games Store data used by egdata.app.

## Development

Install dependencies:

```sh
pnpm install
```

Run the API locally on port `4000`:

```sh
pnpm dev
```

Open:

```txt
http://localhost:4000
```

Start Redis when working with routes that depend on cache or queues:

```sh
sudo service redis-server start
```

Natural-language offer search requires a Cloudflare API token with Workers AI Read and Vectorize Read permissions:

```txt
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
VECTORIZE_INDEX_NAME=egdata-offers
```

`VECTORIZE_INDEX_NAME` is optional and defaults to `egdata-offers`. The endpoint uses the same `@cf/baai/bge-base-en-v1.5` embeddings as the backend indexing job.

## Build And Checks

```sh
pnpm build
pnpm start
pnpm typecheck
pnpm biome check .
pnpm test:unit
```

## OpenAPI And Docs

The API owns its OpenAPI contract in `src/openapi/**` and generates the committed artifact at `openapi/egdata.openapi.json`.

```sh
pnpm openapi:generate
pnpm openapi:check
pnpm docs:dev
pnpm docs:build
pnpm docs:check
```

The Fumadocs app lives in `apps/docs` and consumes the generated OpenAPI artifact without importing the runtime Hono app.

## Testing

The test suite is split into two tiers:

- **Unit tests** (`tests/utils/`, `tests/diff.test.ts`) — pure helpers, no infra required.
- **Route golden-snapshot tests** (`tests/routes.test.ts`) — replay a curated corpus of stable routes against the local Hono app and structurally diff the response against a snapshot captured from `https://api.egdata.app`.
- **Fixture-backed route tests** (`tests/search-route.test.ts`, `tests/items-route.test.ts`) — use committed SeaQA offer/item fixtures and mocked infrastructure for deterministic route coverage.

```sh
# Unit tests only, no env required
pnpm test:unit

# Route and coverage tests
pnpm test:routes

# Full suite, needs .env with MongoDB and Redis settings
pnpm test

# Opt into live OpenSearch golden snapshots (PowerShell)
$env:RUN_OPENSEARCH_SNAPSHOTS="true"; pnpm test tests/routes.test.ts

# Opt into live OpenSearch golden snapshots (sh)
RUN_OPENSEARCH_SNAPSHOTS=true pnpm test tests/routes.test.ts

# (Re)capture golden snapshots from prod
# Edit tests/corpus.ts to add real IDs, then:
pnpm test:capture
```

Snapshots live in `tests/__snapshots__/`. Volatile fields such as timestamps, etags, and `lastModifiedDate` are ignored by the structural diff in `tests/diff.ts`.

## Release Notes

Public API changes should update `CHANGELOG.md` or add a changeset note. See `docs/release-policy.md`.
