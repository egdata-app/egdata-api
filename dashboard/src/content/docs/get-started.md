---
title: Get started
description: Make your first request to the egdata API.
---

The egdata API provides Epic Games Store catalog, price, promotion, and change data as JSON. The primary v1 base URL is `https://api.egdata.app/v1`.

Every v1 data request requires an API key created in [API Keys](/keys). Send your key in the `X-API-Key` header (or as `Authorization: Bearer <key>`). For quick interactive testing from the browser, the in-dashboard API console uses `https://devs.egdata.app/proxy/v1` with short-lived console sessions.

Fetch an offer by its catalog offer ID:

```js
const response = await fetch(
  "https://api.egdata.app/v1/offers/offer-id?locale=en-US",
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);

if (!response.ok) {
  const problem = await response.json().catch(() => null);
  throw new Error(
    `egdata returned ${response.status} (${problem?.code ?? "UNKNOWN"}): ${problem?.detail ?? ""}`,
  );
}

const { data: offer, meta } = await response.json();
console.log(offer.title, meta.locale);
```

Successful v1 JSON responses wrap the payload in a `{ "data": ..., "meta": ... }` envelope:

```json
{
  "data": {
    "id": "offer-id",
    "title": "Example Game",
    "locale": "en-US",
    "localeStatus": "canonical"
  },
  "meta": {
    "country": "US",
    "region": "US",
    "locale": "en-US"
  }
}
```

Offer IDs come from search results or the Epic catalog. Always check `response.ok` before reading `data`—if an ID is unknown or an input is invalid, the API returns an RFC 9457 `application/problem+json` error (such as `404 OFFER_NOT_FOUND`).

## Next steps

- Read [Versioned v1 API](/docs/versioned-api) for authentication, plans, quotas, and response envelopes.
- Start with [Find games](/docs/offer-search) to query and filter the catalog.
- Use [Game details](/docs/game-details) to load offers, items, reviews, requirements, and preview images.
- See [Request essentials](/docs/regions-pagination-errors) for country, locale, forward-only cursor pagination, and error handling.
- Explore [Profiles](/docs/profiles) for player profile highlights, games, and recent activity.
