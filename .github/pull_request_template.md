## Summary

## Public impact

- Change record IDs (public behavior changes):
- Impact assessment file (API/gateway/shared code, including no-impact changes):
- Explain preserved behavior where assessed as no impact:

## Validation

- [ ] Every candidate operation is classified; unknown files are explicitly mapped.
- [ ] Structural changes update OpenAPI and public docs; all shared schema consumers are covered.
- [ ] Breaking changes include concrete migration instructions.
- [ ] OpenAPI, generated histories, docs, and `pnpm release:check --base <base-ref>` pass.
- [ ] Merged records and immutable endpoint identities are preserved.

Documentation-only and unrelated maintenance do not need public entries. Behavior-only changes require author assessment and reviewer verification.
