---
title: Versioned v1 API
description: API keys, exact quotas, cursor pagination, and the RFC 9457 error contract for /v1.
---

Version 1 is the primary public read-only API contract under `https://api.egdata.app/v1`. It keeps familiar resource paths beneath `/v1` (for example `/v1/offers/{id}`), moves offer search to `/v1/search`, enforces API key authentication, applies exact project and account quotas, uses forward-only cursor pagination, and returns RFC 9457 Problem Details on errors.

The in-dashboard API console sends interactive requests through `https://devs.egdata.app/proxy/v1` using short-lived console sessions. Production applications should target `https://api.egdata.app/v1` with a project API key.

## Authentication

Every v1 data request requires an API key created in [API Keys](/keys):

```js
const response = await fetch("https://api.egdata.app/v1/countries", {
  headers: {
    "X-API-Key": process.env.EGDATA_API_KEY,
  },
});

if (!response.ok) {
  const problem = await response.json().catch(() => null);
  throw new Error(`${problem?.code ?? response.status}: ${problem?.detail ?? ""}`);
}

const { data, meta } = await response.json();
```

`Authorization: Bearer <key>` is also accepted. Sending `X-API-Key` and a different Bearer credential together returns `401 CONFLICTING_CREDENTIALS`.

Only these v1 requests are unauthenticated:

- `GET /v1/health`
- `GET /v1/open-api.json`
- CORS preflights (`OPTIONS`)

The gateway validates the key, permission scope, allowed IP/CIDR, allowed origin, allowed methods, path restrictions, and expiry before forwarding. Path restrictions are evaluated against the `/v1/...` path; a legacy grant such as `/offers/*` does not automatically grant `/v1/offers`.

## Plans and quotas

Each account's quotas are enforced atomically per project and per account. Every project has an exact 60-second global allowance shared across all of its API keys and console sessions. Creating, rotating, or deleting keys or recreating projects never resets account or project usage.

| Plan | Price | Requests per minute (per project) | Period allowance |
| --- | ---: | ---: | --- |
| Free | EUR 0 / month | 60 | 100,000 / UTC calendar month (shared across all free projects on the account) |
| Pro | EUR 9 / month (VAT incl.) | 200 | 300,000 / monthly billing period per project (12,000/day pacing during initial 14-day statutory withdrawal window) |
| Scale | EUR 19 / month (VAT incl.) | 600 | 1,000,000 / monthly billing period per project (35,000/day pacing during initial 14-day window) |
| Enterprise / Manual Grant | Custom | Custom override | Explicit overrides via operator review |

Free-tier calendar-month usage resets on the first day of each month at `00:00 UTC`. Paid plans reset on their monthly billing period and enforce an initial daily pacing cap during the 14-day statutory withdrawal window. You can request higher capacity or review custom overrides under [Rate Limits](/limits).

### Expensive operation limits and budgets

Expensive v1 operation families also enforce per-minute per-project limits and, for selected capabilities, per-period budgets:

| Per-minute policy | Covered operations | Free | Pro | Scale |
| --- | --- | ---: | ---: | ---: |
| `offers-list` | `GET /v1/offers` | 5 / min | 20 / min | 60 / min |
| `search` | `GET /v1/search`, `POST /v1/search`, autocomplete, changelog search | 60 / min | 200 / min | 600 / min |
| `heavy` | OG/cover images, profiles, seller/collection/promotion detail, natural-language search, query counts | 20 / min | 60 / min | 180 / min |
| `bulk` | Launcher record resolution, `/v1/catalog/hydrate` | 5 / min | 15 / min | 40 / min |

| Per-period budget | Covered operations | Free | Pro | Scale |
| --- | --- | ---: | ---: | ---: |
| `nl-search-period` | `POST /v1/search/natural-language` | 500 | 2,500 | 10,000 |
| `bulk-period` | Catalog hydration and launcher bulk resolution | 1,000 | 10,000 | 40,000 |
| `image-period` | On-demand OG and cover images | 2,000 | 15,000 | 50,000 |

### Admission, exhaustion codes, and 5xx restoration

Admission is checked before edge cache lookup or origin forwarding. Failed authentication, permission denials, quota-rejected requests, and unauthenticated endpoints do not consume project quota. Admitted requests that hit the post-auth edge cache or fail validation (`400`/`404`) still consume quota.

If an admitted request fails with an upstream 5xx response (or `502 ORIGIN_UNAVAILABLE`), its monthly/period, daily pacing, and expensive-period budget units are automatically restored; the per-minute counter remains consumed.

When a request is denied:

- `403 PLAN_ENTITLEMENT_REQUIRED`: your current plan does not include the requested capability.
- `429 RATE_LIMITED`: the per-minute project or operation-family limit is exhausted.
- `429 MONTHLY_QUOTA_EXCEEDED`: the account's free 100,000-request UTC calendar-month allowance is exhausted.
- `429 PERIOD_QUOTA_EXCEEDED`: the project's billing-period allowance or initial 14-day daily pacing limit is exhausted.
- `429 EXPENSIVE_BUDGET_EXCEEDED`: the period budget (`nl-search-period`, `bulk-period`, or `image-period`) is exhausted.
- `503 QUOTA_UNAVAILABLE`: the quota service could not confirm admission; retry after the `Retry-After` delay.

Throttled responses include `Retry-After`, `RateLimit`, `RateLimit-Policy`, and `X-RateLimit-Policy` headers.

### Caching and conditional requests

Shared HTTP caching is disabled on outgoing authenticated v1 data responses (`Cache-Control: private, no-cache`; `CDN-Cache-Control: no-store`). Conditional requests using `If-None-Match` can still return `304 Not Modified` with an empty body after authentication, permission checks, and quota admission. `/v1/health` and `/v1/open-api.json` are unauthenticated and skip quota admission.

## Project creation

Accounts include one project by default. Contact the egdata team for approval of additional projects. Project creation is limited to once every 24 hours per account, including after deletion and automatic creation at login. Each project has its own per-minute quota, while free projects on the same account share the 100,000-request UTC calendar-month allowance.

## Response envelope and pagination

Successful JSON responses always use:

```json
{ "data": {}, "meta": {} }
```

The OpenAPI document at `https://api.egdata.app/v1/open-api.json` is the one metadata exception: it is returned as the raw OpenAPI document so standard tooling can consume it directly.

Paginated collections place the array in `data` and pagination state under `meta.pagination`:

```json
{
  "data": [/* ... */],
  "meta": {
    "pagination": {
      "limit": 20,
      "hasMore": true,
      "nextCursor": "opaque-cursor",
      "total": null
    }
  }
}
```

`meta.pagination.total` is an integer when available or `null` when omitted for live traversal. Pagination is strictly forward-only using `cursor` and `limit`; v1 never accepts `page` or `offset`:

- `limit` defaults to `20` and is capped at `100` (or the endpoint's lower safety cap, such as `25` on free-game history and offer reviews).
- Cursors are HMAC-signed with an origin secret and bound to the operation, normalized filters, ordering, country, locale, page size, and last sort tuple.
- Cursors expire after 24 hours and return `400 INVALID_CURSOR`, `400 EXPIRED_CURSOR`, or `400 CURSOR_MISMATCH` when they cannot be used. Do not construct or modify cursors yourself.

Bounded reference lists such as `/v1/countries`, `/v1/regions`, `/v1/tags`, and install options are not paginated.

`POST /v1/search` is read-only and normalizes a JSON filter document into a bodyless `303 See Other` redirect to the equivalent `GET https://api.egdata.app/v1/search` URL.

## Defaults and formats

- `country` defaults to `US`; `locale` defaults to `en-US`. Cookies are never read.
- Unknown or invalid query parameters return `400`; unsupported request content types return `415`.
- Timestamps are UTC ISO 8601 strings, IDs are strings, and nullable fields are explicit.
- Price amounts are integer minor units. Use `currencyCode` and `precision` with the amount; for example, GBP prices (`precision: 2`) are in pence.
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

Every v1 response carries `X-Request-Id`. Include `requestId` when reporting an issue. Error `code` values are stable for programmatic handling; see [v1 Problem Details](/docs/v1-problems) and the [Problem details reference](/docs/problems).

## Versioning and OpenAPI

Breaking changes require another major API version. Additive fields, additive operations, and additive metadata are permitted within v1, so clients should ignore unknown fields.

- v1 OpenAPI document: `https://api.egdata.app/v1/open-api.json`
- Interactive explorer: [API reference](/docs/api-reference)

## Migration notes

| Legacy | v1 |
| --- | --- |
| `GET /offers?page=2&limit=10` | `GET /v1/offers?cursor=...&limit=10` |
| `GET /search/v2/search?...&page=2` | `GET /v1/search?...&cursor=...` |
| `GET /items?page=2` | `GET /v1/items?cursor=...` |
| `GET /offers/{id}` | `GET /v1/offers/{id}` |
| `GET /countries` | `GET /v1/countries` |
| `GET /sitemap.xml` | `GET /v1/sitemap.xml` |
