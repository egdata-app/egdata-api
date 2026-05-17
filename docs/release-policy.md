# Release Policy

egdata API uses a lightweight release process while the public contract is being stabilized.

## Public API Changes

Any change to a public endpoint response shape, request shape, authentication behavior, or documented error behavior must include one of:

- a `CHANGELOG.md` entry,
- a `.changeset/*.md` note, or
- a `docs/release-policy.md` update when the policy itself changes.

Use PR labels to make intent visible:

- `api:addition` for new public endpoints or fields,
- `api:change` for compatible behavior or schema changes,
- `api:breaking` for removals or incompatible changes,
- `docs-required` when docs must change before merge.

## Deprecations

Prefer additive changes first. For removals or incompatible behavior changes:

- document the replacement,
- keep the old route or field working when practical,
- add deprecation notes before removing behavior,
- update OpenAPI and contract snapshots in the same PR.

## Versioning

The API version is currently sourced from `src/version.ts` and used by root metadata and OpenAPI. Strict semver and URL versioning are intentionally deferred until the REST contract has broader coverage.

