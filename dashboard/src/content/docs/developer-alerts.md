---
title: API explorer and endpoint alerts
description: Inspect deployed v1 operations and merged changes relevant to your project.
---

The [developer API Reference](https://devs.egdata.app/docs) provides search,
resource grouping, permission scopes, parameters, request bodies, response
schemas, examples, and a history panel. Detail URLs use stable operation IDs,
for example `https://devs.egdata.app/docs/getOffer`.

The executable reference comes from the deployed v1 OpenAPI document. Histories
come from validated merged records and can be ahead of deployment. Each record
has a recorded date, concrete before/after behavior, compatibility, client action,
verification, and source links. Recorded dates are not deployment dates.
Added and removed endpoints keep history pages. An operation absent from the
deployed contract cannot be executed.

## Try it

Paste an API key into the temporary key field. Stored hashes cannot recover an
existing secret. Credentials stay in memory, clear on logout or project change,
and are excluded from copied examples. Scalar assets are hosted by egdata; neither
schemas nor credentials are sent to an external documentation service.

Requests go through the same-origin `/proxy/v1` gateway and retain ordinary key
validation, scopes, IP/origin/path restrictions, and quotas. The console accepts
only registered operations. It displays status, headers, duration, JSON and Problem
Details, XML/text, images, and downloadable binary responses. Responses over 8 MiB
are not previewed. Redirects are displayed rather than followed with credentials.

## Problem Details

v1 errors use RFC 9457 `application/problem+json`, including `type`, `title`,
`status`, `detail`, stable `code`, and `requestId`. `instance` and field-level
`errors` may add context. See the [v1 error standard](/docs/versioned-api).
Handle `code`, and include `requestId` in support reports. Quota denials return
`429` and `Retry-After`; uncertain quota admission returns `503`.

## Project alerts

Sign in and select a project to open its Alerts inbox. A merged change is relevant
when a project key attempted a known v1 operation during the 30 UTC calendar dates
ending on the merge date, at or before the merge timestamp. Admitted requests
that return errors count; authentication failures, permission failures, quota
denials, unknown paths, and preflights do not. Explorer requests count too.

One alert groups every matching operation and key for a project and record.
Revoking a key after qualifying use does not erase relevance. Delayed usage can
produce a delayed alert against the original merge window. First calling an
operation after its change merged does not produce a retrospective alert.

Every alert says **Merged; deployment not verified.** Publication occurs after
merge independently of the VM deployment. Filter by unread, operation, change
type, or compatibility; follow operation/key links and mark individual alerts
read. Mark-all-read uses a server-issued cutoff so newer alerts remain unread.
Read state belongs to the signed-in user and project.

Usage buckets retain only internal key ID, project ID, operation ID, UTC date,
and first-use timestamp for 35 days. Persistent alerts and read state outlive
usage retention. The inbox shows when tracking began, whether it is enabled,
and known delivery failures. No earlier usage is inferred. Undated historical
notes never produce alerts. Email, webhooks, and manual subscriptions are outside
this feature.

Repository and public documentation histories cover legacy and v1 operations.
The dashboard explorer and personalized alerts initially cover v1 only.
