# Developer legal documents and enforcement plan

- **Version 1.0 (free/non-commercial baseline, finalized 2026-11-12):** unpublished and not effective; preserved intact.
- **Version 2.0 (paid plans & Stripe billing, drafted 2026-11-13):** covers Free (`free-v1`), Pro (`pro-v1`, EUR 9/mo), and Scale (`scale-v1`, EUR 19/mo) plans, Stripe Checkout/Billing Portal, 14-day initial daily limits, 14-day statutory withdrawal with pro-rata refund and one-per-account self-serve limit, 3-day `past_due` grace period, and billing/Stripe privacy disclosures. **Contains `[TO COMPLETE]` placeholders for Spanish LSSI Art. 10 / consumer pre-contract operator details (postal address, NIF, tax/VAT invoicing status)** and is blocked from SQL preparation until completed.

- [Developer Terms of Service, version 2.0 (draft)](terms-2.0.md)
- [Developer Privacy Notice, version 2.0 (draft)](privacy-2.0.md)
- [Developer Terms of Service, version 1.0 (free baseline)](terms-1.0.md)
- [Developer Privacy Notice, version 1.0 (free baseline)](privacy-1.0.md)
- [Proposed agreement/access API error contract](api-agreement-errors.md)
- [Initial rollout and publication steps](initial-rollout.md)
- [Production evidence and privacy/email operations](operations.md)

The two versioned Markdown files contain the completed reader-facing text, with
operational instructions kept here and in the rollout guide. They describe the
intended initial deployment and must be published only after that deployment is
confirmed. Completing these files does not deploy or activate anything.

The publication command records the actual publication time and SHA-256 of each
exact UTF-8 body. Both documents point to the public version history for that
record; no preparation date is presented as an effective date. The Privacy Notice
applies from publication, while an individual's initial terms agreement starts
on express acceptance. The later material-update policy has its own notice and
effective-time rules. Do not edit a published version.

The completed documents use the confirmed Cloudflare self-service Paid account,
Google Cloud Belgium and Hetzner Nuremberg hosting, and personal Gmail mailbox.
They cover the portal/accounts/keys, console and `/v1`, excluding legacy custom
anti-abuse and main-site GA. The operator approved removal of Aikido runtime;
that code change awaits deployment and historical provider data needs separate
handling. [Operations](operations.md) records the evidence and remaining actions.

## Initial implementation (portal-only rollout)

Migration `0008_developer_accounts.sql` seeds no documents or requirement. After
explicit publication, first/returning dashboard visits require a **verified email
before explicit terms acceptance**. Existing API keys keep working even if their
owner visits without completing onboarding. A visit never starts an API cutoff.
New projects, keys, and console sessions require completed onboarding. Existing
console sessions also check dashboard eligibility on each call.

The account popover offers Profile and Log out. Email-only editing and account
deletion remain available at `/profile` throughout onboarding. Epic manages the
display name. Replacement emails do not
replace a verified address until confirmed. Verification links use fragment codes,
require authenticated same-origin confirmation, and survive same-tab Epic login in
short-lived session storage. Codes are hashed in D1, expire after 30 minutes, and
are replaced on resend; sends are limited to one per minute and five per UTC day.

Acceptance stores immutable terms/privacy references, a receipt ID and server time.
`/profile/receipts` offers Print / Save as PDF with full recorded documents; the JSON
endpoint remains for compatibility. Receipt emails link to the signed-in view.
Public immutable versions are
available at `/terms/:version` and `/privacy/:version`; `/legal/history` lists their
hashes and publication times. Privacy is informational, never an acceptance gate.

Deletion requires typed confirmation and login within 10 minutes. One D1 batch
deletes active account/project/key/contact data and retains minimal acceptance
evidence for the selected five-year target. A 30-day closure tombstone prevents
re-registration and rejects all sessions and warm key caches through primary reads.
Requests already admitted can finish. Evidence from a closed account does not
satisfy a subsequently re-registered account. Other analytics/audit/mail/backups
remain governed by separately verified retention and rights procedures.

`developer_mail` provides leased, bounded retries for receipts and old-address/
closure notices, with 30-day outbox cleanup. It is **not** the future material-update
notification ledger. Initial delivery/bounce reconciliation is implemented locally;
production subscription creation is blocked by Cloudflare validation. Deadline
activation, notice postponement and independent restriction controls below remain
future work. Analytics minimization, bounded D1 retention, account export and
rights-case tracking are implemented/tested locally and await deployment.

See [initial rollout operations](initial-rollout.md) for deployment/publication steps.
See [privacy/email procedures and inventory](operations.md) for current production
evidence, unresolved supplier facts, rights handling and email activation.
Sections below describe the full target design; future mandatory v1-update enforcement
must not be enabled as part of this initial grandfathered rollout.

## Confirmed requirements

- Operator/controller: Ignacio Aldama Vicente, Spain, contact@egdata.app.
- Access is currently free. No contractual uptime SLA or paid plan is offered.
- Personal and commercial applications are permitted, subject to third-party
  rights, acceptable use, and restrictions on bulk database extraction.
- Paid distribution requires attribution to Epic Games as the source and
  egdata.app for aggregation, normalization, and unification.
- Initial protected dashboard access requires verified email and explicit terms
  acceptance, while existing API keys continue working. Material terms updates
  require renewed acceptance, with 30 calendar days' notice for ordinary changes.
  Missing the announced deadline pauses protected dashboard, console, and API-key
  access until acceptance. Editorial updates do not trigger a pause.
- Terms and privacy notices have independent immutable version histories.
- Privacy updates are informational and non-blocking. Any future optional
  consent is purpose-specific and separate from terms acceptance.
- Urgent, justified restrictions can be imposed independently of agreement
  status. Acceptance cannot lift a security or rights-related suspension.
- Existing bounded, lawfully obtained caches may remain usable after a pause or
  account closure under the terms applicable when obtained. Attribution and
  extraction restrictions survive, as do specific lawful stop-use/removal duties.
  This permission grants no new API access or refreshes.

## Adopted update policy

| Publication/action | Notice and action | Access consequence |
| --- | --- | --- |
| Initial terms | Verify email; present terms and privacy notice; explicitly accept terms | Dashboard/console gated; existing API keys keep working |
| Editorial terms revision | Archive and summarize; no change to rights or obligations | No renewed acceptance or pause |
| Ordinary material terms revision | 30 calendar days' advance email/portal notice; allow early acceptance | Automatic pause at the announced effective time if acceptance is missing |
| Urgent material terms revision | Shorter notice only where justified by security, legal, or third-party-rights needs; record reason | Pause for missing acceptance at the specifically announced effective time |
| Independent urgent restriction | Assess reason, scope and urgency; notify where practicable and provide review | Restrict affected access independently; acceptance does not lift it |
| Privacy notice revision | Archive; proactively notify important changes before changed processing begins | No acknowledgement requirement or API pause |
| Optional processing requiring consent | Explain the purpose and obtain separate, withdrawable consent before processing | Disable that optional processing if declined, not core API access |

The 30-day period is the chosen ordinary terms-update policy, not a universal
statutory deadline. Applicable mandatory consumer protections still apply;
neither the developer label nor free access establishes that every user is B2B.

## Adopted drafting choices and remaining production facts

1. **Commercial distribution:** the draft permits charging for applications and
   bounded data outputs with attribution, without an egdata fee or case-by-case
   permission. A whole-database or substantial-database mirror needs separate
   written permission, even with attribution. Attribution is encouraged, rather
   than mandatory, for free distribution.
2. **Operator details:** the operator confirms no payments, ads, affiliate revenue,
   sponsorships, donations or connection to a paid business. The current working
   assessment treats egdata as non-commercial; retain name, Spain and contact email.
   Do not require a public home address/NIF unconditionally. Reassess Spanish LSSI
   scope and any applicable disclosures if the economic context changes; see
   [operations.md](operations.md). Privacy obligations remain applicable.
3. **Privacy operations:** confirm production suppliers, international-transfer
   arrangements, and capability to implement the selected retention/minimization
   schedule in section 6. Policy defaults are chosen; actual deployments and
   legally justified exceptions still need verification.

### Review decisions

- Add scoped survival, severability, and transfer provisions. Transfers preserve
  mandatory rights and require consent where legally necessary; the draft does
  not grant an unconditional assignment right or release the existing operator.
- Keep statutory jurisdiction. Spanish LEC Article 54.2 restricts express forum
  submission in adhesion contracts and imposed general conditions as well as
  consumer contracts, so a blanket business-user domicile clause is unsuitable.
  Cross-border jurisdiction also needs assessment under the applicable rules.
- No monetary business-liability cap has been selected. The current draft sets
  none; best-effort availability is not a substitute for a cap. Any proposed cap
  needs a separate business decision and review of its scope and exclusions.
- English is the initial publication language and prevails over any translation
  we provide to the extent permitted by law, preserving mandatory language,
  transparency, and consumer rights. Review any future translation's contractual
  status before publication and preserve locale-specific text and acceptance evidence.
- Promise closure processing without undue delay, rather than inventing a fixed
  30-day deletion deadline. Keep closure, GDPR response deadlines, and justified
  retention distinct, and define the supporting operational procedure.

## 1. Version and evidence model

Use independent `terms` and `privacy` documents, starting at `1.0` each.
Every published revision is immutable, including minor wording corrections.
An unpublished draft can be edited. Public versions remain readable without
authentication at `/terms/:version` and `/privacy/:version`; current pages live
at `/terms` and `/privacy`. Include downloadable text and change summaries, and
clearly label current versus upcoming documents. Publication alone never changes
which terms acceptance is required by the gateway.

Separate a document version from a **terms edition** (the set of substantive
rights and obligations). A material terms change creates a new edition and an
explicit acceptance requirement. An editorial-only version can remain in the
same edition after the publisher records why its meaning is unchanged. Accepting
any published version in that edition satisfies that edition's requirement.
Never infer equivalence from a version-number prefix or semantic-version ordering.

Evidence always identifies the exact text actually accepted. An editorial
revision does not rewrite old evidence or claim the user clicked the new version.
New users can accept the latest editorial revision in the current edition.
Privacy versions have no terms-edition membership and never satisfy or create
an acceptance requirement.

Proposed D1 entities:

| Entity | Contents |
| --- | --- |
| `legal_document_versions` | Kind, version, locale, exact Markdown body, SHA-256, publication time, summary; terms-edition ID for terms only; classification and reason; unique kind/version/locale |
| `legal_requirement_releases` | Immutable release ID, required terms-edition ID, notice/effective times, ordinary/urgent classification, publication actor/reason, previous release |
| `legal_policy_state` | Current/scheduled release references and monotonic revision; controlled activation, not Worker build constants |
| `legal_acceptances` | Account ID, exact terms version/hash, terms-edition ID, server time, presentation revision; unique account/terms-version |
| `developer_contact_addresses` | Account ID, verified address, verification time; separate pending address and expiring, single-use verification-token hash |
| `legal_notifications` | Recipient account/address snapshot, document/release ID, channel, exact message snapshot/hash, dispatch time, provider delivery/bounce/failure status; idempotent notification key |
| `legal_access_restrictions` | Global/account/project/operation restriction, reason, start/end, actor; independently audited activation and lifting |

Store authoritative content in D1 when publishing from reviewed repository
files, so an old SPA or Worker build cannot present different text for a
required version. Hash the exact UTF-8 bytes, including defined line endings.
Reject attempts to republish an existing version with different content.
Published versions and evidence are append-only during their retention period;
privacy erasure/retention procedures still apply to account-linked evidence.
Do not cascade evidence deletion merely because a project is deleted.

Privacy notification is evidence of what was communicated, not agreement or
consent. A send/delivery event must not be called proof the recipient read it.
Do not add a mandatory privacy checkbox or include notification status in the
API eligibility query. If the portal records presentation or dismissal, label
those events accurately and retain only what is needed. Any future optional
consent needs its own purpose-specific control, evidence, and withdrawal mechanism.

## 2. Strong API enforcement

Future mandatory v1 API-deadline phase, not the initial portal-only rollout.
Legacy/unversioned data routes are outside this agreement; account closure and
independent credential/security controls still apply to them. For every covered request:

1. Authenticate the key or dashboard/console session.
2. Resolve its account and project identity.
3. Read the effective terms-edition requirement, acceptances, and independent restrictions
   in one indexed query against the D1 primary.
4. Reject restricted or out-of-date accounts before quota admission, usage
   outbox writes, response-cache lookup, or upstream access.
5. Continue through existing permissions, quotas, and response handling.

Use direct `env.DB` queries for this decision. Cloudflare documents that queries
without the Sessions API execute on the primary; do not introduce unconstrained
replica reads here. Do not cache positive legal-access decisions in KV, isolate
memory, cookies, local storage, or response caches. Existing cached key identity
can still identify the account, but cannot carry authoritative agreement status.

This adds one primary database read per protected request. Measure regional
latency, indexed rows read, and cost in staging. Prioritize the requested strict
cutoff over a TTL that permits several minutes of use under outdated terms.
Optimize only if equivalent freshness and failure semantics are demonstrated.

Define the cutoff precisely: access checks performed after an activation or
restriction commits must observe it. Requests admitted before that point may
finish; this mechanism cannot recall delivered data or cancel all in-flight work.
If the decision store is unavailable or its state is inconsistent, return an
uncacheable `503 LEGAL_STATUS_UNAVAILABLE`, rather than allow access.

Missing terms acceptance returns `403 AGREEMENT_REQUIRED`, with the required terms version,
effective time, and a fixed portal review URL. Use RFC 9457 Problem Details for
v1 and the established dashboard error envelope for private portal routes. Independent
suspension returns `403 ACCESS_SUSPENDED`. Preserve CORS and request IDs. Record
denial telemetry, but do not charge successful-admission quota for these denials.
The [error contract](api-agreement-errors.md) specifies envelopes, fields,
HEAD behavior, and client recovery. Keep the chosen `AGREEMENT_REQUIRED` code
for missing terms acceptance; do not introduce a competing alias. Privacy
publication, unread notices, or declined optional consent never cause this error.

Before the effective time, existing accounts that accepted the current edition
remain eligible even if they have not accepted the upcoming edition. A notification
banner can be shown without mounting the blocking screen or returning a 403.
Use the database clock at request admission for scheduled activation; do not
depend on a cron job running at the deadline. An ordinary release's effective
time and enforcement deadline are the same instant, not two hidden grace periods.

An agreement pause does not revoke, delete, or rotate keys. Completing the flow
restores otherwise-valid credentials. Expired/revoked keys, deleted projects,
exhausted quotas, and independent suspensions remain blocked. Acceptance never
resets quota counters or overrides a rights-related suspension.

Credential exposure is a separate security event. The terms permit protective
revocation following a credible report or detection, without promising an
automated repository scanner. If a detector is added, match a full credential
by hash rather than revoking from a prefix match, avoid storing/logging the raw
secret, audit the action, and notify the owner where practicable. A leaked-key
revocation is permanent and must not be cleared by an agreement action. Any
claim of immediate revocation must also address the existing key-metadata cache.

Public project showcases are a separate feature and permission decision. Public
availability of a project or repository is not permission for egdata to use its
name, logo, or developer identity in promotional material. Do not bundle a
showcase licence into credential-protection wording.

## 3. Verify covered access paths

Verify authentication and origin controls for covered v1 routes before the future
mandatory-update phase. Legacy `REQUIRE_API_KEY` settings and first-party Origin
bypasses do not expand this agreement to unversioned routes or GraphQL. Any future
legacy agreement requires its own scope, notice and rollout decision.

- Require authenticated credentials on covered v1 data routes. A browser origin
  is not a credential; never ship a server secret in the public web application.
- Inventory public exclusions, especially sitemap routes. Keep only deliberately
  public resources public, and document that account agreements cannot restrict
  anonymous access to those resources.
- Cover `/v1` requests on `api.egdata.app` and protected dashboard console paths,
  including HEAD, conditional requests, cache hits, and active console sessions.
- Confirm origin authentication and alternate-host routing prevent direct access
  around the gateway. Inspect shared/CDN caches before the Worker too.
- Preflight, authentication callbacks, public documents, and health endpoints can
  remain available without granting access to protected data.

The repository configuration describes intended behavior, not verified live settings.

## 4. Portal flow and race handling

- User upsert is split from default-project provisioning in `worker/db.ts`.
  OAuth creates no project; session refresh provisions only when eligible.
- Session bootstrap returns authentication, current and upcoming terms requirements,
  exact acceptances, contact-verification and restriction status, and informational
  privacy notices. Withhold protected dashboard data only when ineligible.
- Protect management endpoints through shared middleware, including nested admin,
  analytics, alert, quota, and console routes. Administrators must also agree.
- Leave document viewing, status, acceptance, logout, console termination, and
  contact repair, account recovery/closure, and support/privacy requests accessible
  during the pause. Permit narrowly scoped credential-status and revocation
  actions. Retain authentication and identity checks for sensitive recovery actions.
  Create replacement keys only after current agreement and independent security
  eligibility checks; never restore a revoked key or bypass quotas by replacement.
- During an update's notice period, show a persistent, non-blocking banner with
  the change summary, UTC deadline/local display, and early-acceptance link.
  At initial activation or after a missed deadline, render a full-page review
  screen before mounting protected content/hooks.
   Serve it at `/profile/agreements`, the stable URL returned in API errors;
   retain `/agreements` as a compatibility redirect.
  Show the terms, changes, effective date, and an unchecked box:
  “I agree to the Developer Terms of Service vX.” Present the Privacy Notice as
  an informational link/notice with no required checkbox. Offer “Agree and
  continue” and “Sign out.” Optional processing consent belongs in its own flow.
- Preserve API error codes in `src/lib/api.ts`; handle agreement errors centrally
  in `auth-context.tsx`, clear in-memory console credentials, and recheck on focus
  and navigation. Use cross-tab notifications as a UX aid, not authorization.
- Acceptance submits the exact terms version/hash and the displayed requirement
  revision. Derive identity from the authenticated session, never the request body.
- Validate and insert evidence using conditional SQL in a D1 transaction/batch.
  Stale or superseded submissions return `409 AGREEMENT_CHANGED`; do not silently
  accept text the user did not see. Repeated valid submissions are idempotent.
- Permit early agreement to a published upcoming edition. It does not undo
  current acceptance or make new duties apply early. New users must accept the
  current edition and can separately accept the upcoming one. A materially
  replaced upcoming edition needs fresh acceptance and a fresh ordinary notice
  period; an equivalent editorial revision does not invalidate existing evidence.
- Return a receipt with the exact terms version/hash, server timestamp, and
  archive links. Make it printable/savable and queue an email linking to the
  signed-in receipt view; delivery can fail without removing the account copy.
  Refresh server status before unlocking the UI. Do not infer acceptance from
  login, continued use, scrolling, or a prechecked box.

## 5. Publication and emergency operation

Separate deployment of legal support from publishing and activating documents.
Add a controlled, audited publisher command for reviewed files rather than a
general-purpose rich-text editor in the first release. Validate schema, links,
hashes, finalized metadata, and absence of draft markers before publication.
Remove internal implementation-plan references from the public text and resolve
every TO COMPLETE/TO CONFIRM placeholder before assigning the final content hash.
Before the effective date, verify that the final Developer Privacy Notice and
public version-history archive are deployed, accessible without authentication,
and linked from the agreement flow. Draft files alone do not satisfy publication.

### Ordinary material terms changes

Publish the document and summary, dispatch the initial notice to verified
developer contacts, and announce an effective time at least 30 calendar days
after advance notice is provided. Allow early acceptance. Remind accounts still
missing acceptance approximately seven days and one day before the deadline.
At the announced effective time, missing acceptance automatically pauses access.

The operator classifies each revision and records the reason. Changes to permitted
uses, extraction/redistribution rights, attribution duties, liability, or update
and suspension rights are material. Correcting a typo or formatting without
changing meaning is editorial. A doubtful substantive change takes the material
path, not the editorial path. Initial terms require acceptance before protected
dashboard/console access; existing external API keys remain usable.

Previously accepted terms govern use during the notice period. After the cutoff,
do not represent a non-accepting account as bound to the new edition: access is
paused pending acceptance, and existing obligations survive only as applicable.
Preserve review, support, closure, and rights channels during the pause.

Store immutable scheduled-release metadata. Cancellation or postponement is a
new audited event, with updated notices; it cannot silently move a deadline
earlier. A material rewrite of a scheduled edition restarts ordinary notice.
Use a new explicitly justified urgent release when a shorter deadline is needed.

### Editorial and privacy publications

Editorial terms revisions publish within the same terms edition without changing
the gateway's acceptance requirement. Privacy publications update the privacy
archive and trigger appropriate notices, never the terms gate. Notify important
privacy changes before the changed processing begins; allow enough time to
understand and exercise applicable rights. Do not assume a universal 30-day
privacy rule or that notification authorizes a new processing purpose. Obtain
separate consent first where the new optional processing relies on consent.

### Urgent restrictions

For an Epic Games/rightsholder restriction:

1. Assess the request's basis, affected use, and urgency. A private request is
   not automatically a legal order; contractual or other legal obligations may
   still justify or require action.
2. Where justified, immediately restrict the affected operations/accounts/projects.
   Use a global pause only where necessary and proportionate. Audit actor,
   reason, scope, and any shortened notice, and provide a review channel.
3. If substantive terms need to change, publish a new edition with its specific
   effective time and explanation. Require acceptance for continued permitted
   use at that time; use ordinary notice unless urgency justifies shortening it.
4. Independently review and lift restrictions when appropriate. Acceptance alone
   neither demonstrates compliance nor authorizes a prohibited use case.

Acceptance alone cannot prove what a downstream application does. A forbidden
use case may need manual review or technical endpoint/data restrictions. A global
agreement update is useful but is not a substitute for stopping an ongoing use.
Support a global emergency pause as well as account/project pauses.

### Verified contact and reliable notice

The initial implementation provides a separate verified developer contact address.
Before the first ordinary mandatory-update rollout, complete reliable delivery and
bounce handling. Current Epic login stores a synthetic
`@accounts.epicgames.com` value; it must never be used as a notification address.
Current limit-request email delivery is to the administrator, not all developers.

- Collect and verify an address during onboarding before first key/console
  activation. Existing accounts need a communicated contact-onboarding phase;
  do not treat missing historical contact information as terms refusal.
- Use authenticated, same-origin contact changes, rate-limited verification,
  expiring single-use tokens stored as hashes, and notification to the previous
  address when it is changed. A pending change must not replace a verified contact.
- Send ordinary material-update notices by email and portal. Include the actual
  change summary, effective time, acceptance/exit instructions, and a retainable
  copy of the exact terms, rather than only a mutable web link. Preserve message
  snapshots and transport outcomes. A printable page alone is not assumed to meet
  every applicable durable-medium requirement.
- Retry initial delivery failures, surface bounces, and provide a contact repair
  flow. Do not activate an ordinary release when known initial dispatch failures
  would deny affected accounts the promised notice period: resolve the failure
  or postpone the release with an audited event and a new notice. For the promised
  ordinary period, use the later of portal availability and successful initial
  dispatch to each verified contact, subject to applicable notice requirements.
  Treat known bounces as failures, including asynchronous bounce reports. Portal
  publication alone is not fallback delivery. A provider's acceptance of a send
  request is not proof of recipient delivery; retain transport outcomes and handle
  subsequent failures. Use a release-wide postponement in this initial design
  when needed to preserve every affected account's full notice period; do not
  silently introduce per-account effective editions. Properly communicated but
  unopened notices do not restart the period. Delivery is not proof of reading;
  neither a read receipt nor an email open is acceptance.
- Contact changes trigger a resend of pending notices. They do not silently reset
  a previously properly communicated deadline. Reminders do not extend deadlines.
- Keep legal/security notices separate from optional marketing. The first release
  needs no email open-tracking pixels. Record only delivery data needed for notice
  and troubleshooting, under the approved retention schedule.

### Retained data and closure

Document the limited continued-use permission in closure confirmations and
agreement-pause guidance. Do not automatically demand cache deletion solely
because an account closes or declines new terms. Existing bounded caches stay
subject to the edition applicable when obtained; a new edition must not silently
rewrite those permissions. Preserve acceptance histories under the approved
retention schedule, without introducing indefinite per-record acquisition logs.
Separate written bulk grants must specify scope, duration, withdrawal conditions,
and retained-data treatment rather than assume unlimited or irrevocable access.

For a specific stop-use/removal demand, identify the affected material, basis,
required action, and review channel where lawful. A gateway suspension only stops
new requests and does not delete downstream copies. Closure must revoke access
and address active sessions and credential caches, then confirm completion;
lawful retained copies and justified operator-side record retention are separate.

Application rollback must retain current required versions and restrictions.
Never roll back to a Worker that ignores an active gate. On a broken release,
use a compatible maintenance response or audited compensating policy release;
do not edit historical text or downgrade requirements silently.

## 6. Privacy work grounded in the current implementation

### Selected privacy defaults (2026-11-12)

The operator delegated the remaining policy choices. Mistral Large 4 provided
advice only; the following choices incorporate that advice with shorter routine
retention and clear distinctions between closure, response deadlines, and erasure.
These choices are implementation targets, not assertions about current production.

- **Fonts:** bundle pinned Fontsource Inter/JetBrains Mono variable packages in
  the Vite build; serve hashed font files through the existing same-origin Worker
  static-assets binding. Keep font licenses in `public/font-licenses.txt`. No
  separate GCS/R2 bucket or third-party browser font service is needed.
- **Avatar:** render a local account icon. New logins/upserts use an empty avatar
  field for compatibility, and migration 0010 clears stored legacy URLs. Verify
  migration and old signed-session expiry in production.
- **Owner reporting:** aggregate request counts, status/performance, country, and
  coarse client categories only; do not expose raw IPs, raw user agents, or stable
  per-person hashes by default. Historical owner-visible raw records need a
  transition and rights-handling decision before the new notice takes effect.
- **Routine analytics:** minimize at write, not just at read. Remove raw IP/UA
  from Analytics Engine writes. A display window or hash does not establish
  deletion/anonymity. Retain security-only data separately when necessary, with
  restricted access and usable erasure/restriction controls.
- **Security decisions:** prefer observation for new custom rules and human-reviewed
  targeted restrictions before enabling broader automated mitigation. Existing
  production modes are unknown; do not silently disable active protections or
  claim observation has no effects when a targeted enforcement trial exists.

Historical planning schedule (superseded where different by the completed Privacy
Notice and `operations.md`; not a production inventory):

| Records | Selected target |
| --- | --- |
| Account/projects/keys on verified closure | Prompt access revocation; ordinary-record deletion within 30 days, with necessary residuals isolated by category |
| Current verified contact | Account lifetime plus up to 30 days for closure; minimum address evidence may survive only in justified legal-notice records |
| Previous contact/address-change event | 90 days after replacement; no default full address history |
| Verification token | Hashed, single-use, 30-minute validity; remove on use; daily expired cleanup targeting 24 hours |
| Support/limit-request correspondence and mailbox copies | 12 months after resolution |
| Endpoint alert associations and reads | 90 days from the related change's merge time; bounded daily cleanup |
| Admin audit | 24 months after action |
| Terms acceptance and material legal-notice evidence | Account lifetime plus 5 years after closure; minimum evidence only, post-closure restricted to justified evidence/claims needs; verify necessity and applicable limitation rules before publication |
| Routine email delivery/verification troubleshooting | Outbox/attempts: 30 days from job creation; minimal lifecycle events: 30 days from ingestion |
| Routine diagnostics | 7 days, query strings/secrets redacted |
| Necessary security-only raw IP/UA diagnostics | At most 14 days in rights-manageable storage; no default owner access |
| Incident records | 30 days after resolution; specific claim/obligation holds separately justified |
| Backups | Rolling expiry within 35 days, subject to verified provider capability and any specific legal duty |

Keep the existing 34-day daily usage cleanup and separate 90-day project-recovery
policy, but do not treat either as permission to delay a required erasure. Do not
invent a 90-day account-deletion grace period from the project-recovery window.
The selected 30-day closure target is operational; GDPR response is one calendar
month, with a lawful extension of up to two further months, not a universal deletion
deadline. For necessary holds, record basis, minimum scope, custodian, and end or
review date; review at least every six months and delete when justification ends.

The five-year evidence target is a selected cap for ordinary post-closure retention,
not a claim that Spanish/EU law mandates keeping every record that long. Review
necessity by claim/purpose and shorten where appropriate. Mail duplication must
not defeat the schedule. Provider retention, access/erasure capabilities, transfers,
historical Aikido records are factual publication dependencies that delegated
discretion cannot establish. The earlier 14/30/35-day security/backup targets above
are planning targets, not verified universal provider retention. The current
Privacy Notice and operations inventory supersede them with applicable
product limits and purpose-specific criteria. The operator has supplied
identity/contact details and confirmed the current non-commercial context.

### Current code and deployment checks

| Finding | Publication/implementation consequence |
| --- | --- |
| Local routine analytics omits raw IP, categorizes user agents, and retains Origin presence/country with account/project/key IDs and request metadata | Verify deployment and last historical raw write; reporting redaction does not erase historical rows |
| Local owner/admin reporting redacts historical IP/UA/Origin into country, coarse client categories and Origin presence | Verify production behavior and historical analytics rights handling; administrators retain broader platform reporting scope |
| Fonts are bundled from pinned Fontsource packages; local icons and empty avatar upserts are implemented; migration 0010 clears stored URLs | Verify deployed browser requests, migration completion and old signed-session expiry |
| Custom anti-abuse enforcement and its technical-pattern fingerprint store are on GCP; `/v1` bypasses the challenge middleware | Outside the developer/v1 notice; disclose legacy processing separately and distinguish these fingerprints from the removed Aikido IP/UA identity |
| `upstream.ts` can forward trusted transport signals; custom security stores contain derived identifiers, risk windows, and challenge telemetry | Inventory origin processing as well as the gateway, including Redis, local state, recipients, exports, and retention |
| Local Aikido runtime removal deletes the SDK, middleware, identity hooks and startup preloads | Deploy the origin and inspect external startup settings; resolve historical retention/deletion without implying retroactive terms acceptance |
| Persisted Worker invocation logs are enabled; remote query-string redaction was false, while the checked-in configuration sets true | Verify post-deployment settings, actual logged fields and production retention |
| Daily usage/dead letters use a 34-day date cutoff | Document approximate daily-cleanup retention, not instantaneous deletion |
| Soft-deleted projects have a 90-day recovery deadline and bounded daily purge | Distinguish deletion/recovery from eventual purge and independent analytics retention |
| Local bounded cleanup covers admin audits, reviewed limit requests, alerts, resolved rights cases and expired verification tokens | Verify daily execution/backlogs in production; mailbox/provider copies need separate controls |
| Cloudflare Analytics Engine documents three-month retention | Verify the deployed service and any exports; a dashboard query window is not a retention period |
| Cloudflare self-service Paid, GCP Belgium, Hetzner Nuremberg and Cloudflare Routing to personal Gmail are confirmed; MeiliSearch unused | Follow the remaining supplier/retention actions in operations.md; no European-only processing guarantee |

Keep privacy rights and account-closure requests available by email even when
the user declines an update or is suspended. Define an operational deletion
procedure that covers D1, analytics limitations, logs, backups, and support mail.
Account-linked audit evidence cannot simply be declared “anonymous.”

### Purpose-specific legal bases and deployment inventory

Review the operation-level inventory before publishing the completed documents.
Distinguish individual contracting
developers, organizational representatives, and application end users. Map account
and contact administration, API delivery, security, owner-visible reports,
acceptance/notice evidence, claims, and statutory rights handling separately.
Use GDPR obligations for privacy information/rights handling, and identify the
specific binding duty before relying on legal obligation for other disclosures.
Do not treat a private rights-holder complaint as a disclosure obligation.

Complete necessity and balancing assessments for each legitimate-interest purpose;
include recipients and end-user impact, not just egdata's operational benefit.
Apply the selected minimal fields and retention, including aggregate-only owner
reports. Verify that the deployed portal fonts and account icon make no external
Google Fonts/Epic-avatar requests; verify legacy avatar cleanup and session expiry.
The Google Analytics event endpoint in `src/index.ts` is unversioned `/ping`,
outside the v1 router. It receives main-website events and is outside this notice's
scope; verify that production routing matches the checked-in separation.

For custom anti-abuse, check `src/middleware/anti-abuse.ts`,
`src/services/anti-abuse-runtime.ts`, and route ordering in `src/index.ts` against
actual production settings. Observation still processes data, and scoped trials
can enforce during observe mode. Assess legacy processing and historical Aikido data separately
for profiling and Article 22 effects; a request-review mailbox alone does not
establish that all required safeguards are implemented. Record any applicable
Article 22 exception and meaningful human-review procedure; assess DPIA necessity
on the actual processing and risk before activation.

Code retention baselines to verify, not promises about deployment or backups:

- `pow-session.ts`: challenge validity 1 minute; session validity 10 minutes;
  elevated-risk checks can require renewal after 30 seconds.
- `abuse-scorer.ts`: rolling 60-second event window, Redis key expiry refreshed
  on activity, and 10-minute trap flags; distinguish local lazy-expiry storage
  from physical deletion and from longer-lived telemetry.
- `abuse-observation.ts`: summary buckets expire 24 hours after the minute ends.
- `pow-cohorts.ts`: daily fingerprint-derived challenge groups expire at the end
  of the following UTC day. Hashing/grouping alone is not proof of anonymity.
- Aikido identifiers/telemetry, targeted-trial records, Redis persistence,
  exports and operational logs need their own verified inventory and schedule.

### Transparency for application end users

Publish an unauthenticated, stable current notice and version archive. Add public
integration guidance and a short disclosure template identifying Ignacio Aldama
Vicente/egdata, the request information sent, delivery/security/reporting purposes,
project-owner visibility where relevant, the privacy link, and a direct rights
contact. Link it from developer onboarding and API documentation. Require direct
browser integrations to show the disclosure before calls start; do not imply a
privacy notice must be accepted. Do not encourage shipping secret keys in browsers.

Proposed first-layer text for a direct-browser integration, to align with the
final deployed notice before use:

> This application connects to egdata, operated by Ignacio Aldama Vicente, Spain,
> to retrieve Epic Games Store data. egdata receives your IP address, browser and
> request information to deliver responses, protect the service, and diagnose
> usage. The application's operator can view usage reports associated with its
> API keys, including country and coarse client categories, without raw IP addresses
> or raw browser identifiers in those reports. Read the
> [egdata Developer Privacy Notice](https://devs.egdata.app/privacy) for purposes,
> legal bases, recipients, retention, and your rights. Contact contact@egdata.app
> directly about egdata's processing; no developer account is needed.

Adapt the summary for server-side forwarding and any additional actual processing;
it supplements the full notice and the application's own disclosures. The URL
above is the planned public route and must be verified live before release.

For server-forwarded end-user data, record its source and assess Article 14 timing:
within a reasonable period, at most one month, or earlier at first communication
or disclosure where applicable. Document any claimed exception rather than assume
public publication suffices. Minimize forwarded information and establish how
egdata verifies delivery of its notice through integrations. Maintain an update
workflow so relevant privacy changes reach affected end users before changed
processing, rather than merely emailing project owners. Provide direct rights
handling without a developer account. Link a separate notice for any personal
data in API datasets outside this notice's scope after confirming that inventory.

### Verify rights handling before approving retention

For each store and recipient, document the owner, lookup method, approved retention,
erasure/restriction action, and evidence of completion. Exercise representative
developer and end-user requests across D1, raw-IP analytics, owner-visible reports,
upstream security stores, logs, mail and backups. Confirm what can actually be
located and erased/restricted; provider default expiry is not a substitute for
rights handling. Redesign or minimize collection where the storage design cannot
meet applicable obligations. Do not disclose another person's data based solely
on a shared IP address or collect extra identity data without necessity.

Notify recipients of rectification, erasure or restriction where required; document
any applicable exception. Isolate retained claims evidence and reapply deletion
and restriction decisions after restoration. Keep closure confirmations distinct
from completed erasure, and track the one-month rights-response deadline and any
permitted extension of up to two further months. Review objections to legitimate
interests on their merits and preserve human review of disputed restrictions.

Before publishing, remove drafting instructions and statements about the “reviewed
implementation”; publish definite processing descriptions backed by the approved
deployment inventory. Recheck cookie behavior, public notice links, and the final
purpose/basis/recipient/retention mapping together.

## 7. Future mandatory-update delivery and verification

This sequence covers the later mandatory v1-update phase. For this PR's initial
rollout and its validation, use [initial-rollout.md](initial-rollout.md) and the
PR handoff in `docs/pr/developer-onboarding.md`.

1. Finalize business wording and privacy inventory/retention decisions, including
   notification addresses, message evidence, delivery providers, and rights handling.
2. Implement additive schema, public archives, publication validation, evidence,
    and race-safe activation/acceptance, initially without an effective requirement.
3. Implement verified contact/notification delivery, shared server checks, portal
   notice-period/blocked states, and independent suspension controls.
4. Verify covered v1/console gateway and origin access paths.
5. Verify in staging, publish final documents, and activate the first requirement.

Required tests include: first/returning users; multiple keys/projects; terms-only
gating; privacy/editorial updates never blocking; exact evidence surviving editorial
changes; current/next edition handling; early acceptance; stale/duplicate/concurrent submissions;
activation while tabs or consoles remain open; revoked keys remaining revoked;
acceptance not lifting suspension or resetting quota; primary-read failure;
warm KV/CDN caches; v1/HEAD/304 paths and preserved legacy behavior; forged Origin; omitted keys;
alternate hosts; anonymous document access; same-origin protection; retained
evidence; and rollback without bypass. Verify expiry boundaries with controlled time.
Test the instant before/at the deadline without running a scheduled job, initial
notice failure/postponement, notification idempotency, verification-token replay,
contact replacement/resend, and optional-consent refusal preserving core access.
Check the error contract across v1, dashboard, and HEAD responses,
including pending-document actions, safe fixed review URLs, no secret/account
detail leakage, and no automatic client retry loop on a legal-access 403.

Run dashboard tests, typecheck, build, and appropriate lint. Gateway behavior
changes require enumerating every affected stable operation ID, dated public
change records, OpenAPI and `apps/docs` updates, a current impact assessment,
`pnpm openapi:generate`, `pnpm changelog:generate`, `pnpm docs:check`, and
`pnpm release:check --base <base-ref>`. The account-closure and console-gating
implementation requires a public behavior record; legal drafts alone do not.

## Reference material consulted

- [Cloudflare D1 primary/replica behavior](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Cloudflare Worker static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Analytics Engine retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [AEPD: exercising data-protection rights](https://www.aepd.es/derechos-y-deberes/ejerce-tus-derechos)
- [EDPB: transparency, rights handling, objection and automated decisions](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en)
- [Spanish LSSI, including operator information in Article 10](https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758#a10)
- [Google APIs: notice and terms changes, section 10(a)](https://developers.google.com/terms#section_10_general_provisions)
- [GitHub: material changes and notice, section R](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#r-changes-to-these-terms)
- [Discord Developer Terms: modification, section 12(b)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service)
- [Apple Developer: acceptance deadline and paused resources](https://developer.apple.com/help/account/access/resolving-access-issues/)
- [EDPB: legal bases and separate, specific consent](https://www.edpb.europa.eu/sme/be-compliant/process-personal-data-lawfully_en)
- [Spanish general conditions: incorporation, Article 5](https://www.boe.es/buscar/act.php?id=BOE-A-1998-8789#a5)
- [Spanish Civil Procedure: territorial submission, Article 54.2](https://www.boe.es/buscar/act.php?id=BOE-A-2000-323#a54)
- [Spanish consumer protections: assignment and guarantees, Article 86.3](https://www.boe.es/buscar/act.php?id=BOE-A-2007-20555#a86)

Platform examples informed the product policy; they do not establish Spanish
enforceability or a legally mandatory notice period. The Mistral Large 4 review
supported the revised policy, but its legal assertions require independent
verification. In particular, LCGC Article 5.2 concerns notarial documents, not a
blanket ban on continued-use acceptance. This plan deliberately records explicit
terms acceptance without claiming all other models are invalid. Publication
review must assess consumer/digital-service applicability, durable notice,
operator identification, and significant automated decisions on the actual facts.

Source review and completed wording are not verification of production configuration.
The remaining operational evidence and actual publication timestamp are tracked
in `operations.md` and `initial-rollout.md`.
