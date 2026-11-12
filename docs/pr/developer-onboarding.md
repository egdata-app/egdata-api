# PR: Add developer onboarding, agreement receipts and privacy operations

## Summary

- Add stepped notification-email verification followed by explicit terms acceptance.
  Initial onboarding gates protected dashboard features and console sessions;
  existing external API keys remain usable, including after an incomplete visit.
- Add `/profile`, `/profile/agreements` and `/profile/receipts`, email replacement,
  account closure, and compatibility redirects from the previous account routes.
- Store immutable versioned terms/privacy references and acceptance receipts. Offer
  browser Print / Save as PDF with both full documents, receipt emails, public legal
  archives, and the existing authenticated JSON receipt endpoint.
- Reject closed-account sessions and keys through authoritative reads, including
  warm key caches. Account-status lookup failures return retryable, uncacheable
  `503 ACCOUNT_STATUS_UNAVAILABLE` before quota or upstream access.
- Minimize routine analytics, redact historical reporting, bundle same-origin
  fonts/local account icons, and add bounded retention cleanup, account NDJSON
  export, and admin privacy-request tracking.
- Add durable email outbox retries, transport metadata, lifecycle reconciliation,
  dedicated queue handling, and admin notification inspection.
- Include migrations 0008–0011, the first-party dashboard OpenAPI contract, public
  and embedded API documentation, dated endpoint change records, generated histories,
  and a validated impact assessment.

## Public impact

- Change record: `developer-onboarding-account-closure` in
  `changes/records/developer-onboarding-account-closure.json`.
- Assessment: `changes/assessments/developer-onboarding.json`; all 322 candidate
  operations classified, with no unknown files. A fresh assessment matched its
  base, source digest and operation set during final preparation.
- Preserved behavior: initial onboarding never blocks external API keys; public
  health, metadata, authentication, sitemap/preflight paths and configured anonymous
  bypasses retain their existing behavior. Acceptance does not restore revoked
  credentials or reset quota counters.
- Client action: dashboard/console users verify email and accept terms after
  publication. Closing an account permanently ends its credentials. Respect
  `Retry-After` for account-status 503 responses; avoid automatic retries of
  agreement-related 403 responses.

## Review guide

1. `dashboard/worker/developer-account.ts`, `developer-status.ts`,
   `developer-receipts.ts`, and migrations 0008/0009: onboarding, exact evidence and
   atomic closure. Privacy notice provision is informational, never consent.
2. `dashboard/worker/console-sessions.ts`, `key-cache.ts`, `proxy.ts`, and `v1.ts`:
   initial API-key compatibility, console gating, and closure/failure behavior.
3. `dashboard/src/components/DeveloperAccount.tsx`, `DeveloperTerms.tsx`,
   `AccountPage.tsx`, and `src/routes/profile*`: Profile navigation, onboarding,
   email-only editing, recovery, receipts and print layout.
4. `dashboard/worker/privacy-*.ts`, `analytics*.ts`, and migration 0010: export,
   bounded cleanup, rights deadlines, and analytics minimization. The export covers
   selected live account-scoped D1 records, not a cross-store rights response;
   successful streams end with `{"section":"complete"}`. Admin cases record
   evidence and deadlines, rather than executing erasure or sending responses.
5. `dashboard/worker/developer-mail*.ts` and migration 0011: retries, verification
   token secrecy and duplicate/out-of-order events. Terminal failures take precedence
   over delivery, which takes precedence over deferral.
6. `dashboard/legal/`: reviewed legal drafts, rollout order and operational evidence.
   Wording review used the direct Mistral provider (`mistral/mistral-large-4`).

The generated endpoint-history diff is broad because the shared gateway's
account-closure behavior affects authenticated operations across both API versions.
The assessment explicitly records preserved public/anonymous behavior.

## Validation

Completed locally on 2026-11-12:

- API suite: **468 tests passed; 12 Redis integration tests skipped**.
- Dashboard suite: **259 tests across 24 files passed**.
- API, dashboard and documentation production builds passed; dashboard TypeScript
  and README command checks passed. The docs build reported chunk-size warnings.
- Touched TypeScript/JSON files passed Biome's error-level check.
- `pnpm openapi:generate`, `pnpm changelog:generate`, `pnpm docs:check`, and
  `pnpm release:check --base main` passed; assessment base is
  `a27527dd9d0bdc8e99c3c0d898cbd43ae77bb7ab`.
- Dashboard OpenAPI validated with `@apidevtools/swagger-cli`.
- Browser checks at 390px and 1440px covered onboarding/Profile, receipt printing,
  and account export. The 10-page PDF included both full documents and excluded
  dashboard controls. The latest export smoke verified its completion marker and
  absence of credential fields while preserving the existing local account state.
- Migrations through 0011 applied locally. Transport integration tests mock sends;
  the operator separately confirmed a real production test in `contact@egdata.app`.

- [x] Every candidate operation is classified; no unknown files remain.
- [x] Structural changes update OpenAPI and public docs, including shared consumers.
- [x] Breaking changes include concrete migration instructions.
- [x] OpenAPI, generated histories, docs and release-policy checks pass.
- [x] Merged records and immutable endpoint identities are preserved.

## Deployment and publication

### Dependency security follow-up

The initial Aikido scan flagged `AIKIDO-2026-138234` in `ws@8.21.0`.
The workspace override now resolves that version to `8.21.3`, including both
Miniflare snapshots and the libSQL WebSocket adapter. The upstream fix starts in
`8.21.1`: <https://github.com/websockets/ws/releases/tag/8.21.1>.
Frozen-lockfile installation, API/dashboard builds, and all 727 non-skipped tests
passed after the update. The dependency change adds no public route, schema,
authentication or pagination change; existing operation classifications remain
applicable. The refreshed assessment still covers 322 operations with no unknown
files. Aikido must rescan the pushed commit to confirm its gate result.

### Activation order

Migrations seed no legal documents or onboarding requirement. Follow
[`dashboard/legal/initial-rollout.md`](../../dashboard/legal/initial-rollout.md):
apply migrations 0008–0011, deploy the matching Worker/SPA, verify production
behavior, then publish the approved immutable documents and initial requirement.
Never roll back to a Worker that ignores closure after exposing account deletion.

The implementation is prepared for review; production deployment and legal
publication have not happened. The privacy draft intentionally retains factual
publication questions and unset publication/effective dates. Resolve these using
[`dashboard/legal/operations.md`](../../dashboard/legal/operations.md):

- Confirm actual suppliers, regions/transfers, security processing, log/backup
  retention, and historical Analytics Engine rights handling.
- Verify sending to a controlled recipient outside the Email Routing list.
- Resolve Cloudflare's rejection of its documented Email Sending lifecycle event
  names, enable the subscription, and correlate a real send with its event.

Remote event/dead-letter queues already exist. The real email test reached the
operator inbox with egdata.app signing and TLS. Remote migrations remain pending.

The operator confirmed no payments, ads, affiliate revenue, sponsorships, donations,
or connection to a paid business. Drafts identify Ignacio Aldama Vicente, Spain,
and contact@egdata.app; a public postal address/NIF is not an unconditional launch
prerequisite on those facts. Reassess LSSI scope if the economic context changes.

Future mandatory-update notices, reminders, postponements, API-key acceptance
deadlines, and independent restriction controls remain a separately scoped phase.
