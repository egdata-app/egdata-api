# egdata Developer Terms of Service

**Version:** 2.0

**Publication record and version history:** https://devs.egdata.app/legal/history

## 1. Who provides the service

The egdata Developer Portal, API, and paid API plans are operated by
**Ignacio Aldama Vicente** (“egdata”, “we”, or “us”).

- **Postal address:** [TO COMPLETE: full geographic/postal address in Spain]
- **Tax identification number (NIF):** [TO COMPLETE: NIF / tax identifier]
- **Commercial / tax status:** [TO COMPLETE: e.g., sole trader / autónomo registration details if applicable]
- **Contact:** **contact@egdata.app**

These terms govern your use of the developer portal at **devs.egdata.app**, your
developer account, any free or paid developer subscription you activate, and
access to the versioned developer API at **api.egdata.app/v1/** or through the
portal's API console. Legacy/unversioned API endpoints and their separate custom
anti-abuse system are outside this agreement. These terms do not replace terms
that independently apply to Epic Games, Stripe, or other third-party services.

“Protected dashboard” means the authenticated project-management, analytics,
quota, billing, key-creation, and API-console features of the portal. “API
access” includes requests to **api.egdata.app/v1/** using API keys and requests
through the portal's API console. Section 10 explains the access paused for
missing acceptance and the channels that remain available.

egdata is an independent service. It is not affiliated with, sponsored by, or
endorsed by Epic Games, Inc.

## 2. Agreement and account responsibility

To activate protected dashboard access, sign in with Epic Games, verify a
notification email, and expressly accept the required version of these terms.
Signing in by itself is not acceptance. Your initial agreement takes effect when
you expressly accept these terms; later revisions follow section 10.
Publication alone does not bind you to these terms or apply them to past
activity. Accepting revised terms alone never authorizes a paid charge — paid
subscriptions require a separate affirmative checkout decision under section 4.

Each terms acceptance is recorded as an immutable event containing the exact
terms version and its SHA-256 fingerprint, the server time, and the Privacy
Notice version provided at the same event. You receive an agreement receipt at
`/profile/receipts` that you can print or save as PDF from your browser (the
receipt includes both full documents). We queue a receipt email to your verified
address, including a link to the account copy. Delivery can fail; the receipt
remains available in your account. Published versions never change after
publication: earlier versions remain readable at `/terms/:version` and
`/privacy/:version`, and `/legal/history` lists their fingerprints and
publication times.

During initial onboarding (before a mandatory API-key deadline is separately
announced under section 10), existing external API keys continue working while
you complete email verification and terms acceptance, including after a
dashboard visit. Creating new keys, purchasing a paid plan, and using the portal
console require completed onboarding.

Provide and verify a developer contact email before accepting these terms, and
keep it up to date. We use it for agreement, billing, security, and other
essential service notices. Epic Games sign-in does not provide a verified
notification address in our integration. This contact requirement is not consent
to marketing. On your Profile page (`/profile`) you can edit this notification
email — it is the only account field you can change there, because your Epic
Games display name stays managed by Epic. A replacement address becomes your
verified contact only after you confirm it, and we notify your previous verified
address of the change.

You must have legal capacity to enter this agreement. If you act for an
organization, you must have authority to bind it. You are responsible for the
projects you operate, your use of issued credentials, and ensuring that your
applications comply with these terms.

Keep API keys secure and limit their permissions appropriately. Do not publish
secret keys, sell access to your credentials, or let others use your account to
evade quotas, billing limits, withdrawal limits, or other restrictions. Revoke
compromised keys and contact us if you suspect abuse. You may operate
applications used by other people without sharing your secret credentials with
them.

We may revoke a credential without advance notice if we reasonably believe it
has been publicly exposed or compromised, including following a credible report
or automated detection. Where practicable, we will notify you through the portal
or an available contact channel. A revoked credential must be replaced; accepting
updated terms does not restore it. This does not promise that we monitor every
repository or detect every exposure.

You can check credential status and revoke keys through the portal. You may
create a replacement key once you have accepted the currently required terms,
met the account's contact-verification requirements, and no independent
restriction prevents key creation or the intended API access. If you cannot sign
in or use these controls, contact **contact@egdata.app** for identity-verified
assistance. Replacing a key does not bypass an agreement pause, quota, payment
suspension, or independent restriction.

## 3. Plans, quotas, and permitted uses

Subject to these terms and applicable third-party rights, you may use the API
for personal, educational, research, open-source, and commercial projects,
including websites, applications, bots, analysis, and data-based features.

These permissions concern access to our service and rights egdata is entitled to
grant. They do not grant rights in third-party content that egdata does not hold,
including artwork, videos, original descriptions, and trademarks belonging to
Epic Games, publishers, or other rights holders. Any permission required by
applicable law for your use of that content must be obtained separately. Nothing
in these terms limits uses permitted by mandatory law or claims ownership of
individual facts.

### Service plans and hard caps

The developer API is offered under the following standard plans (tracked per
project unless stated otherwise):

| Plan | Monthly price (EUR, VAT incl. for consumers) | Global rate limit | Period request allowance | Expensive operation minute limits / period budgets | Initial 14-day daily cap |
| --- | ---: | ---: | ---: | --- | ---: |
| **Free** (`free-v1`) | EUR 0 / month | 60 req/min per project | 100,000 / UTC calendar month (**shared across all Free projects on the account**) | Minute: offers-list 5, search 60, heavy 20, bulk 5 · Period: NL search 500, bulk 1,000, image 2,000 | None |
| **Pro** (`pro-v1`) | EUR 9 / month per subscribed project | 200 req/min | 300,000 / monthly billing period | Minute: offers-list 20, search 200, heavy 60, bulk 15 · Period: NL search 2,500, bulk 10,000, image 15,000 | 12,000 req / UTC day |
| **Scale** (`scale-v1`) | EUR 19 / month per subscribed project | 600 req/min | 1,000,000 / monthly billing period | Minute: offers-list 60, search 600, heavy 180, bulk 40 · Period: NL search 10,000, bulk 40,000, image 50,000 | 35,000 req / UTC day |

- **Hard request caps:** All standard plans enforce hard request limits (`429`
  errors such as `RATE_LIMITED`, `MONTHLY_QUOTA_EXCEEDED`,
  `PERIOD_QUOTA_EXCEEDED`, or `EXPENSIVE_BUDGET_EXCEEDED`). Exceeding a limit
  stops further matching requests until the relevant window or period resets; we
  never charge automatic overage fees.
- **Initial 14-day daily pacing limit (paid plans):** During the first 14
  calendar days of a newly subscribed paid project (aligned with the 14-day
  statutory withdrawal window), daily usage is paced at 12,000 requests/UTC day
  on Pro and 35,000 requests/UTC day on Scale. Unpaced monthly billing-period
  usage unlocks automatically from Day 15 onward.
- **Accounting rules:** Admitted cache hits and `304` conditional responses
  count toward your quotas. Failed authentication, permission or plan-entitlement
  denials (`403 PLAN_ENTITLEMENT_REQUIRED`), and quota-rejected requests do not
  debit monthly or period allowances. If an admitted request encounters a
  service-side upstream `5xx` error, the minute counter stays consumed while the
  period/monthly (and daily) request unit is automatically credited back.
- **Manual, grandfathered, and custom grants:** We may approve higher limits,
  additional projects, or Enterprise/custom capacity upon request via
  `/limits` or **contact@egdata.app**. A manual or grandfathered grant applies
  only to its explicitly assigned project and terms. Projects with an active
  manual grant cannot start a self-serve Stripe subscription directly without
  first contacting support. Approval of a higher quota does not authorize bulk
  database extraction.
- **Free-tier adjustments:** For free access, no particular technical quota is
  guaranteed indefinitely. We may reasonably adjust or withdraw free quotas to
  manage capacity, fair access, abuse, or legal obligations, and aim to give
  advance notice of significant planned reductions. A material change to
  contractual rights follows section 10.

You may charge users for your application or permitted data outputs, subject to
the attribution and extraction restrictions in sections 5 and 6. These terms
impose no separate revenue share payable to egdata beyond the applicable plan
subscription fee (if any).

## 4. Paid plans, billing, cancellation, and right of withdrawal

Paid plans (`Pro` and `Scale`) are optional monthly subscriptions scoped to a
specific project. You do not need a paid plan to keep using Free-tier access.

### Checkout, pricing, VAT, and invoicing

- **Pricing and currency:** Prices are stated in euros (**EUR**). For consumers,
  displayed prices include applicable VAT (Spanish reference rate 21% where
  applicable). [TO COMPLETE: confirm VAT / tax-registration and B2B invoicing
  treatment, and whether Stripe Tax / automatic VAT calculation is enabled or
  not.]
- **Pre-purchase confirmation:** Before starting Stripe Checkout, you must
  review the plan details, EUR price, monthly auto-renewal terms, hard caps
  (including the initial 14-day daily pacing limit), and the 14-day statutory
  withdrawal notice, and expressly confirm your request for immediate API access.
- **Payment processing:** Payments, payment methods, recurring charges, and
  downloadable invoices are processed by **Stripe** via Stripe Checkout and the
  Stripe Billing Portal. egdata does not store your raw card numbers.
- **Purchase receipts:** Each checkout confirmation generates an immutable
  purchase receipt stored in your account at `/profile/receipts` (alongside
  Stripe invoices available through the Stripe Billing Portal).

### Billing cycles, upgrades, downgrades, and cancellation

- **Auto-renewal:** Paid subscriptions renew automatically each month on the
  billing-period cycle set at checkout until you cancel or change plans.
- **Upgrades:** Upgrading a project from Pro to Scale takes effect immediately
  once confirmed. Stripe charges a prorated amount for the remainder of the
  current billing period (`always_invoice`). Requests already consumed during the
  current billing period remain counted toward the upgraded period allowance.
- **Downgrades and cancellation:** Downgrading from Scale to Pro, or canceling
  a paid subscription back to Free, is scheduled to take effect at the end of
  your current paid billing period. Your project retains its paid capacity until
  that period ends, and no further renewal fee is charged. You can manage
  cancellations and payment methods through the dashboard (`/limits` or
  `/profile/billing`) or the Stripe Billing Portal, which remain accessible even
  when request quotas are exhausted or a payment is `past_due`.
- **No partial-month refunds after cancellation:** Except where you exercise a
  valid statutory right of withdrawal below, where required by mandatory law, or
  where egdata discontinues a paid plan mid-period without your breach, ordinary
  cancellations stop future renewals at period end and do not refund fees for
  the already-started billing period.
- **Project deletion or account closure:** Deleting a subscribed project or
  closing your developer account immediately cancels the associated Stripe
  subscription so no future renewals occur and ends paid capacity immediately.

### Failed payments, grace period, and disputes

- **3-day grace period:** If a recurring renewal payment fails, your
  subscription enters `past_due` status and retains paid capacity for a
  **3-calendar-day grace period** while we notify your verified email address.
  If you do not update your payment method and settle the invoice before the
  grace period ends (or if Stripe marks the subscription `unpaid` or
  `canceled`), paid capacity stops and the project reverts to Free plan limits.
- **Chargebacks and disputes:** If a payment is subject to a lost chargeback or
  dispute, or a full refund is issued, the subscription is canceled and the
  project returns immediately to Free capacity.

### Consumer 14-day right of withdrawal and pro-rata deduction

If you contract as a **consumer** under applicable EU and Spanish consumer law
(Directive 2011/83/EU and Spanish TRLGDCU), you have the statutory right to
withdraw from a new paid subscription within **14 calendar days** from the date
of checkout without giving any reason.

- **How to exercise withdrawal:** During the 14-day window, you may submit a
  withdrawal request directly in the portal (`/limits` or `/profile/billing`) or
  by emailing **contact@egdata.app** with an unequivocal statement (you may also
  use the standard EU model withdrawal form, though it is not obligatory).
- **Request for immediate access and pro-rata deduction:** By checking the
  pre-purchase confirmation and completing checkout, you expressly request that
  egdata begin supplying the paid API capacity immediately during the 14-day
  withdrawal period. If you withdraw during that 14-day window after service
  access has begun, your subscription is canceled immediately, your project
  reverts to Free capacity, and you receive a **time-based pro-rata refund**
  via Stripe for the unused portion of the current billing period (deducting the
  proportional amount for elapsed subscription time since period start, rounded
  to the nearest cent, consistent with Article 14(3) of Directive 2011/83/EU).
- **One self-serve withdrawal per account:** Once a statutory withdrawal refund
  has been completed on your developer account, self-serve Stripe checkout is
  disabled for future purchases on that account. You may continue using Free
  plans or contact us via `/limits` or **contact@egdata.app** to request custom
  manual invoicing.
- **Upgrades/renewals and business users:** Automatic monthly renewals of an
  already-started subscription do not create a fresh 14-day withdrawal right.
  Business users acting in the course of a trade, business, or profession do not
  have a statutory consumer withdrawal right, though the portal's withdrawal
  control enforces the 14-day checkout window uniformly while open.

## 5. Attribution for paid distribution

When you sell, license, or otherwise provide egdata-derived data or functionality
as part of a paid offering, you must clearly credit both the original source and
egdata's work in bringing the data together. This includes subscription access
to a data-based feature or paid reports and permitted exports.

A suitable attribution is:

> Epic Games Store data sourced from Epic Games; aggregated, normalized, and
> unified by egdata.app. This product is not affiliated with or endorsed by
> Epic Games or egdata.

Link **Epic Games** to https://store.epicgames.com/ and **egdata.app** to
https://egdata.app/ where the medium supports links. Place the credit somewhere
users can reasonably find it, such as the relevant data view, credits/about page,
report, or distribution documentation. For machine-readable outputs, include
the attribution in accompanying documentation or appropriate metadata.

Keep the credit legible and reasonably prominent alongside comparable source
credits; do not hide it in a way that defeats its purpose. Preserve any placement
or prominence required for third-party notices.

Attribution is encouraged for free public projects. Any additional notices
required by a third-party rights holder must still be preserved. Attribution
does not authorize bulk copying, grant trademark rights, imply endorsement, or
replace any third-party permission required by applicable law.

## 6. Caching, extraction, and redistribution

You may cache and retain the data reasonably needed for your application's
features and efficient operation, within your access permissions. For example,
maintaining a selected watchlist or caching records actually used by your
application is permitted.

Standard Free, Pro, and Scale API access is not permission to systematically
copy or reconstruct the whole egdata database, or a substantial part of it, for
a standalone mirror, bulk dataset, or substitute data service. Repeated
extraction of smaller parts that cumulatively achieves the same result is also
restricted. Having a paid plan, slowing down extraction, or staying below rate
limits does not make such copying permitted.

These restrictions concern access to and extraction from the service. They do
not claim ownership of individual facts or exclude uses permitted by mandatory law.

Do not rotate accounts, projects, keys, IP addresses, or other identities to
circumvent quotas, billing limits, withdrawal controls, or these restrictions.
Do not bypass the gateway or access controls to obtain data.

For full-catalog synchronization, bulk research exports, or a project that needs
a substantial local copy, contact **contact@egdata.app** for written permission
identifying yourself, your project, intended use, and requested scope. Any grant
must be in writing and specify its scope, conditions, duration, and grounds and
notice for withdrawal, including any urgent rights-related restrictions. Do not
assume a grant is unlimited or permanent; withdrawal operates according to those
agreed conditions and applicable law. We assess scope by the volume, coverage,
systematic nature, and purpose of extraction, not solely by requests per minute.
Providing attribution, paying for a standard plan, or charging your own
customers does not replace that permission.

If your access pauses or ends, you may retain and continue permitted use of
existing, bounded caches lawfully obtained within these permissions. That use
remains governed by the terms applicable when the data was obtained, including
applicable attribution, extraction, redistribution, and third-party-rights
restrictions. It does not authorize further API access, refreshes, or combining
caches to create a prohibited substantial copy. Separate written bulk permissions
follow their own agreed retention conditions. Specific lawful obligations to stop
use or remove affected material, including those addressed in section 9, still
apply; account closure or refusal of revised terms alone does not require deleting
otherwise permitted caches.

## 7. Acceptable use and third-party rights

You must not use the service unlawfully, infringe others' rights, compromise its
security, interfere with other users, defeat technical restrictions, engage in
payment or chargeback fraud, or continue a use that we have specifically
suspended under these terms.

Epic Games, game publishers, developers, and other rights holders retain their
rights in their respective content, artwork, names, trademarks, and other
materials. egdata contributes aggregation, normalization, organization, and
unification of data. These terms grant access and permissions only to the extent
we are entitled to grant them; they do not claim ownership of third-party
content or grant rights we do not hold.

You are responsible for obtaining any additional permissions your use requires
under applicable law. Your own access to Epic Games or other third-party services
is subject to any agreements that independently apply to that access; using
egdata does not by itself make you a party to every third-party agreement.
Do not present the data or your product as an official Epic Games product or
claim that egdata or Epic Games endorses your use.

## 8. Service availability and data quality

The service is provided on a best-effort basis. We do not promise a particular
uptime percentage, response time, support response deadline, update frequency,
or continuing availability of an endpoint or data source. These terms are not
a service-level agreement and do not provide automatic uptime service credits.

Data may be incomplete, delayed, inaccurate, or changed by its source. Prices,
availability, promotions, and regional conditions can change. Verify important
information against the relevant official source before relying on it.

We may maintain, modify, limit, or discontinue parts of the service. We aim to
communicate significant planned changes through the portal and documentation.
Urgent security, legal, operational, or third-party-rights issues may require
action without advance notice where necessary and proportionate. If we
permanently discontinue a paid plan before the end of an already-paid billing
period (other than due to your breach), we will give reasonable advance notice
where practicable and refund the unused pro-rata portion of that prepaid period.
Changes to these terms follow section 10. Mandatory legal rights — including
statutory conformity remedies and termination rights for paid digital services
under applicable consumer law — remain unaffected.

## 9. Restrictions, suspension, and rights-holder requests

We may proportionately restrict an endpoint, dataset, project, account, or use
case to address abuse, security risks, payment fraud or disputes, excessive
extraction, breaches of these terms, legal obligations, or a credible
rights-related request from Epic Games or another rights holder. Where
necessary, action may be immediate.

We assess the basis, scope, and urgency of a rights-related request. A request
from a private party is not by itself a court or regulatory order, although
applicable legal or contractual obligations may require us to act. We aim to
limit restrictions to the affected access or use where practicable.

We may ask you to stop a specified use, adapt your application, or stop further
distribution of affected data. Where there is a legal or contractual basis to
require removal of retained copies, we will identify the affected material and
required action and explain the basis where practicable and lawful. A restriction
on future use or distribution may cover previously obtained material where that
basis permits it.

Where practicable and lawful, we will explain the reason and how to request
review at **contact@egdata.app**. We may require information about your use case
before restoring access. Accepting updated terms does not itself remove an
independent suspension or authorize a use that remains prohibited.

## 10. New versions and continued access

We may revise these terms to reflect changes to the service (including new plans
or features), clarify its use, address security or abuse, comply with legal
obligations, or respond to justified third-party-rights concerns. We publish each
revision with a version identifier and change summary. Earlier published versions
remain available in the archive.

**Editorial changes** correct formatting, spelling, or wording without changing
your rights or obligations. They do not require renewed acceptance or interrupt
access. Our records continue to identify the exact version you accepted.

**Material changes** affect rights or obligations, including permitted uses,
billing/pricing rules, redistribution, attribution, liability, or access
restrictions. For ordinary material changes, we give at least **30 calendar days'
advance notice** by email to your verified developer contact address and through
the portal. The notice explains the changes, the effective date and time, how to
accept or end use, and provides a copy of the revised terms you can retain. We
also publish the update in the public version history.

For paid subscriptions, any price change or material change to an active paid
plan will be notified in advance and will not take effect before your next
renewal period (unless agreed earlier by you or required urgently for legal,
security, or third-party-rights reasons), giving you the opportunity to cancel
before the new price or terms apply.

For this ordinary notice period, we count from the later of portal availability
and successful dispatch to your verified address, subject to applicable notice
requirements. A known bounce or delivery failure is not treated as successful
notice: we retry, help you repair the contact address, and postpone the ordinary
effective time where needed to preserve the full 30-day period. Portal publication
alone does not cure that failure. You should monitor your verified address;
failure to open a properly communicated notice does not restart the period, and
delivery does not establish acceptance. Updating your address triggers a resend
without resetting a deadline already properly communicated.

For accounts still missing acceptance, we aim to send courtesy reminders about
seven days and one day before the deadline and keep a portal banner visible.
Reminders do not replace the initial notice or extend a properly notified deadline.

You may expressly accept an upcoming material revision during the notice period.
The previously accepted terms continue to govern use until the announced
effective time; accepting early does not bring the new duties into effect early.
Editorial revisions alone do not invalidate an existing acceptance.

A new edition does not govern past use merely because it is published or because
a rights-related restriction is imposed. Restrictions on ongoing use of existing
copies remain subject to sections 6 and 9 and applicable law.

At the announced effective time, accounts that have not expressly accepted the
required material revision have their protected dashboard and API access paused
automatically. Requests made with existing API keys are denied during the pause,
including those from automated integrations that continue calling the API without
opening the dashboard. Silence, an unopened notice, or an automated API call is
not recorded as your express acceptance. Publishing an update alone does not
pause an existing account's access. During the initial onboarding described in
section 2, no API pause is active and existing keys keep working; the API-key
denial above applies only from the announced effective time of a later
requirement that has been activated under this section.

The pause leaves your keys intact (and does not by itself cancel an active paid
subscription, though you may cancel or request withdrawal at any time).
Acceptance restores otherwise-valid access; it does not revive revoked or
expired credentials, reset quotas, or remove an independent suspension or
payment failure. Machine-readable API errors identify the acceptance requirement
and a fixed portal review URL leading to the agreements page at
`/profile/agreements` (older `/agreements` links redirect there), as described in
the technical documentation.

**Urgent changes and restrictions** needed for security, legal compliance, or
justified third-party-rights protection may have a shorter notice period or take
effect immediately where necessary. We identify the effective time and explain
the urgency where practicable and lawful. Restrictions under section 9 can be
imposed independently of a terms revision; agreeing to a revision does not
remove them. These exceptions do not remove mandatory rights or remedies.

Privacy Notice revisions are communicated separately and do not require your
acceptance or acknowledgement to keep API access. Where optional processing
requires consent, we request it separately before that processing begins.

If you disagree with a new version, you may stop using the service, cancel any
paid subscription, revoke your credentials, or close your developer account.
Public legal texts, agreement review and acceptance, billing portal/receipts/
cancellation/withdrawal controls, account/contact recovery, credential-status
and revocation controls, logout, support, account-closure, and privacy-rights
channels remain available during an agreement pause, subject to appropriate
identity and security checks. We do not treat a refusal to accept as acceptance
of the revised obligations. The surviving provisions are described in section 13.

## 11. Privacy and ending use

The separately versioned [Developer Privacy Notice](https://devs.egdata.app/privacy)
explains how we process personal data. Accepting these terms does not waive
data-protection rights and does not constitute consent to advertising or other
optional processing.

If your application sends users' personal information to egdata, explain that
connection and provide an accessible link to the current Developer Privacy
Notice. For direct browser calls, present this information before those requests
begin. For information your server forwards about users, provide the required
information within the applicable legal timing and do not forward unnecessary
personal data. Keep the disclosure current when we notify you of relevant changes
and provide any additional information your own processing requires. This does
not transfer egdata's own transparency obligations to you or treat notice as
consent where consent is separately required.

You may end your use at any time. You can close your account from the Profile
page (`/profile`) — we ask you to type a confirmation and to have signed in
within the last 10 minutes — or by email to **contact@egdata.app**. We process
closure without undue delay after any reasonably necessary identity
verification, confirm completion, and explain any material delay. Closure
immediately cancels active paid Stripe subscriptions (ending future renewals),
deletes your active account, project, key, and contact records, ends your
dashboard and console sessions, and rejects your API keys; re-registering the
same Epic Games account is held for 30 days. Minimal acceptance evidence and
financial/billing/withdrawal audit records are retained as described in the
Privacy Notice. You may revoke credentials immediately while closure is being
processed. Closure ends API access; permitted continued use of existing caches
follows section 6. Applicable attribution and lawful restrictions on already
distributed material continue to apply to that material.

Ending access does not necessarily erase all records immediately: necessary
retention and your rights are explained in the Privacy Notice. Account closure
and a data-protection request are distinct processes; applicable statutory
response deadlines and erasure obligations apply to the latter.

## 12. Responsibility and applicable law

### Your commercial products and third-party claims

If you use the service in the course of a trade, business, or profession, you
are responsible for your products and the promises you make to your customers.
To the extent permitted by law, you must reimburse egdata for reasonable,
documented losses and external legal costs arising from a third-party claim
against egdata, but only to the extent caused by your breach of these terms,
your unauthorized use of third-party content, or your unlawful conduct in
operating or supplying your product. This includes qualifying claims by your
customers or rights holders; a complaint alone does not establish liability.

This obligation does not cover losses attributable to egdata's own breach,
negligence, misconduct, or infringement, or arise merely because your product
uses egdata data. It does not apply to a person acting as a consumer.

We will notify you promptly of a claim, provide information reasonably needed
to respond, allow you a reasonable opportunity to participate in its defence,
and take reasonable steps to limit losses. Reimbursement of damages or settlement
amounts requires a final court determination or a settlement you have approved
in writing. We will not agree to a settlement payable by you without that
approval. Reasonable, documented external legal costs are recoverable only to
the extent the claim falls within the responsibility described above.

### Service responsibility and governing law

To the extent permitted by applicable law, the service and data are provided
without a guarantee of uninterrupted operation, completeness, accuracy, or
suitability for a particular purpose. You should design your application to
handle interruptions, stale data, and quota or access errors.

Nothing in these terms excludes or limits liability where doing so is unlawful,
including liability for intentional misconduct or any mandatory consumer,
digital-content/digital-service conformity, or data-protection remedies. The
absence of an SLA does not remove obligations imposed by law.

Spanish law governs these terms, subject to mandatory protections that apply to
you under other applicable law. Jurisdiction is determined by applicable law;
these terms do not impose exclusive jurisdiction at egdata's domicile on business
users or require consumers to waive protected forums or remedies.

If you are a consumer, you may raise complaints directly with **contact@egdata.app**
or through competent consumer protection bodies in your jurisdiction. [TO COMPLETE:
verify if any Spain/EU consumer ADR link or statutory complaint sheet note is
required for your commercial status.]

These terms are published in English. If we provide a translation, the English
version prevails in case of a discrepancy to the extent permitted by applicable
law. This does not override mandatory language, transparency, or consumer rights.

For questions, permission requests, billing inquiries, or disputes, contact
**contact@egdata.app**.

## 13. Provisions that continue after access ends

Under the terms applicable to the relevant use, the following continue to the
extent relevant after a pause, termination, or account closure:

- Section 4 payment, refund, withdrawal, and chargeback/dispute obligations
  already incurred before termination or closure.
- Section 5 attribution for retained or distributed material where required.
- Section 6 permissions and restrictions for existing caches, extraction, and
  redistribution, and section 7 third-party rights and non-affiliation duties.
- Section 9 restrictions supported by an applicable basis, including specific
  lawful stop-use or removal obligations affecting retained or distributed data.
- Section 12 responsibility for acts or omissions during the agreement and for
  permitted continued use of retained data, including qualifying third-party
  claims made later, with all its limitations and procedural safeguards, and its
  applicable-law, jurisdiction, and language provisions for related disputes.
- Sections 11 and 14 as needed for closure, account or agreement transfer, and
  interpreting these surviving provisions.

Survival does not grant new API access, impose an unaccepted revision, expand a
claim beyond its original scope, or extend an applicable legal limitation period.

## 14. Severability and transfers

If a provision is invalid or unenforceable, the remaining provisions continue
to apply to the extent the agreement can lawfully continue without it. Mandatory
law governs the consequences; this clause does not authorize rewriting an unfair
term to make it enforceable or reduce protections you have under that law.

A proposed transfer of this agreement with the service to a new operator will
be notified to you in advance, identifying the successor and its contact details
and explaining any effect on your rights. Any transfer must preserve applicable
rights and guarantees, and we will obtain your consent where required by law.
This clause is not advance consent to release egdata from existing liability or
to diminish your guarantees. Any associated material terms changes follow
section 10; any personal-data transfer must independently comply with applicable
data-protection law and the Privacy Notice.

You may request an account or agreement transfer by contacting us. Do not hand
over credentials as a substitute for an approved transfer; any transfer remains
subject to identity, authority, security, and applicable legal requirements.
