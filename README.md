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

- Unit tests (`tests/utils/`, `tests/diff.test.ts`) are pure helpers and need no infrastructure.
- Route golden-snapshot tests (`tests/routes.test.ts`) replay a curated corpus of routes against the local Hono app and structurally diff responses against snapshots captured from `https://api.egdata.app`.

```sh
# Unit tests only, no env required
pnpm test:unit

# Route and coverage tests
pnpm test:routes

# Full suite, needs .env with MongoDB and Redis settings
pnpm test

# Recapture golden snapshots from production
pnpm test:capture
```

Snapshots live in `tests/__snapshots__/`. Volatile fields such as timestamps, etags, and `lastModifiedDate` are ignored by the structural diff in `tests/diff.ts`.

## Release Notes

Public API changes should update `CHANGELOG.md` or add a changeset note. See `docs/release-policy.md`.
