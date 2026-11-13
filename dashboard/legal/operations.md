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
  The operator subsequently confirmed a Paid plan; API plan inspection returned
  Cloudflare 10000 Authentication error. Paid-plan eligibility is not delivery evidence.
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

### Confirmed operator facts and read-only checks (2026-11-12)

- The operator alone has access to developer accounts, databases, analytics and
  support. There are no additional administrators, employees or contractors.
- Two servers run self-hosted services: Hetzner hosts MongoDB, OpenSearch and Redis;
  Google Cloud hosts the API, main website and another Redis instance. The operator
  confirmed the Hetzner location as **Nuremberg, Germany** and supplied the origin
  IP. RIPE RDAP identifies its allocation as `CLOUD-NBG1`, country `DE`, corroborating
  the location. `dash.egdata.app` is proxied; public DNS returns Cloudflare addresses
  and the available Wrangler credential was denied DNS-record access (10000).
- Read-only `gcloud compute instances list` reports `egdata-dockploy` in
  `europe-west1-d` (Belgium). This confirms the VM location, not exclusive EEA
  processing by Google or the location of every copy.
- Read-only `wrangler d1 info egdata-dashboard-db --json` reports Western Europe
  (`WEUR`), no jurisdiction restriction, and read replication disabled. Worker
  placement and a D1 region report are not global data-residency guarantees.
- Both custom anti-abuse and Aikido runtime enforcement were enabled when inspected.
  The operator subsequently approved removing the Aikido runtime integration.
  The local change removes the SDK, startup preload, global middleware and SDK
  identity hooks. Production removal awaits an origin deployment. The historical
  SDK heartbeat included IP/user-agent statistics, routes, user identifiers,
  package and outgoing-host information; historical retention/deletion must be
  checked separately. GitHub repository scanning is a separate integration.
- The operator clarified that the custom anti-abuse system and fingerprint store
  are on **GCP**, not Hetzner. Its fingerprint describes a technical client pattern
  (for example TLS characteristics and header ordering), without IP address, user
  agent or Cloudflare datacenter inputs. Do not confuse it with the removed
  Aikido IP/UA-derived identity. The custom system does not apply to v1 and is
  outside the developer/v1 agreement and notice; legacy transparency remains a
  separate task. No conclusion about identifiability is needed for that scope
  decision, and neither hashing nor the word "anonymous" proves it.
- MeiliSearch is unused, according to the operator. Its presence in source code
  does not establish a current recipient; it is omitted from the notice.
- Code review confirms `src/index.ts` mounts the v1 router before the custom
  anti-abuse middleware. The outer response observer records only requests carrying
  an `antiAbuseObservation`, which that legacy middleware supplies; it does not
  independently fingerprint v1 requests. Verify the deployed origin matches this order.
- Google Analytics is used on the main website, not the developer portal. The API's
  unversioned `/ping` route stores website events and forwards them to Google Analytics;
  it is outside the v1 router. Receiving those events is separate from ordinary
  developer-API usage analytics.
- `contact@egdata.app` is forwarded through Cloudflare Email Routing to the
  operator's personal Gmail account. No support/ticketing service is used. Discord
  was suggested as a possible future option, not adopted. The operator agreed to
  delete resolved support/privacy correspondence after 12 months, except evidence
  needed for a specific dispute. Mailbox and forwarding copies need separate
  handling from D1 cleanup. Do not infer Google's GDPR role for all message content
  merely from the absence of a consumer-mailbox processor agreement.
- The operator reports no separately retained server/access logs, database exports
  or backups outside Cloudflare's built-in storage. This is an operator statement,
  not a container-runtime/disk audit; review automatic logging and host snapshots
  before claiming their absence. Cloudflare observability/Issues is in use.
- Cloudflare is a standard self-service account upgraded to Paid, confirmed by
  the operator. Its Customer DPA is incorporated in the self-service agreement.
  Google's standard Cloud terms also incorporate the Cloud DPA; retain evidence
  of the applicable project arrangement. Hetzner DPA status is still being checked.
- Both an HTTP fetch and a rendered-browser visit to `https://egdata.app/privacy`
  returned the **About** page, not a privacy notice. Do not describe that URL as a
  verified main-site privacy policy. Correct the main-site notice separately; the
  developer notice must clearly state its own scope and rights contact.

| Processing/store | Evidence | Production facts still needed |
| --- | --- | --- |
| Epic sign-in | Account ID/display name; separate verified contact; local icons | OAuth fields, roles/terms, transfers |
| Cloudflare Worker/D1/KV | Standard self-service DPA; dashboard, credentials, contact, evidence and sessions; D1 WEUR, no jurisdiction restriction | Retain supplier/transfer evidence; verify Paid D1 automatic 30-day Time Travel and restore handling |
| Analytics Engine | Local privacy-v1 minimization and historical reporting redaction | Last raw-write time after deploy, historical rights mechanism and actual expiry |
| Cloudflare email/queues | Paid plan confirmed; sending enabled, queues created; operator inbox receipt confirmed; lifecycle subscription blocked | Controlled external-inbox delivery, lifecycle evidence, suppression, queue settings/regions |
| Logs/traces | Remote query redaction false; checked-in config true | Post-deploy inspection, retention, access/exports |
| Origin/API hosting | Self-hosted Google Cloud API/website/Redis in europe-west1-d; Hetzner MongoDB/OpenSearch/Redis in Nuremberg; MeiliSearch unused | Hetzner DPA status, Google Cloud arrangement, deploy Aikido removal and resolve historical provider retention |
| Support mailbox | Cloudflare Email Routing to personal Gmail; sole operator; 12-month resolved-mail deletion adopted | Provider roles/contract and transfer assessment; implement mailbox review/deletion procedure |
| Backups/restores | Operator reports no separate backups/exports; Cloudflare built-in recovery remains | Verify automatic host/container copies; expiry, restore suppression and processor deletion |
| Fonts/avatar UI | Bundled Fontsource and local icons | Production browser network smoke |

### Manual mailbox and upstream rights work

Review resolved support/privacy correspondence monthly and delete messages older
than 12 months from resolution, including sent copies and attachments; clear Trash
as the mailbox permits. Retain dispute evidence separately only with a recorded
reason, limited access and an end/review date. Earlier applicable erasure or
restriction requests take precedence over this routine schedule.

Account closure automatically handles the developer D1 account records described
in the rollout guide. It does **not** erase Hetzner/GCP stores, Aikido, Analytics
Engine or the Gmail mailbox. For each rights request, identify relevant records
there, perform and verify the action or escalate to the provider, and record the
actual result. A data export, a reporting redaction, or waiting for ordinary expiry
alone is not evidence that an applicable erasure/restriction duty was fulfilled.

### Supplier actions and publication evidence

- **Hetzner:** open <https://accounts.hetzner.com/account/dpa>. Its
  [official instructions](https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner/)
  explain how to inspect/conclude the agreement and select data types and affected
  groups. A handwritten signature is not required. Record the agreement date and
  covered services privately; do not commit personal contract documents.
- **Aikido runtime removal:** deploy the new origin build and start command; inspect
  Dokploy/container commands and `NODE_OPTIONS` for any external instrumentation
  preload. Remove unused runtime credentials from the deployment after cutover.
  Confirm the SDK is absent and no runtime heartbeats continue. Record the last
  possible send time; request deletion or obtain concrete retention information for
  the runtime application's historical data. Keep the notice's historical disclosure
  until the applicable records are confirmed gone. The new agreement is not
  retroactive; ongoing personal-data retention is a separate privacy matter.
- **Scope:** the developer documents cover the portal, accounts/keys, console and
  `/v1` API. Custom legacy anti-abuse and main-site GA are separate. The scope does
  not create a GDPR exemption for legacy processing or substitute an email address
  for a complete notice where proactive information is required. Repair the main
  site's notice and legacy disclosures in their own publication workflow.
- **Necessity and safeguards:** record the necessity/balancing review for API
  delivery, organizational contacts, diagnostics, security and evidence retention.
  Assess material effects of automated access decisions on the actual use cases;
  a review mailbox alone does not establish an Article 22 exception. Keep human
  review real and documented; do not claim that accepting the terms supplies
  consent for security profiling or makes significant automated decisions lawful.
- **Retention:** the completed Privacy Notice uses the implemented D1 cutoffs, the
  operator-approved mailbox procedure, documented Cloudflare product limits, and
  purpose-specific criteria for security/issue records. Earlier 14-day diagnostic,
  30-day incident and 35-day backup targets were not verified universal provider
  limits and are not represented as such. Confirm actual queue/issue settings and
  provider rights handling before activation. No historical erasure is claimed.

Sources checked 2026-11-12: [Cloudflare DPA](https://www.cloudflare.com/cloudflare-customer-dpa/),
[Google Cloud terms](https://cloud.google.com/terms),
[Aikido runtime data](https://help.aikido.dev/zen-firewall/miscellaneous/data-sent-by-aikido-zen),
[Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/),
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
Direct-provider Mistral Large 4 reviewed the legal wording and scope. Its advice
was checked against actual code/facts; it is not evidence of account-specific
contracts, deployment, deletion or an approved impact assessment.

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
