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
- **Route golden-snapshot tests** (`tests/routes.test.ts`) — replay a curated corpus of routes against the local Hono app and structurally diff the response against a snapshot captured from `https://api.egdata.app`.

```sh
# Unit tests only (no env required)
pnpm test:unit

# Full suite (needs .env with MONGO_URL / Redis vars)
pnpm test

# (Re)capture golden snapshots from prod
# Edit tests/corpus.ts to add real IDs, then:
pnpm test:capture
```

Snapshots live in `tests/__snapshots__/` and are committed. Volatile fields
(timestamps, etags, `lastModifiedDate`, etc.) are ignored by the diff —
see `tests/diff.ts`.
