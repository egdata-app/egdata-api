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

Start Redis when working with routes that depend on cache:

```sh
sudo service redis-server start
```

Offer, item, and achievement regeneration routes submit signed jobs to the Temporal job API. Production must provide:

```txt
JOB_API_BASE_URL=https://jobs.egdata.app
JOB_API_KEY_ID=egdata-api
JOB_API_SECRET=... # at least 32 bytes; store only in the deployment secret manager
```

The backend key should be scoped only to `jobs:submit:offer-regen`, `jobs:submit:item-regen`, and `jobs:submit:achievement-refresh`. The API fails closed instead of reporting a successful regeneration when durable workflow acceptance cannot be confirmed.

Natural-language offer search requires a Cloudflare API token with Workers AI Read and Vectorize Read permissions:

```txt
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
VECTORIZE_INDEX_NAME=egdata-offers
```

`VECTORIZE_INDEX_NAME` is optional and defaults to `egdata-offers`. The endpoint uses the same `@cf/baai/bge-base-en-v1.5` embeddings as the backend indexing job.

## Catalog Hydration

`POST /catalog/hydrate` streams bounded NDJSON graphs directly from the catalog collections for item, asset, and release-app identifiers. Clients persist only their discovered roots and revalidate with content hashes.

After the direct resolver has been verified, legacy materialized catalog collections can be removed with the explicit confirmation-gated command documented in the catalog hydration guide.

## Build And Checks

```sh
pnpm build
pnpm start
pnpm typecheck
pnpm biome check .
pnpm test
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

- **Deterministic tests** — pure helpers and fixture-backed route tests using committed SeaQA offer/item data and mocked infrastructure. These require no live services or credentials and gate pull requests.
- **Live smoke tests** (`tests/live-smoke.test.ts`) — minimal identity and response checks for stable public offer, item, sandbox, and build records. These run on a schedule and can be invoked manually.

```sh
# Full deterministic suite, no service credentials required
pnpm test

# Focused unit and fixture-backed route subset
pnpm test:unit

# Public production smoke checks, no credentials required
pnpm test:live
```

Route documentation coverage is enforced by `pnpm openapi:check`, which discovers Hono routes from source and requires every route to be documented or explicitly classified.

## Release Notes

Public API changes should update `CHANGELOG.md` or add a changeset note. See `docs/release-policy.md`.
