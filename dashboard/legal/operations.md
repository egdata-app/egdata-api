# Initial rollout: privacy and email operations

Status checked 2026-11-12. Implementation and migrations through 0011 are local;
the Worker has not been deployed and no production legal documents were published.
This is operational evidence, not public legal promises.

## Production evidence and activation order

- Cloudflare Email Sending is enabled for `egdata.app`; configured DNS includes SPF,
  DKIM and the `cf-bounce.egdata.app` return path. A test from `noreply@egdata.app`
  to `contact@egdata.app` reached the inbox, confirmed by the operator's Gmail
  screenshot dated 2026-11-12 (displayed message time 21:05). Gmail shows
  `egdata.app` as mailed-by and signed-by, TLS transport, and
  `contact@egdata.app` as Reply-To. Arbitrary-recipient sending remains unverified.
  Plan inspection returned Cloudflare 10000 Authentication error.
- Remote queues `egdata-developer-email-events` and `egdata-developer-email-dead`
  exist. No lifecycle subscription was created. The checked-in Worker consumes only
  the events queue; the dead queue is reserved for operator replay.
- Remote Worker settings showed targeted `gcp:europe-west1` placement and
  `redact_query_string:false`. Placement is not a data-residency guarantee.
  The checked-in configuration enables query-string redaction.
- Remote D1 `egdata-dashboard-db` still needs migrations 0008–0011. All are applied
  locally; the user's local onboarding state is retained.

Before activation: verify supplier/storage facts below and retain the confirmed
operator identity/contact details; apply reviewed remote migrations; deploy the
matching SPA/Worker; verify redaction, cleanup and inbox delivery; configure/exercise the
lifecycle subscription; then publish approved immutable documents using
`initial-rollout.md`. Inspect cron/queue bindings after deploy. Existing external
keys must work before/after an incomplete dashboard visit. Never roll back to a
Worker that ignores closure after exposing account deletion.

## Email subscription discrepancy

Reference: <https://developers.cloudflare.com/email-service/reference/event-subscriptions/>.
It lists source `email.sending`, scoped to domain/zone, and subscription events
`message.delivered`, `message.deferred`, `message.bounced`, `message.failed`,
`message.rejected`, `message.complained`. Payload types have the `cf.email.sending.`
prefix. Wrangler 4.160.1 exposes the source and zone/domain arguments, but Cloudflare
rejected both documented subscription names and prefixed payload names with:

> Validation error: Unrecognized event types for source type at "events"

Resolve through the Queues subscription UI or Cloudflare support; do not guess more
names or mark tracking active. Account: `7da0b3179a5b5ef4f1a2d1189f072d0b`.
Zone: `424f5bc38e5bb4978d669528ea55164d`. Domain: `egdata.app`.
After creation inspect source, six events, target queue and enabled state, then
correlate a real controlled-recipient send ID with its event. Email Routing deliveries
are not Email Sending lifecycle events. Confirm arbitrary-recipient behavior with a
real controlled inbox outside the routing list before relying on onboarding email.

## Outbox and incident handling

1. Inspect `GET /_dashboard/api/admin/notifications?offset=0` using an onboarded
   admin session. Page by 50 while `hasMore` is true. Check oldest unsent age,
   exhausted attempts, failure states and both queue backlogs daily during rollout.
2. `sent_at` means provider acceptance; queued is not delivery. Delivered means
   recipient-server acceptance, never reading. Duplicate/out-of-order events reconcile
   idempotently. Terminal failures outrank delivery, which outranks deferral. Events
   preceding the send response are reconciled when transport metadata is recorded.
3. Dispatch claims ten jobs/run with five-minute leases and at most eight attempts;
   errors back off exponentially to one hour. Five-minute cron gives a nominal
   ceiling of 120 jobs/hour plus action-triggered sends. Monitor backlog and size
   dispatch for real volume. Acceptance followed by a lost DB write can cause a
   duplicate retry; check provider evidence before manual replay.
4. Verification sends are synchronous and store transport metadata, never plaintext
   tokens. Their rows use `attempts=8` to prevent automatic replay. Ask developers to
   resend/change the inbox on Profile. Do not reset these rows for replay or bypass
   recipient suppression. Receipt content comes from immutable acceptance evidence.
5. Failed event handling retries eight times then dead-letters. Review/correct the
   cause before replaying to the events queue; confirm durable ingestion before
   acknowledging the dead letter. Never route email events into the usage consumer.
   Queues may contain recipient/subject/SMTP payloads even though the D1 lifecycle
   inbox keeps only event/message IDs, status and timestamps. Verify queue retention.

## Retention and daily checks

At 03:17 UTC the Worker runs project/session/usage and privacy cleanup. New privacy
deletes select at most 500 rows per table/run; pending verification cleanup is also
capped at 500. Inspect remaining eligible counts and rerun bounded cleanup to drain
backlogs. Existing account/mail/session cleanup retains its bulk deletes.

| Store | Local cleanup rule |
| --- | --- |
| Admin audit log | Older than 24 calendar months from creation |
| Limit requests | Non-pending, reviewed, older than 12 calendar months from review |
| Alert matches/reads/project associations | Older than 90 days from related change merge |
| Privacy cases and cascading actions | Resolved more than 12 calendar months ago; open cases remain |
| Pending email and token hash | Expired verification; verified contact remains |
| Notification outbox and cascading attempts | Older than 30 days from creation |
| Minimal lifecycle inbox | Older than 30 days from ingestion, bounded cleanup |
| Endpoint usage and usage dead letters | Existing 34-day date cutoff |
| Deleted projects | Existing 90-day recovery deadline |
| Closure tombstone | Existing 30-day registration hold |
| Closed-account acceptance evidence | Assigned `retain_until` deadline |

Calendar months clamp to the last day of shorter months. Cutoffs use strict
older-than comparisons. Check cleanup failures, remaining backlog, cascades and
restore effects without copying personal payloads into logs.

## Rights-request procedure

1. Receive requests at `contact@egdata.app`, including from non-account requesters.
   Record received time/minimal case reference through
   `POST /_dashboard/api/admin/privacy-requests`; use null owner where appropriate.
   Verify identity proportionately through support, not by copying identity
   documents or correspondence into the ledger.
2. Review the one-calendar-month deadline. Respond without undue delay. If complexity
   or volume justifies extension, notify within the original month then record reason
   and actual notification time through `/:id/extend`. Only one extension before the
   original deadline is allowed, to three months from receipt. Respond immediately
   to overdue cases rather than backdating evidence.
3. Scope every applicable store below. The Profile NDJSON export covers selected D1
   records only and ends with a complete marker; it is not a complete rights response.
   Recheck consistency if account records change during the paged export.
4. Perform work in each store, including processor copies and prior recipients when
   applicable. Preserve only justified legal evidence with recorded basis/expiry;
   explain limitations and complaint rights. Never rewrite immutable acceptance facts.
5. Record store/action/evidence references through `/:id/actions`. The ledger does
   not execute erasure or enforce restrictions. Verify the actual store action before
   recording completion. Deliver the response through a verified channel, then resolve.
6. Arrange suppression/re-erasure after restores. Keep cases open while work remains.
   Resolved evidence expires after 12 months; longer necessary restore/hold evidence
   needs a separately justified retention rule and storage procedure.

Historical Analytics Engine rows may contain raw IP/UA/Origin. New reporting redacts
them but does not delete them. Establish Cloudflare's available access/deletion/
restriction mechanisms and actual expiry; this remains an unresolved production
procedure, not completed erasure.

## Supplier/storage inventory

| Processing/store | Evidence | Production facts still needed |
| --- | --- | --- |
| Epic sign-in | Account ID/display name; separate verified contact; local icons | OAuth fields, roles/terms, transfers |
| Cloudflare Worker/D1/KV | Dashboard, credentials, contact, legal evidence and sessions in code | DPA/subprocessors, storage regions, transfer safeguards, backups |
| Analytics Engine | Local privacy-v1 minimization and historical reporting redaction | Last raw-write time after deploy, historical rights mechanism and actual expiry |
| Cloudflare email/queues | Sending enabled, queues created; operator inbox receipt confirmed; lifecycle subscription blocked | Arbitrary-recipient capability, lifecycle evidence, suppression, retention/regions |
| Logs/traces | Remote query redaction false; checked-in config true | Post-deploy inspection, retention, access/exports |
| Origin/API hosting | origin-api.egdata.app config and Aikido runtime instrumentation | Hosting contracts/regions, forwarded fields, Aikido mode/recipients/retention, abuse decisions |
| Support mailbox | contact@egdata.app channel | Mailbox/forwarding providers, DPA/regions, retention/access |
| Backups/restores | No complete production evidence inspected | Every store, expiry, access, restore suppression and processor deletion |
| Fonts/avatar UI | Bundled Fontsource and local icons | Production browser network smoke |

## Operator disclosure assessment

The operator confirms no payments, advertising, affiliate revenue, sponsorships,
donations or connection to a paid business. On these supplied facts, the working
assessment treats egdata as a free, non-commercial project. The drafts retain
Ignacio Aldama Vicente, Spain and contact@egdata.app. A public postal address/NIF
is no longer an unconditional publication blocker.

GDPR Article 13 requires controller identity and contact details; it does not
expressly require publication of a NIF or home address. Privacy obligations still
apply to the account/contact/usage processing. Spanish LSSI Article 10 includes
address and tax-identification disclosures for services within its scope. The
Annex includes free-to-recipient services where they constitute an economic
activity for the provider, so absence of in-app payments alone is not an exemption.
This assessment relies on the broader non-commercial facts confirmed above, not
merely a zero price. Reassess applicability and required disclosures before adding
commercial activity or if other facts establish an economic purpose.

Sources: [GDPR Article 13](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng),
[LSSI Article 10 and Annex](https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758).

Future mandatory-update notices, reminders, postponements and API deadlines remain
a separate phase.
