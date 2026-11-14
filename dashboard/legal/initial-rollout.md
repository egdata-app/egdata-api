# Initial developer onboarding rollout

Status: local implementation, 2026-11-12. No production deployment or legal publication performed.

## Publication dependencies

The operator confirms no payments, advertising, affiliate revenue, sponsorships,
donations or connection to a paid business. For this non-commercial rollout, retain
the operator's name, Spain and contact email; a postal address/NIF is not treated as
an unconditional publication prerequisite. Reassess LSSI applicability if the
economic context changes; see [operations.md](operations.md).

The finalized version 1.0 texts identify the confirmed providers: Cloudflare,
Google Cloud (Belgium), Hetzner (Nuremberg, Germany), and Cloudflare routing to the
operator's Gmail mailbox. MeiliSearch is unused. The developer documents cover
the portal, accounts/keys, console and `/v1`; legacy custom anti-abuse is separate.
The operator approved removing Aikido runtime telemetry; its historical records
are disclosed without applying the new agreement retroactively.

Complete the remaining supplier and transfer evidence,
retention and rights-handling procedures before approving the public text; the
specific actions are in [operations.md](operations.md#supplier-actions-and-publication-evidence).
The selected analytics minimization and broader retention rules
are implemented and tested locally, together with account export and rights-case
tracking. They are not deployed. See [operations.md](operations.md) for production
observations, supplier gaps and rights handling. Confirm the deployed behavior
matches the completed text before publication.
Confirm Cloudflare Email Sending supports arbitrary recipients for the configured
verified sender/domain and account plan. Exercise delivery to real controlled
inboxes before requiring email verification in production.

## Deployment order

1. Deploy the origin build that removes Aikido's SDK, instrumentation preloads and
   runtime hooks. Check external startup settings too and record the last possible
   telemetry send. Resolve historical runtime-data retention/deletion separately.
   Apply migrations `0008_developer_accounts.sql` through `0012_paid_plans_billing.sql`
   before the new Worker (or through `0011_email_delivery.sql` for a free-only v1.0 rollout). They enable account/receipt, privacy, email, and billing features
   but seed no documents or onboarding requirement. All remain pending remotely.
   Migration 0010 clears legacy avatar URLs. Review the production restore procedure
   and retain migration history and immutable legal evidence.
2. Build and deploy the matching SPA/Worker. Check account menu, logout, receipt,
   recent-login deletion, email replacement and same-tab verification-link login.
   Check both existing users and a new account; verify mobile/keyboard navigation.
3. Review the completed UTF-8 files (`legal/terms-1.0.md` and `legal/privacy-1.0.md`
   for free-only launch, or `legal/terms-2.0.md` and `legal/privacy-2.0.md` once all
   `[TO COMPLETE]` paid/LSSI placeholders are resolved for the paid-plans launch)
   against the verified deployment. Operational evidence remains in this guide and `operations.md`. Both documents
   refer to `/legal/history` for the publication record. Choose the actual
   publication/activation time, not the preparation date. The notice applies from
   that time; an individual's initial terms agreement starts on express acceptance.
   Preserve the exact reviewed bytes used to prepare SQL. The script is offline:
   finalized wording and SQL preparation alone do not activate onboarding.
4. From `dashboard/`, prepare SQL offline (for example, `1.0` for free-only or `2.0` once finalized for paid plans):

   ```sh
   node scripts/prepare-legal-rollout.mjs legal/terms-2.0.md legal/privacy-2.0.md 2.0 2026-11-13T00:00:00Z initial-legal.sql
   ```

   The timestamp above is illustrative; substitute the actual approved publication
   time. This command never applies SQL or deploys anything. It rejects draft
   markers, invalid version/date inputs, and
   overwriting its output. Review the SQL/hashes before explicitly executing it
   against the intended D1 database using the project's migration configuration.
5. Documents are inserted first; the final `legal_rollout` insert activates the
   portal gate. D1 file execution does not support explicit BEGIN/COMMIT. If an
   import stops midway, inspect the immutable rows and execute only the remaining
   reviewed statements. Never modify an already-published version. The script
   intentionally fails on a second initial rollout; it is not an update publisher.
6. Verify unauthenticated `/terms`, `/privacy`, both versioned URLs, and
    `/legal/history` against the hashes. Visit `/profile/agreements` as an existing user:
   email must be verified before acceptance, protected features stay gated, and
   an existing external API key must still work before and after that visit.

## Account closure and operational checks

Profile settings live at `/profile`, agreements at `/profile/agreements`, and
receipt history at `/profile/receipts`. Old `/agreements` and `/receipts` links
redirect, preserving receipt selection. All use the dashboard header with profile
navigation in place of project navigation. Email edits and deletion are on Profile;
the account popover contains Profile and Log out.

New acceptance events atomically capture terms and privacy version/hash references
to immutable documents, plus a stable receipt ID and an outbox job. The Privacy
Notice is recorded as provided for information, never as consent. Migration 0009
assigns historical receipt IDs but leaves unknown historical privacy versions null.
Never backfill them using the current rollout. Retention bookkeeping can change;
receipt identity and evidence cannot be updated. No email or display name is added
to acceptance evidence. Printable receipts contain both full documents, even when
collapsed on screen; the browser's Print / Save as PDF flow excludes navigation.
The original account-scoped JSON download remains available for compatibility.
The dashboard-specific contract is `openapi/egdata.dashboard.openapi.json`.

Closure deletes active records atomically, rejects old sessions and cached keys,
retains necessary acceptance evidence, and queues a confirmation to the verified
address. Re-registration waits for the 30-day tombstone cleanup. Other analytics,
audit logs, support correspondence, and backups require the separate rights
procedure; closure is not a claim of complete erasure from those stores.

Scheduled cleanup runs daily at 03:17 UTC; outbox dispatch runs every five minutes
and before daily cleanup. Mail delivery also runs after account
actions, claiming at most ten messages per run with five-minute leases and eight
attempts. Inspect `developer_mail` for unsent/exhausted messages and oldest queue
age; resolve failures manually and size scheduling for real volume before rollout.
Use the admin notification endpoint and dedicated email event/dead-letter queues
described in [operations.md](operations.md). Remote queues exist; subscription
creation is blocked by Cloudflare validation. Provider send acceptance is not proof
of delivery. This outbox does not implement
the advance-notice/bounce/postponement policy for future mandatory updates.

Measure the primary account-closure lookup on every authenticated key request.
Status-store failure returns uncacheable `503 ACCOUNT_STATUS_UNAVAILABLE` with
`Retry-After: 30`; quota and upstream access are skipped. Keys belonging to closed
accounts return the existing `401 INVALID_API_KEY`. Requests admitted before
closure may finish. Initial terms status never gates external API-key traffic.

Never roll back to a Worker that ignores account closure after exposing deletion.
Use a compatible fix or maintenance response. Keep the migration, immutable legal
documents and acceptance evidence across app rollbacks. Future material updates
need their own audited publishing, notice delivery, deadline and gateway work.
