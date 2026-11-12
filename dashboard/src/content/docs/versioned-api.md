---
title: Versioned v1 API
description: API keys, exact quotas, cursor pagination, and the RFC 9457 error contract for /v1.
---

Version 1 keeps the legacy resource path beneath `/v1` (for example `/offers/{id}` becomes `/v1/offers/{id}`). The one rename is `/search/v2/search`, which becomes `/v1/search`. Retired placeholders, private operations, mutations, admin routes, maintenance routes, and GraphQL are not part of v1.

Version 1 is the versioned public read-only contract. It runs beside the legacy API: existing `api.egdata.app` routes and behavior are unchanged while v1 is staged at `https://devs.egdata.app/proxy/v1`.

The first v1 exposure is a staging gateway. Production cutover to `https://api.egdata.app/v1` requires a separate release; do not assume the production URL is live before that cutover is announced.

## Authentication

Every v1 data request requires an API key, regardless of legacy anonymous-access settings or a first-party browser `Origin`.

```js
const response = await fetch("https://devs.egdata.app/proxy/v1/countries", {
  headers: {
    "X-API-Key": process.env.EGDATA_API_KEY,
  },
});

const body = await response.json();
```

`Authorization: Bearer <key>` is also accepted. Sending `X-API-Key` and a different Bearer credential together returns `401 CONFLICTING_CREDENTIALS`.

Only these v1 requests are unauthenticated:

- `GET /v1/health`
- `GET /v1/open-api.json`
- CORS preflights (`OPTIONS`)

The Worker validates the key, permission scope, allowed IP/CIDR, allowed origin, allowed methods, path restrictions, and expiry before forwarding. Path restrictions are evaluated against the `/v1/...` path; a legacy grant such as `/offers/*` does not automatically grant `/v1/offers`.

## Exact global quotas

Each account's quotas are enforced atomically in a SQLite-backed Durable Object.
Every project has an exact 60-second global allowance shared across all its API
keys, console sessions, and authenticated legacy/v1 gateway requests, including
cache hits and subsequent upstream errors. In addition, all free projects owned
by an account share a single **100,000 requests/month** allowance that resets on
the first day of each calendar month at `00:00 UTC`. Creating, rotating, or
deleting keys or recreating projects never resets account or project usage:

| Tier | Requests per UTC-aligned minute (per project) | Monthly free-account allowance |
| --- | ---: | --- |
| Free | 120 | 100,000 / calendar month (shared across all free projects on the account) |
| Pro | 1,200 | Exempt |
| Enterprise | 6,000 | Exempt |

A validated `customRpm` overrides the tier's per-minute default. Request more
capacity under **Rate Limits** in the developer dashboard. An administrator can
approve or decline the request and leave a note in your request history.
Approval applies the requested RPM to the project's existing and future API keys
and its API console. Existing keys can take up to five minutes to refresh; quota
counters are not reset across tier or limit changes. An RPM increase alone on a
`free` project does not remove the 100,000-request monthly cap; upgrading a
project to `pro` or `enterprise` exempts that project while preserving recorded
account usage. Custom requests use the enterprise tier with the approved RPM
override. Legacy gateway requests use the same approved project RPM and account
monthly counter.

Expensive v1 operations also have shared per-project limits, evaluated in the same object and the same request:

| Policy | Limit |
| --- | ---: |
| `offers-list` (`GET /v1/offers`) | 5/minute |
| `search` (`GET /v1/search`) | 300/minute |
| `heavy` (images, profiles, seller detail, collection, promotion detail, natural language, query counts) | 60/minute |
| `bulk` (launcher record resolution) | 10/minute |

Admission is persisted before edge cache lookup or origin forwarding. Failed authentication, permission denials, quota-rejected requests, and unauthenticated bypasses are excluded. A request that is admitted and hits the cache or later fails validation or upstream still consumes quota. Minute or operation exhaustion returns `429 RATE_LIMITED`, while free monthly exhaustion returns `429 MONTHLY_QUOTA_EXCEEDED` with `Retry-After` seconds until the next calendar-month reset, alongside calendar-aware `RateLimit`, `RateLimit-Policy`, and `X-RateLimit-Policy` headers before reaching the origin. If the quota service cannot confirm a decision, the Worker returns retryable `503 QUOTA_UNAVAILABLE` instead of using an approximate counter.

Each quota check is one Durable Object RPC and one bounded state-row write on admission; denials are read-only. A planning estimate of 27.14M monthly non-preflight requests implies roughly $4.05 in incremental Durable Object request charges assuming unused included allowances, while one counter-row write per admission remains below the included 50M writes. This is not a total-cost guarantee; measure actual duration and writes in staging.

Shared HTTP caching is disabled on outgoing authenticated v1 data responses (`Cache-Control: private, no-cache`; `CDN-Cache-Control: no-store`). Every authenticated data request, including `If-None-Match` revalidation, passes API key or dashboard-session authentication, permission checks, and quota admission before the Worker serves from its internal post-auth edge cache or forwards to the origin. Conditional requests can still return `304 Not Modified`; the body is empty and the request was still admitted. `/v1/health` and `/v1/open-api.json` are unauthenticated, skip quota admission and the Worker edge cache, and successful responses use `Cache-Control: public, max-age=60` with `CDN-Cache-Control: no-store`. CORS preflights also skip authentication and quota admission.

## Project creation

Accounts include one project by default. Contact the egdata team for approval of
additional projects. Existing projects remain usable if an account exceeds its
allowance, but further creation is blocked. Project creation is limited to once
every 24 hours per account, including after deletion and automatic creation at
login. Each approved additional project has its own per-minute quota, while free
projects on the same account share the 100,000-request monthly free allowance.

## Response envelope

Successful JSON responses always use:

```json
{ "data": {}, "meta": {} }
```

The OpenAPI document at `/v1/open-api.json` is the one metadata exception: it is returned as the raw OpenAPI document so standard tooling can consume it directly.

Paginated collections put the array in `data` and pagination state under `meta.pagination`:

```json
{
  "data": [/* ... */],
  "meta": {
    "pagination": { "limit": 20, "hasMore": true, "nextCursor": "opaque-cursor" }
  }
}
```

Pagination is forward-only. There are no guaranteed totals or page counts. Live catalog changes can move records during traversal; use the returned cursor for the next page and do not construct cursors yourself.

`POST /v1/search` is read-only and normalizes a JSON filter document into a bodyless `303` redirect to the equivalent GET URL. The redirect uses the origin's configured public v1 base (staging uses `https://devs.egdata.app/proxy/v1`).

Cursors:

- use `cursor` and `limit`; v1 does not accept `page`/`offset` for these collections;
- default to 20 results and are capped at 100 (or the endpoint's lower safety cap);
- are signed with a dedicated origin secret and bound to the operation, normalized filters, ordering, country, locale, page size, and last sort tuple;
- expire after 24 hours;
- return `400 INVALID_CURSOR`, `400 EXPIRED_CURSOR`, or `400 CURSOR_MISMATCH` when they cannot be used.

Bounded reference lists such as countries, regions, tags, and install options are not paginated.

## Defaults and formats

- `country` defaults to `US`; `locale` defaults to `en-US`. Cookies are never used for selection.
- Unknown or invalid query parameters return `400`; unsupported request content types return `415`.
- Timestamps are UTC ISO 8601 strings, IDs are strings, and nullable fields are explicit.
- Price amounts are integer minor units. Use `currencyCode` and `precision` with the amount; for example GBP prices are in pence.
- Native image and XML responses are not JSON-wrapped. Redirects, bodyless `HEAD`, `204`, and `304` responses preserve their HTTP semantics.

## Errors

Errors use `application/problem+json` per RFC 9457:

```json
{
  "type": "https://api.egdata.app/problems/invalid-query",
  "title": "Bad Request",
  "status": 400,
  "detail": "One or more query parameters are invalid or not supported.",
  "instance": "/v1/offers",
  "code": "INVALID_QUERY",
  "requestId": "req_...",
  "errors": [{ "parameter": "limit", "code": "INVALID", "message": "..." }]
}
```

Every v1 response carries `X-Request-Id`; the Worker generates it and the origin propagates it. Include it when reporting an issue. Error `code` values are stable for programmatic handling; human-readable `detail` text may change.

## Versioning policy

Breaking changes require another major API version. Additive fields, additive operations, and additive metadata are permitted within v1. Clients should ignore unknown fields. Separate legacy and v1 OpenAPI documents are published:

- legacy: `https://api.egdata.app/open-api.json`
- v1: `https://devs.egdata.app/proxy/v1/open-api.json`

## Migration notes

| Legacy | v1 |
| --- | --- |
| `GET /offers?page=2&limit=10` | `GET /v1/offers?cursor=...&limit=10` |
| `GET /search/v2/search?...&page=2` | `GET /v1/search?...&cursor=...` |
| `GET /items?page=2` | `GET /v1/items?cursor=...` |
| `GET /offers/{id}` | `GET /v1/offers/{id}` |
| `GET /countries` | `GET /v1/countries` |
| `GET /sitemap.xml` | `GET /v1/sitemap.xml` |

Legacy routes remain available for website embeds and crawlers. Private account operations, mutations, admin routes, maintenance routes, GraphQL, and the placeholder routers are not part of v1.
