# Release Policy

egdata API uses a lightweight release process while the public contract is being stabilized.

## Changelog

Every user-facing or maintainer-facing change must include a concise `CHANGELOG.md` entry under `Unreleased`. Use the `skip-changelog` PR label only for intentionally exempt maintenance changes.

## Public API Changes

Any structural public endpoint change must include all of:

- a `CHANGELOG.md` entry under `Unreleased`,
- documentation updates under `apps/docs/`,
- OpenAPI source or generated contract updates under `src/openapi/` or `openapi/`.

Structural endpoint changes include adding, removing, or renaming routes, HTTP methods, query/path/body parameters, filters, sort options, request validation, response fields, status codes, authentication behavior, pagination behavior, documented errors, or deprecations.

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
- update `apps/docs/`, OpenAPI, and contract snapshots in the same PR.

## Versioning

The API version is currently sourced from `src/version.ts` and used by root metadata and OpenAPI. Strict semver and URL versioning are intentionally deferred until the REST contract has broader coverage.

