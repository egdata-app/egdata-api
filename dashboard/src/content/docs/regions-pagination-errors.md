---
title: Request essentials
description: Choose a country and locale, page through results, and handle errors.
---

## Country and region

Country-aware v1 endpoints accept a two-letter ISO 3166-1 alpha-2 `country` query parameter, such as `US`, `GB`, or `ES`. The API maps the country to an Epic pricing region. When `country` is omitted, v1 defaults to `US` and never reads cookies. Passing an unknown or malformed country code returns `400 INVALID_COUNTRY`.

Use `GET https://api.egdata.app/v1/countries` to list supported country codes and `GET https://api.egdata.app/v1/regions` to list Epic pricing regions, currencies, and member countries.

## Locale

Offer and search endpoints accept `locale`; an omitted or blank value defaults to `en-US` (cookies are never read). Locale syntax is validated and an invalid value returns `400 INVALID_LOCALE`. Localization uses exact locale matches: `es-MX` does not fall back to `es-ES`. When the requested translation is missing for an offer, its text remains in canonical `en-US` and the offer includes `localeStatus: "fallback"` alongside `canonicalLocale: "en-US"`. Only public offer text and content fields are localized; prices, availability, assets, builds, and other operational data remain canonical.

```json
{
  "data": {
    "id": "offer-id",
    "title": "Example Game",
    "locale": "es-MX",
    "localeStatus": "fallback",
    "canonicalLocale": "en-US"
  },
  "meta": {
    "country": "US",
    "region": "US",
    "locale": "es-MX"
  }
}
```

## Pagination

v1 pagination is strictly forward-only using `cursor` and `limit`—`page` and `offset` are never accepted. `limit` defaults to `20` and is capped at `100` (or lower on specific endpoints, such as `25` on `/v1/free-games/history` and `/v1/offers/{id}/reviews`).

Paginated responses return the current page in `data` and cursor state in `meta.pagination`:

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

`meta.pagination.total` is an integer when available or `null` when omitted during live cursor traversal. Cursors are HMAC-signed, bound to the operation, normalized filters, ordering, `country`, `locale`, and `limit`, and expire after 24 hours. Always pass `meta.pagination.nextCursor` verbatim as `cursor`, and handle `400 INVALID_CURSOR`, `400 EXPIRED_CURSOR`, or `400 CURSOR_MISMATCH` by restarting traversal from the first page without `cursor`.

## Rate limits and quotas

v1 enforces exact per-project minute quotas, account/billing-period allowances, and expensive operation budgets. Every authenticated response includes `RateLimit` and `RateLimit-Policy` headers. Throttled `429` responses also include `Retry-After` (seconds) and `X-RateLimit-Policy` (identifying the exhausted policy):

- `429 RATE_LIMITED`: per-minute project or operation-family limit exhausted.
- `429 MONTHLY_QUOTA_EXCEEDED`: free-tier 100,000-request UTC calendar-month account allowance exhausted.
- `429 PERIOD_QUOTA_EXCEEDED`: paid-tier billing-period allowance or initial 14-day daily pacing limit exhausted.
- `429 EXPENSIVE_BUDGET_EXCEEDED`: per-period budget for natural-language search, bulk resolution, or image rendering exhausted.
- `403 PLAN_ENTITLEMENT_REQUIRED`: current plan does not include the requested capability.
- `503 QUOTA_UNAVAILABLE`: quota service could not confirm admission; retry after `Retry-After`.

Wait at least `Retry-After` seconds before retrying. See [Versioned v1 API](/docs/versioned-api) for exact plan tables and expensive policy limits.

## Errors

All v1 errors use RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`, `code`, `requestId`, optional `instance`, and an optional `errors` array for parameter or body validation issues:

```json
{
  "type": "https://api.egdata.app/problems/invalid-query",
  "title": "Bad Request",
  "status": 400,
  "detail": "One or more query parameters are invalid or not supported.",
  "instance": "/v1/offers",
  "code": "INVALID_QUERY",
  "requestId": "req_...",
  "errors": [{ "parameter": "country", "code": "INVALID", "message": "..." }]
}
```

Check `response.ok` before parsing `data`, and inspect `problem?.code` and `problem?.requestId` when handling or logging errors:

```js
const response = await fetch(
  "https://api.egdata.app/v1/offers/offer-id?country=GB&locale=es-MX",
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);

if (!response.ok) {
  const problem = await response.json().catch(() => null);
  throw new Error(
    `Request failed (${response.status}, code=${problem?.code ?? "UNKNOWN"}, requestId=${problem?.requestId ?? response.headers.get("X-Request-Id") ?? "none"}): ${problem?.detail ?? ""}`,
  );
}

const { data, meta } = await response.json();
```

Use stable `code` values for programmatic error handling and include `requestId` when reporting issues. See [v1 Problem Details](/docs/v1-problems) and the [Problem details reference](/docs/problems) for the full catalog of error codes.
