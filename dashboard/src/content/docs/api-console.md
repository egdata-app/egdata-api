---
title: API console sessions
description: Try v1 operations with short-lived, project-scoped console access.
---

In the developer dashboard, select your project and open **API Reference**.
Choose **Start 10-minute session**, select an operation, and send your request.
The session expires automatically; starting another session requires a new click.
You can end it at any time. You can also paste an existing API key instead.

Console sessions work only through the dashboard's same-origin `/proxy/v1`
gateway while signed in with the login that created them. A copied console
credential alone cannot authenticate an external application or the public API
hostname. Use a regular API key for your applications.

After the initial legal documents are published, verify a notification email and
explicitly accept the Developer Terms at `/profile/agreements` before using dashboard
features or console sessions. This also applies to already-issued console sessions.
The Privacy Notice is informational. Existing application API keys keep working
during initial onboarding, even after an incomplete dashboard visit.

The account menu offers **Profile** and **Log out**. Profile (`/profile`) contains
email-only editing and account deletion. Agreements (`/profile/agreements`) and
Receipts (`/profile/receipts`) share the same header and account navigation.
Your display name remains managed by Epic. Deletion
requires a recent sign-in and typed confirmation; it ends account sessions and
credentials, including cached API keys. Closed-account keys return
`401 INVALID_API_KEY`. If credential/account status cannot be verified, the gateway
returns uncacheable `503 ACCOUNT_STATUS_UNAVAILABLE` with `Retry-After: 30` before
quota/upstream access. Complete onboarding for a console `AGREEMENT_REQUIRED` or
`EMAIL_VERIFICATION_REQUIRED` response rather than repeatedly retrying it.

Receipts show a stable receipt ID, Epic account ID, UTC acceptance time, and the
exact terms and privacy versions and hashes recorded for that event. Terms are
accepted; the Privacy Notice is provided for information, not consent. Older
receipts without a recorded privacy version explicitly say so. Later profile or
document changes do not rewrite receipt history. Use **Print / Save as PDF** to
include the receipt and both full documents, even when collapsed on screen.
The original account-scoped JSON export remains at `/_dashboard/api/account/receipt`.
Old `/agreements` and `/receipts` links redirect to the corresponding Profile pages.

Profile offers **Export account data** via `GET /_dashboard/api/account/export`,
including during onboarding. The uncacheable NDJSON attachment contains selected
account-scoped D1 records, excludes credentials and verification secrets, and ends
with `{"section":"complete"}`. Discard incomplete downloads and retry. This live
export is not a complete cross-store rights response; email `contact@egdata.app`
for analytics, security, support or backup records.

Usage reports show Origin presence, countries and coarse client categories.
The `origins`, `ips` and `userAgents` dimension IDs remain but do not return raw
Origin URLs, IPs or user agents. Historical reporting is reduced before aggregation;
underlying historical data needs separate rights/retention handling.

Operator routes under `/_dashboard/api/admin/privacy-requests` record rights-case
deadlines and action evidence; `/_dashboard/api/admin/notifications` exposes dispatch
and transport status. Both require a live admin role, session and active onboarding
completion; mutations require same-origin requests. They record evidence rather
than performing cross-store erasure or sending rights replies. See the public API
console guide and `openapi/egdata.dashboard.openapi.json` for fields and errors.

Console requests count toward the selected project's usage and endpoint alerts.
Select **API console** in the Usage page's key filter to see these requests.
All sessions and ordinary API keys for the same project share one global 60-second
quota across legacy and v1 gateway requests, including shared v1 per-operation
limits, and free projects also share the account's 100,000-request calendar-month
allowance. Starting a fresh session, rotating or deleting a key, or recreating a
project never resets these limits. An approved custom project RPM overrides the
tier's per-minute quota on the next console request without renewing the session,
while keeping the monthly free cap unless the project tier is upgraded to Pro or
Enterprise; existing API key metadata can take up to five minutes to refresh.

Credentials remain in page memory and clear on project change, logout, or leaving
the explorer. Logout also revokes sessions for that login. Copies of request
examples contain a placeholder for a regular API key, never the console secret.
Requests still use the deployed contract, and responses retain their normal
format, permissions, errors, and quota headers.

Static registered paths take precedence over parameter paths when identifying
an operation for permissions, quotas and usage. For example, `/v1/offers/genres`
is attributed to `listOfferGenres`, rather than an offer-detail request.
