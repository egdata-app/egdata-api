# egdata Developer Terms of Service

**Proposed version:** 1.0

**Draft prepared:** 12 November 2026

**Publication date:** [TO COMPLETE]

**Effective date:** [TO COMPLETE]

> REVIEW DRAFT — not published or in force. The agreement flow described below
> is implemented locally for initial portal onboarding but has not been activated.
> Later material-update enforcement remains planned. This draft uses the adopted
> material-change/30-day notice policy.
> Remaining publication details are recorded in the accompanying implementation plan.

## 1. Who provides the service

The egdata Developer Portal and API are operated by **Ignacio Aldama Vicente**,
based in **Spain** (“egdata”, “we”, or “us”). Contact us at
**contact@egdata.app**.

egdata is currently a free, non-commercial project.

These terms govern your use of the developer portal at devs.egdata.app, your
developer account, and API access provided through api.egdata.app or the portal's
API console. They do not replace terms that independently apply to Epic Games
or other third-party services.

“Protected dashboard” means the authenticated project-management, analytics,
quota, key-creation, and API-console features of the portal. “API access” includes
requests to api.egdata.app using existing API keys and requests through the
portal's API console. Section 9 explains the access paused for missing acceptance
and the channels that remain available.

egdata is an independent service. It is not affiliated with, sponsored by, or
endorsed by Epic Games, Inc.

## 2. Agreement and account responsibility

To activate protected dashboard access, sign in, verify a notification email,
and expressly accept the required version of these terms. Signing in by itself
is not acceptance. Each acceptance is recorded as an immutable event containing
the exact terms version and its SHA-256 fingerprint, the server time, and the
Privacy Notice version provided at the same event. You receive a receipt that
you can view at `/profile/receipts` and print or save as PDF from
your browser (the receipt includes both full documents); a copy is also sent to
your verified email address. Published versions never change after publication:
earlier versions remain readable at `/terms/:version` and `/privacy/:version`,
and `/legal/history` lists their fingerprints and publication times.

During the initial onboarding rollout, existing API keys continue working while
you complete these steps, including after a dashboard visit. A visit does not
pause those integrations or count as acceptance. Creating new keys and using the
portal console requires completed onboarding. Any later acceptance deadline for
existing integrations must be announced separately under section 9.

Provide and verify a developer contact email before accepting these terms, and
keep it up to date. We use it for agreement, security, and other essential service
notices. Epic Games sign-in does not provide a verified notification address in
our integration. This contact requirement is not consent to marketing. On your
Profile page (`/profile`) you can edit this notification email — it is the only
account field you can change there, because your Epic Games display name stays
managed by Epic. A replacement address becomes your verified contact only after
you confirm it, and we notify your previous verified address of the change.

You must have legal capacity to enter this agreement. If you act for an
organization, you must have authority to bind it. You are responsible for the
projects you operate, your use of issued credentials, and ensuring that your
applications comply with these terms.

Keep API keys secure and limit their permissions appropriately. Do not publish
secret keys, sell access to your credentials, or let others use your account to
evade restrictions. Revoke compromised keys and contact us if you suspect abuse.
You may operate applications used by other people without sharing your secret
credentials with them.

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
in or use these controls, contact contact@egdata.app for identity-verified
assistance. Replacing a key does
not bypass an agreement pause, quota, or independent restriction.

## 3. Permitted uses and free access

Subject to these terms and applicable third-party rights, you may use the API
for personal, educational, research, open-source, and commercial projects,
including websites, applications, bots, analysis, and data-based features.

Access is currently provided free of charge, within the quotas and permissions
assigned to your account and projects. A higher technical quota or a tier label
does not create a paid subscription or service-level commitment. Approval of a
higher quota does not authorize bulk database extraction.

No particular technical quota is guaranteed. We may reasonably adjust or withdraw
quotas to manage capacity, fair access, abuse, or legal obligations. We aim to give
advance notice of significant planned reductions; urgent action follows sections
7 and 8. A material change to contractual rights follows section 9 and cannot be
introduced merely by relabelling it a quota adjustment.

You may charge users for your application or permitted data outputs, subject to
the attribution and extraction restrictions below. These terms impose no fee or
revenue share payable to egdata. If we introduce paid services, we will explain
their pricing and require a separate affirmative purchase decision. Acceptance
of revised terms alone will not authorize a charge.

## 4. Attribution for paid distribution

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
does not authorize bulk copying, grant trademark rights, or imply endorsement.

## 5. Caching, extraction, and redistribution

You may cache and retain the data reasonably needed for your application's
features and efficient operation, within your access permissions. For example,
maintaining a selected watchlist or caching records actually used by your
application is permitted.

Free API access is not permission to systematically copy or reconstruct the
whole egdata database, or a substantial part of it, for a standalone mirror,
bulk dataset, or substitute data service. Repeated extraction of smaller parts
that cumulatively achieves the same result is also restricted. Slowing down the
extraction or staying below rate limits does not make such copying permitted.

These restrictions concern access to and extraction from the service. They do
not claim ownership of individual facts or exclude uses permitted by mandatory law.

Do not rotate accounts, projects, keys, IP addresses, or other identities to
circumvent quotas or these restrictions. Do not bypass the gateway or access
controls to obtain data.

For full-catalog synchronization, bulk research exports, or a project that needs
a substantial local copy, contact contact@egdata.app for written permission
identifying yourself, your project, intended use, and requested scope. Any grant
must be in writing and specify its scope, conditions, duration, and grounds and
notice for withdrawal, including any urgent rights-related restrictions. Do not
assume a grant is unlimited or permanent; withdrawal operates according to those
agreed conditions and applicable law. We assess scope by the volume, coverage,
systematic nature, and purpose of extraction, not solely by requests per minute.
Providing attribution or charging your own customers does not replace that
permission. No bulk-access fee or offering is promised by these terms.

If your access pauses or ends, you may retain and continue permitted use of
existing, bounded caches lawfully obtained within these permissions. That use
remains governed by the terms applicable when the data was obtained, including
applicable attribution, extraction, redistribution, and third-party-rights
restrictions. It does not authorize further API access, refreshes, or combining
caches to create a prohibited substantial copy. Separate written bulk permissions
follow their own agreed retention conditions. Specific lawful obligations to stop
use or remove affected material, including those addressed in section 8, still
apply; account closure or refusal of revised terms alone does not require deleting
otherwise permitted caches.

## 6. Acceptable use and third-party rights

You must not use the service unlawfully, infringe others' rights, compromise its
security, interfere with other users, defeat technical restrictions, or continue
a use that we have specifically suspended under these terms.

Epic Games, game publishers, developers, and other rights holders retain their
rights in their respective content, artwork, names, trademarks, and other
materials. egdata contributes aggregation, normalization, organization, and
unification of data. These terms grant access and permissions only to the extent
we are entitled to grant them; they do not claim ownership of third-party
content or grant rights we do not hold.

You are responsible for obtaining any additional permissions your use requires.
Do not present the data or your product as an official Epic Games product or
claim that egdata or Epic Games endorses your use.

## 7. Service availability and data quality

The service is provided on a best-effort basis. We do not promise a particular
uptime percentage, response time, support response deadline, update frequency,
or continuing availability of an endpoint or data source. These terms are not
a service-level agreement and do not provide service credits.

Data may be incomplete, delayed, inaccurate, or changed by its source. Prices,
availability, promotions, and regional conditions can change. Verify important
information against the relevant official source before relying on it.

We may maintain, modify, limit, or discontinue parts of the service. We aim to
communicate significant planned changes through the portal and documentation.
Urgent security, legal, operational, or third-party-rights issues may require
action without advance notice where necessary and proportionate. Changes to
these terms follow section 9. Mandatory legal rights and any applicable notice,
termination, or other remedies remain unaffected.

## 8. Restrictions, suspension, and rights-holder requests

We may proportionately restrict an endpoint, dataset, project, account, or use
case to address abuse, security risks, excessive extraction, breaches of these
terms, legal obligations, or a credible rights-related request from Epic Games
or another rights holder. Where necessary, action may be immediate.

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
review at contact@egdata.app. We may require information about your use case
before restoring access. Accepting updated terms does not itself remove an
independent suspension or authorize a use that remains prohibited.

## 9. New versions and continued access

We may revise these terms to reflect changes to the service, clarify its use,
address security or abuse, comply with legal obligations, or respond to justified
third-party-rights concerns. We publish each revision with a version identifier
and change summary. Earlier published versions remain available in the archive.

**Editorial changes** correct formatting, spelling, or wording without changing
your rights or obligations. They do not require renewed acceptance or interrupt
access. Our records continue to identify the exact version you accepted.

**Material changes** affect rights or obligations, including permitted uses,
redistribution, attribution, liability, or access restrictions. For ordinary
material changes, we give at least **30 calendar days' advance notice** by email
to your verified developer contact address and through the portal. The notice
explains the changes, the effective date and time, how to accept or end use, and
provides a copy of the revised terms you can retain. We also publish the update
in the public version history.

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
copies remain subject to sections 5 and 8 and applicable law.

At the announced effective time, accounts that have not expressly accepted the
required material revision have their protected dashboard and API access paused
automatically. Requests made with existing API keys are denied during the pause,
including those from automated integrations that continue calling the API without
opening the dashboard. Silence, an unopened notice, or an automated API call is
not recorded as your express acceptance.
Publishing an update alone does not pause an existing account's access. During
the initial rollout described in section 2, no API pause is active and existing
keys keep working; the API-key denial above applies only from the announced
effective time of a later requirement that has been activated under this
section.

The pause leaves your keys intact. Acceptance restores otherwise-valid access;
it does not revive revoked or expired credentials, reset quotas, or remove an
independent suspension. Machine-readable API errors identify the acceptance
requirement and a fixed portal review URL leading to the agreements page at
`/profile/agreements` (older `/agreements` links redirect there), as described
in the technical documentation.

**Urgent changes and restrictions** needed for security, legal compliance, or
justified third-party-rights protection may have a shorter notice period or take
effect immediately where necessary. We identify the effective time and explain
the urgency where practicable and lawful. Restrictions under section 8 can be
imposed independently of a terms revision; agreeing to a revision does not
remove them. These exceptions do not remove mandatory rights or remedies.

Privacy Notice revisions are communicated separately and do not require your
acceptance or acknowledgement to keep API access. Where optional processing
requires consent, we request it separately before that processing begins.

If you disagree with a new version, you may stop using the service, revoke your
credentials, or contact us to close your developer account. Public legal texts,
agreement review and acceptance, account/contact recovery, credential-status and
revocation controls, logout, support, account-closure, and privacy-rights channels
remain available during an agreement pause, subject to appropriate identity and
security checks. We do not treat a refusal to accept as acceptance of the revised
obligations. The surviving provisions are described in section 12.

## 10. Privacy and ending use

The separately versioned Developer Privacy Notice explains how we process
personal data. Accepting these terms does not waive data-protection rights and
does not constitute consent to advertising or other optional processing.

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
deletes your active account, project, key, and contact records, ends your
dashboard and console sessions, and rejects your API keys; re-registering the
same Epic Games account is held for 30 days. A minimal record of past acceptances
may be retained as described in the Privacy Notice. You may revoke credentials
immediately while closure is being processed. Closure ends API access; permitted
continued use of existing caches follows section 5.
Applicable attribution and lawful restrictions on already distributed material
continue to apply to that material.

Ending access does not necessarily erase all records immediately: necessary
retention and your rights are explained in the Privacy Notice. Account closure
and a data-protection request are distinct processes; applicable statutory
response deadlines and erasure obligations apply to the latter.

## 11. Responsibility and applicable law

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

To the extent permitted by applicable law, the free service and data are
provided without a guarantee of uninterrupted operation, completeness, accuracy,
or suitability for a particular purpose. You should design your application to
handle interruptions, stale data, and quota or access errors.

Nothing in these terms excludes or limits liability where doing so is unlawful,
including liability for intentional misconduct or any mandatory consumer or
data-protection remedies. The absence of an SLA does not remove obligations
imposed by law.

Spanish law governs these terms, subject to mandatory protections that apply to
you under other applicable law. Jurisdiction is determined by applicable law;
these terms do not impose exclusive jurisdiction at egdata's domicile on business
users or require consumers to waive protected forums or remedies.

These terms are published in English. If we provide a translation, the English
version prevails in case of a discrepancy to the extent permitted by applicable
law. This does not override mandatory language, transparency, or consumer rights.

For questions, permission requests, or disputes, contact **contact@egdata.app**.

## 12. Provisions that continue after access ends

Under the terms applicable to the relevant use, the following continue to the
extent relevant after a pause, termination, or account closure:

- Section 4 attribution for retained or distributed material where required.
- Section 5 permissions and restrictions for existing caches, extraction, and
  redistribution, and section 6 third-party rights and non-affiliation duties.
- Section 8 restrictions supported by an applicable basis, including specific
  lawful stop-use or removal obligations affecting retained or distributed data.
- Section 11 responsibility for acts or omissions during the agreement and for
  permitted continued use of retained data, including qualifying third-party
  claims made later, with all its limitations and procedural safeguards, and its
  applicable-law, jurisdiction, and language provisions for related disputes.
- Sections 10 and 13 as needed for closure, account or agreement transfer, and
  interpreting these surviving provisions.

Survival does not grant new API access, impose an unaccepted revision, expand a
claim beyond its original scope, or extend an applicable legal limitation period.

## 13. Severability and transfers

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
section 9; any personal-data transfer must independently comply with applicable
data-protection law and the Privacy Notice.

You may request an account or agreement transfer by contacting us. Do not hand
over credentials as a substitute for an approved transfer; any transfer remains
subject to identity, authority, security, and applicable legal requirements.
