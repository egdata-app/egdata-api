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

- Change records: `developer-onboarding-account-closure` and
  `remove-aikido-runtime` in `changes/records/`.
- Assessment: `changes/assessments/developer-onboarding.json`; all 322 candidate
  operations classified, with no unknown files. A fresh assessment matched its
  base, source digest and operation set during final preparation.
- Preserved behavior: initial onboarding never blocks external API keys; public
  health, metadata, authentication, sitemap/preflight paths and configured anonymous
  bypasses retain their existing onboarding/authentication behavior. Requests reaching
  the origin no longer pass through Aikido runtime blocking or telemetry. Acceptance does not restore revoked
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
account-closure behavior affects authenticated operations across both API versions,
and Aikido runtime removal affects requests reaching the shared origin.
The assessment explicitly records preserved public/anonymous behavior.

## Validation

Completed locally on 2026-11-12:

- API suite after runtime removal: **463 tests passed; 12 Redis integration tests skipped**.
- Dashboard suite: **259 tests across 24 files passed**.
- API, dashboard and documentation production builds passed; dashboard TypeScript
  and README command checks passed. The docs build reported chunk-size warnings.
- Initial onboarding TypeScript/JSON files passed Biome's error-level check.
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
files. Aikido's repository scan passed on pushed commits `56bc39a` and `ab0918b`.
The runtime-removal commit also passed the Test workflow and docs Worker build;
production API deployment was skipped.

### Legal finalization and runtime minimization follow-up

The terms/privacy files are now publication candidates: factual placeholders were
replaced with confirmed Cloudflare self-service Paid, Google Cloud Belgium,
Hetzner Nuremberg and personal Gmail/Cloudflare Routing arrangements. The notice
is scoped to the developer portal/accounts/keys, console and v1. The custom legacy
anti-abuse system and its GCP technical-pattern fingerprints are outside that
scope; MeiliSearch is unused. Direct-provider Mistral Large 4 reviewed the wording.
Publication/effective dates remain an activation decision, not backdated facts.
The unpublished terms also clarify that egdata grants only rights it can grant,
attribution does not replace required third-party permission, and mandatory-law
uses and individual facts remain outside any ownership claim.

At the operator's request, the API's Aikido runtime SDK, instrumentation preloads,
middleware and identity hooks were removed. Its unused identity helper and five
helper tests were removed as well. The local legacy rate limiter still falls back
to `unknown` without an IP; existing rate-limit and anti-abuse tests pass. The
repository scanning integration is separate. Historical runtime records are
described as continuing retention, not retroactive application of the new terms.

Follow-up validation: frozen install, API build, 463 API tests (12 Redis integration
tests skipped), docs build, OpenAPI/docs, release-policy and README checks pass.
Error-level Biome lint passes on all six touched source/config files. Root `pnpm typecheck`
still reports broad dependency/global-type and legacy-source errors; this known
repository-wide check is explicitly not gated by `.github/workflows/test.yml`.
The follow-up full Biome check reports existing import ordering and Windows
line-ending formatting differences in origin files; no formatting rewrite was applied.
The runtime removal has a dated record covering all 322 stable operations and a
refreshed impact assessment. Deployment and historical provider deletion have not
been performed. See the rollout guide for origin deployment and the supplier actions.

### Production activation

Migrations seed no legal documents or onboarding requirement. Follow
[`dashboard/legal/initial-rollout.md`](../../dashboard/legal/initial-rollout.md):
apply migrations 0008–0011, deploy the matching Worker/SPA, verify production
behavior, then publish the approved immutable documents and initial requirement.
Never roll back to a Worker that ignores closure after exposing account deletion.

The implementation is prepared for review; production deployment and legal
publication have not happened. The publication candidates use confirmed facts,
with unset publication/effective dates and operational evidence still required. Use
[`dashboard/legal/operations.md`](../../dashboard/legal/operations.md):

- Confirm remaining supplier arrangements, actual log/backup retention and
  historical Analytics Engine rights handling; deploy origin runtime removal and
  resolve Aikido's historical retention/deletion. Hosting locations and the
  Cloudflare self-service arrangement are recorded in the operations inventory.
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
