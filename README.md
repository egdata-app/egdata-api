To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

open http://localhost:3000

To start redis (WSL):
```sh
sudo service redis-server start
```

## Testing

The test suite is split into two tiers:

- **Unit tests** (`tests/utils/`, `tests/diff.test.ts`) — pure helpers, no infra required.
- **Route golden-snapshot tests** (`tests/routes.test.ts`) — replay a curated corpus of stable routes against the local Hono app and structurally diff the response against a snapshot captured from `https://api.egdata.app`.
- **Fixture-backed route tests** (`tests/search-route.test.ts`, `tests/items-route.test.ts`) — use committed SeaQA offer/item fixtures and mocked infrastructure for deterministic route coverage.

```sh
# Unit tests only (no env required)
pnpm test:unit

# Full suite (needs .env with MONGO_URL / Redis vars)
pnpm test

# Opt into live OpenSearch golden snapshots (PowerShell)
$env:RUN_OPENSEARCH_SNAPSHOTS="true"; pnpm test tests/routes.test.ts

# Opt into live OpenSearch golden snapshots (sh)
RUN_OPENSEARCH_SNAPSHOTS=true pnpm test tests/routes.test.ts

# (Re)capture golden snapshots from prod
# Edit tests/corpus.ts to add real IDs, then:
pnpm test:capture
```

Snapshots live in `tests/__snapshots__/` and are committed. Volatile fields
(timestamps, etags, `lastModifiedDate`, etc.) are ignored by the diff —
see `tests/diff.ts`.
