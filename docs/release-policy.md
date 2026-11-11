# Release policy

Public behavior changes require validated JSON records in `changes/records/`.
Unrelated maintenance and documentation-only changes do not create public entries.
Dates describe when a change was recorded, never deployment. No release number or
package version bump is required.

1. Run `pnpm changelog:new <unique-id> v1:<operationId> [legacy:<operationId> ...]`.
2. Describe concrete before/after behavior, compatibility, client action (`None`
   only for compatible changes), and test/contract references. Enumerate every
   affected operation; GraphQL entries enumerate affected `Type.field` names too.
3. Update OpenAPI and public docs for structural changes. Removed operations stay
   in the registry. Renames use new IDs and explicit `replaces` and `replacement`
   references. Removals declare `replacement: null` if none exists.
4. Run `pnpm changelog:assess --base <base-ref>` and edit the assessment. Each
   candidate operation needs public impact with new record IDs, or a concrete
   explanation of preserved behavior. Classify every unknown source file. The
   assessment is bound to the merge base and source digest; refresh after edits.
   CI cannot establish semantic equivalence: reviewers must check it.
5. Run `pnpm openapi:generate`, `pnpm changelog:generate`, `pnpm docs:check`, and
   `pnpm release:check --base <base-ref>`. Check commands never write files.

CI checks both route inventories, transitive local imports, explicit gateway
configuration mappings, and resolved legacy/v1 contracts. No-impact explanations
cannot override structural contract changes. Unknown impact fails closed. Merged
records and endpoint identities are immutable; corrections append a new record
with `corrects`. Unmerged records are editable. Do not edit generated files.

The original changelog is preserved verbatim in `changes/archive/undated.md`.
Never infer its dates, endpoint mappings, or alerts.

The `Test / lint-typecheck-build` check must be required in the GitHub main branch
ruleset. There is no bypass label. Repository administrators configure this;
the workflow alone cannot enforce branch protection.

After a validated merge to main, CI publishes records independently of VM
deployment. Alerts say **Merged; deployment not verified.** See
`docs/endpoint-alerts-rollout.md` for secrets and rollout prerequisites.

Production API deployment is manual. Push and pull-request workflows run checks
and main publishes validated change records; neither calls Coolify. A maintainer
must run the `Test` workflow on `main` with `deploy_production` enabled to request
an origin deployment after all checks pass. The default is disabled. This gate
does not change DNS, Worker routes, or require a deployment to merge documentation.
