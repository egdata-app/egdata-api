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
