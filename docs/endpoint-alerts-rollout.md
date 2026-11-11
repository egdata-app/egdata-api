# Endpoint changes and alerts rollout

## Scope and dependencies

The origin v1 operation registry remains `src/v1/operations/index.ts`; the exact
edge copy remains `dashboard/worker/v1-routes.generated.ts`. The existing
`ApiKeyRateLimiter.admit` RPC gains optional project/operation metadata. It keeps
the existing quota policy decisions, namespace, routing, and fail-closed behavior.
No public API DNS or route changes are part of this rollout.

## Provision and verify

1. Run root tests, dashboard tests/typecheck/build, OpenAPI generation/check,
   docs build/check, generated histories, and the strict release check with the
   actual merge base. Use Node 22 with its built-in SQLite test capability.
2. Create queues `egdata-endpoint-usage` and `egdata-endpoint-usage-dead` in the
   same Cloudflare account. Apply `dashboard/migrations/0002_endpoint_alerts.sql`
   using `pnpm --filter @egdata/dashboard db:migrate:remote` (the migration config
   names the existing D1 ID; deployment continues inheriting the existing binding).
3. Set a new random Worker secret `CHANGELOG_INGEST_TOKEN`. Set the same GitHub
   Actions secret and repository variable `CHANGELOG_INGEST_URL` to
   `https://devs.egdata.app/_internal/change-records`. This token authorizes only
   merged-record ingestion. The existing session-signing secret signs read cutoffs.
4. Deploy the dashboard to the user-approved staging destination, `devs.egdata.app`.
   Verify anonymous `/docs`, a stable detail URL, deployed-contract loading,
   credential-free copied examples, gateway 401/403/429 behavior, native response
   previews, and project-isolated private APIs. Keep tracking disabled until
   the queue consumer and migration are ready. Set `USAGE_TRACKING_STARTED_AT`
   once to the first enablement time and `USAGE_TRACKING_ENABLED` to `true`.
5. Require GitHub Actions `lint-typecheck-build` before merging to main. The
   workflow checks out the PR head and calculates `git merge-base` against the
   event base SHA; local checks require explicit `--base`. Do not use the old
   bypass label. Preserve existing review and branch-protection requirements.
6. A main push reconciles completed receipts and publishes missing records at their original first-parent merge
   commit and timestamp, using GitHub `merged_at` where available. Retries are
   idempotent. A publication failure fails its job independently of VM deployment;
   rerun the failed job. Corrections are ordered after their originals, including
   recovery spanning multiple batches. Never manually publish unmerged records or the archive.
7. Origin deployment is deliberately manual. Pushes and PRs do not call Coolify.
   When a separate production rollout is authorized, run the `Test` workflow on
   `main` and explicitly enable `deploy_production`. All checks run again, and
   deployment is refused if main advanced during validation. Do not enable it
   merely to publish records or verify this dashboard feature.

## Delivery and operations

Each admitted request records its optional daily usage bucket in the same DO
SQLite transaction as quota state. No usage D1 write or extra RPC occurs on the
request path. First-use timestamps survive duplicate delivery. Queue producer
batches contain at most 50 events. Alarms exist only while retryable delivery is
pending; retries back off to one hour and stop after 12 failed producer attempts.
Exhausted DO rows remain durable within the 35-date retention window for operator
recovery via the internal DO `retryUsage` method. Inactive objects are pruned on
their next admission/delivery rather than scheduling maintenance-only alarms.
Delivery failures emit structured `usage_outbox_delivery_failed`
logs and a D1 tracking-health row. Do not treat missing usage as proof of no impact.

The consumer retries failures eight times, then stores dead-letter events in
`usage_dead_letters` and flags `tracking_health.deadLetter`. Replay retained
event JSON through the bound usage queue after fixing the underlying issue, then
delete only successfully replayed rows. Clear the corresponding health flag only
after confirming recovery. No credential or request payload is stored. The daily
cron removes usage and dead-letter dates older than the 35 retained UTC dates; alert history and
read state are independent. Old unprocessed events cannot reconstruct usage that
was never captured; prolonged outages require operator investigation.

Inspect queue backlog, dead letters, `tracking_health`, and Worker error logs.
The inbox displays degraded tracking rather than claiming no relevant use.

## Rollback

Disable `USAGE_TRACKING_ENABLED` to stop new captures without changing routing or
quotas. Existing outbox delivery and retained alerts may continue. Do not roll back
the additive D1 tables or delete merged records. Revert dashboard assets independently
if necessary; keep record publication idempotent and merge/deployment labels intact.

## Verification evidence

`tests/endpoint-changes.test.ts` covers transitive dependencies, resolved shared
schemas, missing individual coverage, deleted/renamed non-JSON routes, immutable
records, corrections, stale assessments, and migration instructions. Dashboard
tests use real in-memory SQLite for publication/matching/read-state/outbox tests;
gateway tests retain permission/quota/origin regression coverage. Live deployment
results are recorded separately after verification; automated tests do not claim
that the VM origin or a merged record has been deployed.

### Merge review, 2026-11-11

- Reviewed against main `6ebec023e5e5b071cba3b0369f189a172998da90`, including
  the earlier gateway/v1 commits already on this PR branch. Added explicit
  records for all 154 new v1 operations; assessed 322 candidate operations.
- API regression suite: 466 passing, 12 optional Redis integration tests skipped.
  Dashboard suite: 78 passing. API build, dashboard build/typecheck, docs
  build/typecheck, OpenAPI, README, and strict release checks passed.
- Workflow YAML and the production job condition were checked: push/PR and
  default manual runs cannot deploy; only an explicit main manual run can.
- Dashboard-only verification used the approved `devs.egdata.app` Worker version
  `8a5bc38b-39fc-48e6-bfdc-316c7b6c7ba9` and an isolated local D1 migration.
  Browser checks verified stable endpoint pages, search, schemas, native response
  documentation, fixed proxy snippets, and disabled Scalar external AI controls.
- The deployed origin still lacks the v1 contract. Read-only build-snapshot
  documentation works; no key entry or executable Try it controls are offered
  without the deployed operation. Full live authenticated quota/usage verification
  is deferred until a separately authorized origin rollout. The production API
  was not deployed. Unmerged records and archived notes were not published.
- Follow-up review removed deployed fallback session secrets, restricted demo
  authentication to explicit localhost development, blocked unsafe login redirects
  and cross-origin dashboard mutations, and added bounded key-cache expiration.
  Revocations/permission updates can take up to five minutes to propagate; old
  KV entries without a deadline are refreshed from D1. No per-request usage writes
  were added. Wrangler migrations are now the sole source of database schema.
- Project switching remounts project pages to discard old keys/forms/secrets;
  stale session and analytics responses are ignored. Secret copying reports
  success only after the clipboard write succeeds. Limit requests are admitted
  atomically before notification (one pending per project, three per owner/day).
- Pinned affected undici 7.x dependencies to 7.30.2, preserving other locked
  dependency versions. The follow-up npm audit reports zero undici advisories;
  unrelated existing dependency advisories are outside this change.
