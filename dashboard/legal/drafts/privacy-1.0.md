# egdata Developer Privacy Notice

**Version:** 1.0

**Prepared:** 12 November 2026

**Status:** Publication candidate; not published or effective.

> REVIEW DRAFT — the reader-facing text below describes the initial rollout once
> verified and activated. Publication and effective dates will be assigned at
> activation. Deployment evidence and outstanding operational checks are kept in
> `dashboard/legal/operations.md`; publication follows `initial-rollout.md`.

## 1. Who is responsible

**Ignacio Aldama Vicente**, based in **Spain**, is the controller responsible
for the personal data described in this notice.

**Contact:** contact@egdata.app

This notice covers the egdata Developer Portal at **devs.egdata.app**, developer
accounts and API-key management, the versioned developer API at
**api.egdata.app/v1/**, the portal's API console, developer support and associated
operational records. It also covers request metadata received when an application
calls that versioned API.

Legacy/unversioned API routes and their separate custom anti-abuse system are
outside this notice, as are the public website's browsing features and Google
Analytics. That custom anti-abuse system does not apply to v1 requests. The
developer portal does not use Google Analytics.

Epic Games and developers of applications using our API may independently
process personal data under their own notices.

If you use an application that connects to egdata, this notice explains our
processing of your request information. You may contact us directly to exercise
rights concerning that processing; you do not need a developer account. The
application provider must separately explain its own processing.

You can also contact **contact@egdata.app** about other egdata processing, including
legacy API requests and personal information in datasets. You do not need to know
which internal service holds the information. This notice is not a complete
description of those separate activities.
Providing this contact channel does not replace any obligation to give you
information proactively about those activities.

## 2. Information we process and its sources

### Sign-in and developer identity

When you sign in with Epic Games, we receive an account identifier and basic
profile information such as your display name and preferred language. We store
that identity to operate the developer account. The portal displays a local
account icon rather than requesting an Epic-hosted avatar.

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

Routine gateway usage records omit raw IP addresses and IP-derived identifiers.
They keep a coarse client category (browser, application, bot, other or unknown),
Origin-header presence rather than its value, and country rather than precise
location. Account/project/key identifiers remain, so these records are not
necessarily anonymous. Earlier records may contain raw IP addresses, user agents
and Origin values; their treatment is described in section 7. Separate security
and hosting processing below can still use IP addresses and detailed request data.

Hosting, access, and security systems also process request URLs, network and
protocol information, error events, and information needed to deliver requests.
API request parameters and bodies are processed where necessary to answer the
request. Cloudflare invocation logs and error monitoring are enabled. We redact
query strings in Worker observability, but this does not mean every provider's
security report or application error is free of request information. Do not put
credentials or unnecessary personal information in request URLs.

If your application calls the API directly from an end user's browser, we receive
that user's network/request information directly. With a server-to-server
integration, the network connection generally identifies the application's
server, but forwarded identifiers, headers, parameters, or content may still
relate to an end user. In that case, the application provider is the source of
that forwarded information. Developers should not forward unnecessary personal
information. Their responsibility to explain their own processing does not
replace our responsibility to inform people about egdata's processing.

### Historical security information

Before this rollout, our API origin used Aikido runtime security. That integration
has been removed from the rollout. It previously processed a keyed identifier
derived from IP address, user agent, language and country, together with security
telemetry such as route/usage statistics, associated IP information, system
information and suspected-attack details. Some of that information may still be
held by Aikido until deleted under the applicable retention and rights procedures.
Removing the integration does not itself erase prior records.

This disclosure concerns any continuing retention of historical personal data;
it does not apply the new Developer Terms to past activity or make terms acceptance
consent for that processing. Section 8 also applies to requests about those records.

### Agreements, notifications, and administrative records

Each terms acceptance is stored as an immutable event linked to your developer
account: the exact terms version, edition, and SHA-256 fingerprint, the server
time, the requirement revision, a receipt ID, and the Privacy Notice version and
fingerprint provided at that same event. Your receipts at `/profile/receipts`
keep these references even if newer versions are published later; each receipt
contains both full documents and can be printed or saved as PDF through your
browser, and an email linking to the receipt is queued to your verified address.
Email delivery can fail; the receipt remains available in your account. Acceptances
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
Optional project descriptions and website links help us understand an integration
and assess support or quota requests; we process them for those legitimate
interests, not as a condition of basic sign-in.

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

- **Ignacio Aldama Vicente, the sole operator**, accesses information needed for
  support, security, operation and access management. No other person administers
  egdata's developer accounts or support mailbox. Providers may allow their own
  authorized personnel access as necessary to supply their services.
- **Project owners** can see usage information associated with their own keys.
  Reports group historical IP addresses by country only, historical user
  agents are redacted, and Origin is reduced to presence. For direct browser
  integrations, request details can concern the application's end users, not
  just the developer. Owners do not thereby gain access to other developers'
  accounts. The operator has broader platform reporting access.
- **Cloudflare** provides gateway/portal hosting, databases,
  key-metadata caching, quotas, analytics, queues, operational logging, and
  transactional email infrastructure.
- **Google Cloud** hosts our self-managed API origin, main website and Redis
  service in `europe-west1` (Belgium). It processes requests and operational data
  through that infrastructure.
- **Hetzner** hosts our self-managed MongoDB, OpenSearch and Redis services in
  Nuremberg, Germany. These services support upstream storage, search and caching.
- **Aikido Security** may retain historical runtime-security information described
  in section 2. The removed runtime integration sends no new developer API
  telemetry after the rollout. Repository security scanning is a separate activity.
- **Cloudflare Email Sending and Email Routing, and Google (Gmail)** process
  correspondence, administrator/developer notifications, address verification and
  delivery information. Mail sent to `contact@egdata.app` is forwarded by Cloudflare
  Email Routing to the operator's personal Gmail mailbox under Google's own terms.
  Only the operator has access to that mailbox. There is no separate ticketing
  service. The mailbox retention rule is in section 7.
  Limit-increase requests are emailed to the operator, including
  account/project details, contact address, and use-case description.
  Transactional developer mail is sent from `noreply@egdata.app`; replies go to
  `contact@egdata.app`. Your own email provider also processes messages sent to you.
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

Our self-managed servers are in Germany and Belgium. Cloudflare's global network,
Google's services (including the Gmail mailbox), and security-service suppliers
can process information outside the EEA, including in the United States. European
server placement is not a promise of exclusively European processing or support.

Cloudflare's [Customer Data Processing Addendum](https://www.cloudflare.com/cloudflare-customer-dpa/)
forms part of our self-service agreement. It provides for transfers covered by
the EU–US Data Privacy Framework and, for restricted transfers, EU Standard
Contractual Clauses and additional safeguards. Google's
[Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum)
sets out the transfer mechanisms for its cloud services; it does not cover the
personal Gmail mailbox. Google's separate
[international-transfer information](https://policies.google.com/privacy/frameworks)
explains its adequacy and contractual safeguards for services covered by its
Privacy Policy. Aikido's [data-processing terms](https://www.aikido.dev/legal/dpa)
address safeguards for its processing and onward transfers.

Where a transfer requires safeguards, the applicable mechanism must cover the
recipient and processing concerned; a provider's European address alone is not
a safeguard. You can ask **contact@egdata.app** for information about the applicable
arrangements or a copy of the relevant safeguards, with unrelated confidential
information removed where necessary.

## 6. Cookies and browser connections

The portal uses these authentication cookies:

| Cookie | Purpose | Lifetime |
| --- | --- | --- |
| `egdata_dash_session` | Maintain the authenticated developer session | Up to 7 days, or removed on sign-out |
| `egdata_epic_oauth_state` | Protect and complete the Epic Games sign-in flow | Up to 10 minutes; normally removed when the callback is handled, but an early error can leave it until expiry |

These cookies support requested sign-in and session security. Disabling them
prevents those features from working. Logging out revokes the dashboard session
and associated console access; it does not automatically erase usage history.

Operational API analytics is collected server-side. It does not depend on an
advertising cookie. Necessary cookies do not justify unrelated tracking.
Epic Games may use its own cookies on its sign-in pages. Portal fonts are served
as same-origin static assets, and the account icon needs no external image request.

## 7. Retention and deletion

We keep personal information only for as long as needed for its stated purposes,
including applicable legal obligations and justified claims-related retention.
These are purpose-based retention rules, not statutory minimum periods. Scheduled
deletions use bounded daily batches; eligibility at a cutoff does not mean every
record is physically removed at that exact instant. We monitor and address cleanup
backlogs. Earlier applicable erasure and restriction obligations still apply.

| Category | Retention |
| --- | --- |
| Developer account, projects, key metadata and verified contact in D1 | While the account is active; automatic closure deletes these active records and rejects keys and sessions. A minimal closure record prevents re-registration for 30 days, then becomes eligible for cleanup. Residual evidence follows its separate category below |
| Soft-deleted projects | A 90-day recovery window; eligible records are purged by a bounded daily cleanup, so actual purge may occur later where a backlog exists |
| Daily endpoint usage and failed usage-event records in D1 | A 34-day date cutoff, processed by daily cleanup; not an exact per-record deletion deadline |
| Analytics Engine request records, including historical IP addresses | Cloudflare's automatic retention is three months from writing a record. New routine records are minimized as described in section 2. Historical raw IP/user-agent/Origin values are redacted from project-owner reports, but reporting redaction and shorter query windows do not erase the stored records. Requests concerning these records are handled under section 8, including requests for earlier erasure or restriction |
| Temporary console credentials | Valid for 10 minutes; expiry prevents use immediately, and expired records are removed by daily cleanup |
| Dashboard revocation records | Until the corresponding session expires, then daily cleanup |
| Support and limit-request correspondence, including mailbox copies | Twelve months after resolution, unless specific dispute evidence is still needed. D1 cleanup selects non-pending limit requests older than 12 calendar months from review. Mailbox correspondence is reviewed and deleted separately on a monthly schedule |
| Endpoint-change alert associations and reads | Eligible for daily cleanup 90 days after the related change's merge time; public change histories are separate |
| Administrative audit records | Eligible for daily cleanup 24 calendar months after the action |
| Rights-case ledger and action references | Eligible for daily cleanup 12 calendar months after resolution; open cases remain while the request is being handled. The ledger stores operational references, not full correspondence |
| Previous notification email | Replaced in the active profile when the new address is verified. The old address remains in the address-change notification under the 30-day mail-job schedule; mailbox copies follow the correspondence rule |
| Contact-verification tokens | Hashed, single-use and valid for 30 minutes; removed on use, with expired pending verification records selected by daily cleanup |
| Terms-acceptance evidence | Account lifetime and a five-year retention deadline after closure, followed by daily cleanup; restricted after closure to necessary agreement/claims evidence. Includes the account identifier, exact document references/hashes, action time and receipt ID. We review necessity against applicable claims periods and retain for less time where sufficient. This is a policy limit, not a universal statutory minimum; earlier applicable erasure and restriction rights still apply |
| Service-email jobs, attempts and lifecycle records | Jobs and attempts become eligible for deletion 30 days after job creation; minimal lifecycle records 30 days after ingestion. Verification plaintext tokens are not retained. Queues and email-provider copies have separate lifecycles |
| Cloudflare Workers diagnostic logs | Up to seven days under the provider's Workers Logs retention. Error/issue records and separately retained incident evidence are assessed for their own diagnostic purpose, not treated as automatically deleted with logs |
| Security diagnostics and incident evidence, including Aikido records | For the period needed to detect, investigate and resolve attacks, prevent recurring misuse and handle associated disputes. We consider the age and seriousness of the event, whether a restriction is still active, and whether particular evidence is still needed; provider-managed telemetry may follow a different lifecycle from local security state. Access/erasure/restriction requests include provider-held information where applicable |
| Queue messages and recovery copies | Queue copies persist until successfully processed or their configured retention expires; unsuccessful messages can move to a dead-letter queue for investigation. Cloudflare Paid Queues allow retention up to 14 days. D1 Time Travel keeps automatic recovery history for up to 30 days on our Paid plan. Recovery copies are not used to extend ordinary production use; deletion/restriction decisions must be reapplied after restoration |

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
contact@egdata.app. Closure deletes active account, project, key, and contact
records in our Cloudflare D1 database in one step, rejects existing sessions and
cached-key access, holds
re-registration of the same Epic Games account for 30 days, and queues a
confirmation email to the verified address. We process closure requests without
undue delay after any reasonably necessary identity verification and confirm
completion or explain a material delay. A
request exercising data-protection rights follows the response rules in section
8, including when submitted together with a closure request. Permission under the
Terms to retain API datasets does not authorize indefinite retention of personal
data or displace applicable data-protection duties. In particular, applicable
erasure and restriction obligations continue for personal data within caches.

Closure does not automatically erase every upstream database/cache record,
Analytics Engine record, log, queue message, Aikido record or support email.
Those records follow their applicable retention rules and the rights-request
procedure below. We assess requests across the relevant stores and involve
providers where needed; ordinary expiry is not a substitute for an applicable
earlier erasure or restriction obligation.

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

The Profile account-data export covers selected account-scoped D1 records. It is
not a complete export of every processing store or a substitute for a rights
request. Contact us for information held elsewhere, including upstream or
provider-held records. We keep a minimal case ledger to track requests and actions.

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

A denial can interrupt an API integration. Credential or account restrictions can
affect repeated requests until the underlying issue is resolved; exhausting a
quota restricts requests until its reset or an approved limit change. Completing
onboarding does not remove an independent credential, quota or security restriction.

A later mandatory material-update workflow is planned separately. If activated
under the Terms' notice policy, an ordinary update's acceptance check would pause
API access only at the announced effective time. This deadline enforcement is not
part of the initial rollout. Privacy-notice reading, dismissal, or acknowledgement
is not part of either access decision.

These checks use account and technical access information, not advertising
profiles. Contact us to request human review of an incorrect access restriction.
Administrative suspensions can also be imposed or reviewed by the operator.

Hosting security controls can inspect technical/request information for attack
indicators and excessive or abusive traffic. Matching a security rule or exceeding
a limit can block a request even when its API key is otherwise valid.
These controls are separate from terms acceptance. The custom fingerprint-based
challenge system on legacy endpoints does not run on v1 endpoints.

You can ask the operator to review a restriction, explain your circumstances and
contest the result at **contact@egdata.app**, including if an automated restriction
has a substantial effect on you. Review considers the actual reason, relevant
request/account information and your explanation; it does not guarantee restoration
where a justified restriction remains. Nothing in these terms or this notice
waives protections that apply to solely automated decisions under GDPR Article 22.

## 10. Changes and notification

We publish each new notice with its own version, effective date, and summary
of changes. Previous versions remain available. For important changes to how we
process information, we notify you through the portal and your verified contact
address before the changed processing begins, allowing appropriate time to
understand the change and exercise applicable rights. The notice and its timing
will reflect the nature of the change and applicable legal requirements.

For affected application end users who have no developer contact address, we
provide the public notice and work with the relevant application provider or use
another appropriate channel to communicate relevant changes. Developers must
provide an accessible, current notice link before direct browser requests begin
and appropriate information about requests they forward. Emailing a developer
alone does not establish that their users have been informed or discharge our
own transparency obligations.

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
