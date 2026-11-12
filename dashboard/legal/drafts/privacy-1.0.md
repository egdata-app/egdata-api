# egdata Developer Privacy Notice

**Proposed version:** 1.0

**Draft prepared:** 12 November 2026

**Publication date:** [TO COMPLETE]

**Effective date:** [TO COMPLETE]

> REVIEW DRAFT — not published. This draft reflects the reviewed developer
> portal/gateway code and identifies information still needed about production
> processing. Sections marked TO CONFIRM must be resolved before publication.
> Initial terms acceptance, verified contact, receipts, and account closure are
> implemented locally but undeployed. Material-update notice/deadline handling
> remains planned; privacy revisions do not require acknowledgement for access.
> Retention/minimization targets below are selected policy choices awaiting
> production verification; provider-side controls remain unverified.
> Telemetry minimization, finite D1 cleanups, the account export, and the
> rights-case ledger described below are implemented and tested locally:
> they are not deployed and do not erase already-stored historical rows.
> Production email delivery to the operator's contact inbox was confirmed on
> 12 November 2026; arbitrary-recipient capability and lifecycle tracking still
> require verification. See sections 4 and 10.

## 1. Who is responsible

**Ignacio Aldama Vicente**, based in **Spain**, is the controller responsible
for the personal data described in this notice.

**Contact:** contact@egdata.app

This notice covers the egdata Developer Portal, account and API-key management,
API gateway traffic, developer support, and associated operational records. It
also covers request metadata received when someone uses an application that
calls our API. It is not a complete notice for every feature of egdata.app or
for unrelated processing of personal data that may appear in API datasets.

Epic Games and developers of applications using our API may independently
process personal data under their own notices.

If you use an application that connects to egdata, this notice explains our
processing of your request information. You may contact us directly to exercise
rights concerning that processing; you do not need a developer account. The
application provider must separately explain its own processing.

**TO CONFIRM BEFORE PUBLICATION:** where other egdata processing, including
personal data in API datasets, falls outside this notice, link the applicable
notice so people can find the relevant controller, purposes, and rights channel.

## 2. Information we process and its sources

### Sign-in and developer identity

When you sign in with Epic Games, we receive an account identifier and basic
profile information such as your display name and preferred language. We store
that identity to operate the developer account. The portal displays a local
account icon rather than requesting an Epic-hosted avatar.

**DEPLOYMENT PENDING:** new logins/upserts use an empty avatar field and local
migration 0010 clears legacy database URLs. Production records and older signed
sessions may still contain URLs until migration/session expiry is verified.

You enter your Epic Games password with Epic Games, not with egdata. The login
flow exchanges authorization information with Epic Games to authenticate you.
The current integration does not give us a verified personal email address.
An internal account-derived value ending in `@accounts.epicgames.com` is not
treated as a verified contact address.

### Information you provide

We process project names, descriptions and website URLs; API-key names and
permissions; configured IP/origin restrictions; and requests for higher limits,
including contact email, expected volume, use case, and review correspondence.
For developer notifications, we collect a separate contact email, verify control
of that address, and retain verification status and relevant address-change
records. Verification requests use short-lived tokens; the stored token is
hashed. This notification address is not supplied by Epic sign-in.
Email profile editing does not change your Epic-managed display name. During the
initial onboarding rollout, email verification precedes terms acceptance and
dashboard/console access; existing API keys keep working. Replacement addresses
remain pending until verified, and we notify the previous verified address.
Verification demonstrates control of the address, not proof of your identity or
authority to represent an organization.
We also process information you send when seeking support or exercising rights.
Please avoid putting secrets or unrelated personal information in these fields.

### Credentials and security records

We process session information, API-key hashes and identifying prefixes,
permissions, expiry and revocation information, and temporary API-console token
hashes. API-key secrets are shown when issued; the key database stores a hash
rather than a recoverable copy of the secret. Keys and tokens must still be
transmitted to us when used for authentication.

### Usage and technical information

Gateway analytics includes account, project and key identifiers; request time,
endpoint/path information, HTTP method, response status, request counts,
processing time, cache and access-control outcomes; whether a browser Origin
header was present; a coarse client category; and the approximate country
derived from the network request.

**DEPLOYMENT PENDING (local, undeployed):** routine telemetry now
minimizes before it reaches either analytics sink — no raw IP address
is stored at all (no hash or other stable identifier), the user agent is mapped
to a coarse category (browser, application, bot, other, unknown), only the
presence of an Origin header is kept, and only the country code is retained.
This change does not erase historical rows already stored remotely; their
treatment is described in section 7. **TO CONFIRM BEFORE PUBLICATION:** verify
which behavior is actually deployed and when the change takes effect.

Hosting, access, and security systems also process request URLs, network and
protocol information, error events, and information needed to deliver requests.
API request parameters and bodies are processed where necessary to answer the
request. Worker invocation logs are enabled, and the checked-in configuration
turns query-string redaction on, but deployed logging must still be verified:
do not assume URLs or query values are never logged until production log fields
and retention are inspected. Do not put credentials or unnecessary personal
information in request URLs.

If your application calls the API directly from an end user's browser, we receive
that user's network/request information directly. With a server-to-server
integration, the network connection generally identifies the application's
server, but forwarded identifiers, headers, parameters, or content may still
relate to an end user. In that case, the application provider is the source of
that forwarded information. Developers should not forward unnecessary personal
information. Their responsibility to explain their own processing does not
replace our responsibility to inform people about egdata's processing.

### Additional upstream security processing — deployment to confirm

**TO CONFIRM BEFORE PUBLICATION:** the code also supports the following security
processing. Establish which features, modes, and routes are active, then replace
this drafting block with definite disclosures for the actual deployment:

- The anti-abuse system derives technical fingerprints from connection/protocol
  characteristics and header structure, uses browser-consistency signals and
  request patterns, and records risk indicators, session identifiers, and
  challenge outcomes. Trusted gateway connection signals may be forwarded to
  the origin for this purpose. Its fingerprint hash does not itself include raw
  IP addresses or user-agent values, but those can be processed elsewhere.
- The separate Aikido security integration can derive a keyed identifier from
  IP address, user agent, language, and country, and supply it with a shortened
  browser/country label to the security SDK for protection and rate-limit grouping.
  Confirm SDK telemetry, provider access, storage, and retention independently.

Derived or hashed identifiers are not assumed to be anonymous. Confirm their
linkability, necessity, recipients, and retention along with the underlying data.
The potential access consequences are described in section 9.

### Agreements, notifications, and administrative records

Each terms acceptance is stored as an immutable event linked to your developer
account: the exact terms version, edition, and SHA-256 fingerprint, the server
time, the requirement revision, a receipt ID, and the Privacy Notice version and
fingerprint provided at that same event. Your receipts at `/profile/receipts`
keep these references even if newer versions are published later; each receipt
contains both full documents and can be printed or saved as PDF through your
browser, and a copy is queued to your verified email address. Acceptances
recorded before this rollout may have no Privacy Notice version; we display that
as "not recorded" and never backfill it. These pages live under `/profile`
(`/profile`, `/profile/agreements`, `/profile/receipts`); older `/agreements` and
`/receipts` links redirect there. For legal and service notices, we record what
was sent, to which contact address, when, and available delivery or failure
information. We may record that a notice was presented or dismissed in the
portal. These events are not evidence of consent or proof that you read the
notice. We do not require privacy-notice acknowledgement for access.

We also process endpoint-change alerts, read status, quota decisions, and
administrative actions, including relevant actors, reasons, and changes.

The agreement record stores neither an IP address nor a user-agent string;
general request logging may still process them.

## 3. Why we process information and our legal grounds

| Purpose | Information involved | Legal ground |
| --- | --- | --- |
| Administer an individual developer's account, authenticate and supply requested API features, handle access/limit/support requests, verify their contact address, and send essential contractual service notices | Identity, project, credential, necessary request/contact records, verification status, and service correspondence | Performance of our agreement with that individual, or steps they request before entering it, only where objectively necessary for those services |
| Administer an organization's developer relationship, including its representatives' accounts, contact verification, access/support requests, and essential service communications | Representatives' identity and business contact details, project/credential records, verification status, and correspondence | Legitimate interests in administering the organizational relationship, authenticating its representatives, and communicating reliably with them |
| Deliver API responses to applications' end users, including people who have no agreement with egdata | Necessary network/request information and content needed to answer the request | Legitimate interests in delivering the API functionality requested through the application |
| Protect the service, enforce access rules and quotas, and investigate abuse | Request/security information, IP addresses, key identities, audit records, and deployed security identifiers/risk indicators | Legitimate interests in preventing misuse, protecting users and data, and maintaining secure, fair access |
| Diagnose faults, plan capacity, and provide project owners with proportionate usage/security reports | Usage, error/performance metadata, and request details, including end-user metadata where applicable | Legitimate interests of egdata and project owners in diagnosing integrations, detecting credential misuse, and operating reliable services |
| Preserve proportionate evidence of terms acceptance and notices, and establish, exercise, or defend legal claims | Exact terms versions/hashes and acceptance times, notification content/delivery records, and relevant account/contact/audit records | Legitimate interests in demonstrating what was agreed or communicated and protecting legal rights; this does not justify indefinite retention |
| Provide required privacy information and handle data-protection rights requests | Relevant identity/contact details, processing information, request correspondence, and response records | Compliance with GDPR transparency and rights-handling obligations, including Articles 12–22 as applicable |
| Meet another binding legal duty, such as a legally required disclosure | Only information necessary for that specific duty | Compliance with the applicable EU or Member State legal obligation; a private complaint or voluntary disclosure is not automatically such an obligation |

An organizational representative or application end user is not automatically
party to our developer contract. The corresponding legitimate-interest rows,
rather than contractual necessity, apply to their information as described above.
An optional project field does not become contractually necessary just because
it appears on a form; confirm its purpose and basis before collecting it.

**TO CONFIRM BEFORE PUBLICATION:** approve the necessity and balancing assessments
for each legitimate-interest purpose, particularly raw-IP diagnostics, project-owner
visibility into end-user details, security fingerprinting/scoring, and retention.
Identify the specific duties supporting any other legal-obligation processing.
Minimize or remove processing that cannot be justified; the table is not a blanket
authorization for all fields that the code can collect.

The portal's Inter and JetBrains Mono fonts are bundled with its static assets
and served from the portal's own origin through Cloudflare. The account icon is
rendered locally. Displaying these resources does not send browser requests to
Google Fonts or Epic avatar hosts. Necessary network information for serving
portal assets is covered by account/service delivery above; pre-sign-in delivery
relies on our legitimate interests in providing the requested portal page.

This notice provides information; it is **not a request for consent**. Viewing,
dismissing, or receiving it is not a substitute for an applicable legal ground.
If we introduce an optional activity requiring consent, we will explain it and
ask separately before processing. Refusing or withdrawing optional consent will
not block core developer access; it stops the corresponding optional processing.

Basic identity and authentication information is needed to supply an account.
We also require a verified developer contact address before activating protected
dashboard features, issuing new API keys, or using the portal console, so essential
notices can reach the person responsible for an integration. Existing external
API keys continue working during initial onboarding, including after an incomplete
dashboard visit. Without this information we cannot activate the protected portal
features. Optional project details are
not necessary to sign in; an access/limit request may need enough contact and
use-case information for us to assess and answer it.

## 4. Who receives information

- **The operator and authorized administrators** can access information needed
  for support, security, operation, and access management.
- **Project owners** can see usage information associated with their own keys.
  Selected reporting design (implemented locally, undeployed): aggregate-only
  reports — historical IP addresses are grouped by country only, historical user
  agents are redacted, and Origin is reduced to presence. For direct browser
  integrations, request details can concern the application's end users, not
  just the developer. Owners do not thereby gain access to other developers'
  accounts. Administrators have broader platform reporting access.
  **TO CONFIRM BEFORE PUBLICATION:** verify the deployed reporting behavior and
  the transition/rights-handling decision for historical owner-visible raw
  records before this notice takes effect.
- **Cloudflare** provides the reviewed gateway/portal hosting, databases,
  key-metadata caching, quotas, analytics, queues, operational logging, and
  transactional email infrastructure.
- **Upstream hosting and infrastructure providers** process forwarded API
  requests and operational information. The repository describes a Google Cloud
  hosted origin. **TO CONFIRM:** actual production providers and any managed
  database/search, monitoring, backup, or other subprocessors receiving personal
  information through developer/API operations.
- **Security infrastructure — TO CONFIRM:** identify the operator/provider of
  upstream Redis security stores and whether Aikido receives SDK telemetry or
  can access request information. State actual recipients and their roles in the
  published notice; installing an SDK alone does not establish what it exports.
- **Email and support providers** process correspondence and administrator
  and developer notifications, address verification, and delivery results.
  Limit-increase requests are emailed to the operator, including
  account/project details, contact address, and use-case description.
  Cloudflare Email Sending is enabled for the egdata.app domain
  (`noreply@egdata.app`); the operator confirmed receipt of a real delivery test
  at contact@egdata.app on 12 November 2026. **TO CONFIRM:** verify arbitrary-
  recipient delivery on the configured sender/domain and account plan before
  relying on email verification or notices in production, and identify the
  mailbox/support providers.
- **Epic Games** processes sign-in through its own services. The portal does not
  contact Epic's avatar hosts merely to display an account icon.
- **Authorities, professional advisers, or other recipients** may receive
  information where necessary and lawfully justified to comply with obligations
  or establish, exercise, or defend legal claims. A third-party complaint does
  not automatically entitle its sender to your account data.

We do not sell personal account or request data or use it for targeted
advertising under the service described in this notice.

## 5. International processing

Our providers operate infrastructure in multiple countries. Being based in
Spain, or placing an origin server in Europe, does not establish that all
processing remains within the European Economic Area.

**TO CONFIRM BEFORE PUBLICATION:** identify actual transfers outside the EEA,
the applicable recipient/processor arrangements and transfer safeguards, such
as an applicable adequacy decision or standard contractual clauses with any
necessary supplementary measures. State how users can obtain information about
or a copy of those safeguards. Do not claim a specific safeguard is in place
until the actual provider arrangement has been checked.

## 6. Cookies and browser connections

The reviewed portal uses these authentication cookies:

| Cookie | Purpose | Lifetime |
| --- | --- | --- |
| `egdata_dash_session` | Maintain the authenticated developer session | Up to 7 days, or removed on sign-out |
| `egdata_epic_oauth_state` | Protect and complete the Epic Games sign-in flow | Up to 10 minutes; normally removed when the callback is handled, but an early error can leave it until expiry |

These cookies support requested sign-in and session security. Disabling them
prevents those features from working. Logging out revokes the dashboard session
and associated console access; it does not automatically erase usage history.

**TO CONFIRM — upstream challenge cookie:** where the anti-abuse challenge flow
is used, successful completion can set `__Host-egdata-session` on the responding
host to recognize a short-lived security session. The reviewed code gives it
up to 10 minutes per issuance; risk checks can require a new challenge sooner.
This is separate from the developer login cookie. Confirm actual host, browser
delivery, route coverage, and the applicable cookie/device-access requirements
before including it as an active cookie in the published table. The current v1
router bypasses this browser-challenge middleware.

Operational API analytics is collected server-side. It does not depend on an
advertising cookie. Necessary cookies do not justify unrelated tracking.
Epic Games may use its own cookies on its sign-in pages. Portal fonts are served
as same-origin static assets, and the account icon needs no external image request.

## 7. Retention and deletion

We keep personal information only for as long as needed for its stated purposes,
including applicable legal obligations and justified claims-related retention.
The following table distinguishes selected policy targets from existing behavior.
**IMPLEMENTATION/PUBLICATION GATE:** implement and verify the selected limits,
including provider-side copies, before presenting them as active retention rules.
These are purpose-based policy choices, not statutory minimum retention periods.

| Category | Retention and current draft status |
| --- | --- |
| Developer account and active projects/key metadata | Selected target: account lifetime; revoke access promptly on verified closure and delete ordinary account/project/key records within 30 days. Any narrowly justified residual evidence follows its separate category below. The closure flow is implemented locally but undeployed; verify deployed cleanup before publication |
| Soft-deleted projects | A 90-day recovery window; eligible records are purged by a bounded daily cleanup, so actual purge may occur later where a backlog exists |
| Daily endpoint usage and failed usage-event records in D1 | A 34-day date cutoff, processed by daily cleanup; not an exact per-record deletion deadline |
| Analytics Engine request records, including historical IP addresses | Routine writes are minimized in the local build (no raw IP, coarse client category, origin presence, country — see section 2), but this is undeployed and does not erase historical rows. Cloudflare documents three-month retention; confirm actual expiry, exports and historical rights handling before publication. A shorter query window does not delete records |
| Temporary console credentials | Valid for 10 minutes; expiry prevents use immediately, and expired records are removed by daily cleanup |
| Dashboard revocation records | Until the corresponding session expires, then daily cleanup |
| Support and limit-request correspondence, including mailbox copies | Selected target: 12 months after resolution; isolate evidence needed for a specific ongoing dispute. Local D1 cleanup removes non-pending limit requests older than 12 calendar months from review. Mailbox copies need separate verified controls |
| Endpoint-change alert associations and reads | Local cleanup selects records older than 90 days from the related change's merge time; undeployed. Public change histories are separate |
| Administrative audit records | Local cleanup selects records older than 24 calendar months after the action; undeployed. Verify restricted access and production cleanup |
| Rights-case ledger and action references | Local cleanup selects resolved cases older than 12 calendar months from resolution, including their action evidence; open cases remain. The ledger records operational references, not full correspondence |
| Verified developer contact and address-change records | Selected target: current address/status for account lifetime and up to 30 days for closure processing; retain the previous address/change event for at most 90 days. Minimum recipient evidence in the separate notification record follows its own schedule |
| Contact-verification tokens | Selected target: hashed, single-use, 30-minute validity; delete on use and purge expired records within the next daily cleanup, targeting 24 hours after expiry |
| Terms acceptance and material legal-notice evidence | Selected target: account lifetime plus 5 years after closure, restricted after closure to justified evidence/claims purposes. Verify necessity against applicable claims and duties before publication; this is not a universal statutory minimum. Keep only the necessary account link, document/hash, action/time, and notice recipient/content/outcome |
| Routine service-email delivery/verification troubleshooting records | Local outbox/attempt cleanup uses 30 days from job creation; minimal lifecycle events use 30 days from ingestion. Verification plaintext tokens are not retained. Provider/queue copies require separate verification |
| Routine diagnostic logs | Selected target: 7 days, with query strings/secrets redacted. Query-string redaction is enabled in the checked-in Worker configuration (local change); verify the deployed configuration and actual logged fields/retention before claiming it is active |
| Restricted security diagnostics and incident records | Selected target: raw IP/user-agent diagnostics only where necessary, for at most 14 days in a store supporting rights handling; incident records up to 30 days after resolution. Longer preservation requires a specific documented need and review |
| Backups | Selected target: rolling expiry within 35 days; confirm provider capability and any legally required exceptions. Restores must reapply deletion/restriction decisions; backup expiry does not extend ordinary production use |
| Conditional upstream anti-abuse identifiers, risk windows, challenge/session records, and telemetry | **TO CONFIRM** enabled routes and production lifetimes, including Redis, in-memory state, exports, and backups; cookie/token validity is not the retention period for all associated records |
| Aikido security identifiers and any SDK/provider telemetry | **TO CONFIRM** actual collection/export, recipient retention and deletion controls; assess separately from the custom anti-abuse stores |

Public copies of historical legal documents may remain available indefinitely;
they do not need to identify the people who accepted them. Account-linked
acceptance evidence has a separate retention policy.

Any longer preservation must identify the specific legal duty or ongoing claim,
the minimum records needed, restricted access, and a review/end point. Review such
holds at least every six months and delete when the justification ends. Routine
retention periods do not override an applicable earlier erasure or restriction
obligation. A soft-deleted project's recovery window is not an automatic delay
for account closure or an erasure request.

Deleting a project does not automatically delete the developer account or all
independent analytics and audit records. Contact us to request account closure
or exercise your erasure rights. Where limited information must be retained,
we will explain the applicable reason and restrict it to that purpose.

Account closure ends developer access but is distinct from erasing every record.
You can request closure from the Profile page (`/profile`) — with a typed
confirmation and a sign-in within the last 10 minutes — or by email to
contact@egdata.app. The closure flow in the current local build (not yet
deployed) deletes active account, project, key, and contact records in one
step, rejects existing sessions and warm key-cache lookups, holds
re-registration of the same Epic Games account for 30 days, and queues a
confirmation email to the verified address. We process closure requests without
undue delay after any reasonably necessary identity verification and confirm
completion or explain a material delay. A
request exercising data-protection rights follows the response rules in section
8, including when submitted together with a closure request. Permission under the
Terms to retain API datasets does not authorize indefinite retention of personal
data or displace applicable data-protection duties. In particular, applicable
erasure and restriction obligations continue for personal data within caches.

Where required, we communicate rectification, erasure, or processing restrictions
to recipients to whom the information was disclosed, unless this is impossible
or involves disproportionate effort under applicable law. You can ask us for
information about those recipients.

## 8. Your rights

Subject to the conditions in data-protection law, you can request access,
rectification, erasure, restriction of processing, and portability. Where
processing relies on consent, you can withdraw that consent without affecting
the lawfulness of processing before withdrawal.

**Right to object:** you may object, on grounds relating to your particular
situation, to processing based on legitimate interests, including related
profiling. We will stop that processing unless we demonstrate compelling
legitimate grounds overriding your interests, rights, and freedoms, or the
processing is needed to establish, exercise, or defend legal claims.

Send requests to **contact@egdata.app**. You do not need a developer account or
an accepted terms revision. Where we have reasonable doubts about identity, we
may ask for proportionate information to confirm it; do not send identity
documents unless an appropriate verification process specifically requires them.
Do not send passwords, API keys, or session tokens. Requests are normally free,
subject to the limited exceptions in applicable law.

**DEPLOYMENT PENDING (local, undeployed):** an account-data export and an
operator rights-case ledger are implemented and tested locally. The export covers
selected account-scoped D1 records, not every processing store. Until
they are deployed and verified, submit requests by email as described above.

We respond without undue delay and within one month of receiving your request.
Where permitted because of the complexity or number of requests, we may extend
this by up to two further months; we will explain the extension within the first
month. If we do not act on a request, we will explain why within that month and
tell you about your right to complain to a supervisory authority and seek a
judicial remedy. These channels remain available if you have not accepted updated
terms, have not read a new notice, or are suspended.

You can complain to the **Agencia Española de Protección de Datos (AEPD)** at
https://www.aepd.es/, or another competent supervisory authority, without first
having to resolve the matter with us.

## 9. Automated access checks

Software automatically checks credentials, permissions, request quotas, and
account-closure status. Protected dashboard and console features additionally
check verified contact and required terms acceptance. A failed check can deny the
corresponding request. Existing external API keys are not gated by initial
onboarding status; keys of a closed account are rejected.

A later mandatory material-update workflow is planned separately. If activated
under the Terms' notice policy, an ordinary update's acceptance check would pause
API access only at the announced effective time. This deadline enforcement is not
part of the initial rollout. Privacy-notice reading, dismissal, or acknowledgement
is not part of either access decision.

These checks use account and technical access information, not advertising
profiles. Contact us to request human review of an incorrect access restriction.
Administrative suspensions can also be imposed or reviewed by the operator.

**TO CONFIRM — additional security decisions:** on covered legacy routes, the
custom anti-abuse system can use connection/header consistency and patterns of
requests to estimate automated misuse. Depending on deployment mode, it records
indicators, requests a computational challenge, or delays and withholds a data
response. Observe mode can include a targeted enforcement trial; its name alone
does not establish that all requests are unaffected. The current v1 router
bypasses this middleware. Separately assess the Aikido integration and any other
edge/origin security restrictions. Replace this block with the actual scope,
inputs, consequences, and human-review route before publication.

**TO CONFIRM:** assess whether any deployed automated decision has legal or
similarly significant effects within GDPR Article 22; if so, document its legal
basis, meaningful information about its logic and consequences, and required
safeguards before publication. Include agreement gating and security profiling,
not just quota checks. A legitimate-interest basis for collecting security data
does not itself supply an Article 22 exception for a solely automated significant
decision. Where applicable, provide the right to human intervention, to express
a point of view, and to contest the decision. Do not assume these decisions fall
outside that provision merely because they are technical or not used in advertising.

## 10. Changes and notification

We publish each new notice with its own version, effective date, and summary
of changes. Previous versions remain available. For important changes to how we
process information, we notify you through the portal and your verified contact
address before the changed processing begins, allowing appropriate time to
understand the change and exercise applicable rights. The notice and its timing
will reflect the nature of the change and applicable legal requirements.

For affected application end users who have no developer contact address, notice
must also reach them through the relevant integration or another appropriate
channel. Emailing the developer alone does not establish that its users have been
informed. **TO CONFIRM BEFORE PUBLICATION:** implement and verify that delivery
path, including timely updates for direct and indirectly obtained information.
Also verify production email delivery to arbitrary verified addresses (see
section 4) before relying on email for required notices. Before a later mandatory
terms update, complete and verify its separate notice/deadline workflow (advance
notice, reminders, delivery-failure handling and postponement); that future phase
is not deployed or required to activate the initial portal-only rollout.

You do not have to accept or acknowledge a privacy-notice revision to keep using
the dashboard or API. Reading or dismissing a notice is optional, and a missing
acknowledgement will not pause your keys. Material terms changes have their own
acceptance process, described in the Developer Terms of Service.

Publishing or notifying a revised privacy notice does not create a new legal
basis or authorize unspecified future uses. We assess the legal basis and any
purpose-compatibility requirements before changing processing. Where a new
optional purpose relies on consent, we request separate, specific consent before
beginning it. You can refuse or withdraw that consent without losing core API
access or affecting the lawfulness of earlier processing based on consent.

You may read the notices, contact support, and exercise your rights without any
acknowledgement. If you do not wish to continue using the service, contact
**contact@egdata.app** about closing your account.
