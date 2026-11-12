---
title: Get started
description: Make your first request to the egdata API.
---

The egdata API provides public Epic Games Store catalog, price, promotion, and change data as JSON. The legacy base URL is `https://api.egdata.app`.

A versioned `/v1` contract is staged at `https://devs.egdata.app/proxy/v1`. It requires API keys, uses exact per-project quotas shared with authenticated legacy gateway traffic, cursor pagination, and RFC 9457 Problem Details. See [Versioned v1 API](/docs/versioned-api) before migrating. Legacy public hostname routing remains unchanged until an explicit production cutover.

The Worker gateway is staged separately; `api.egdata.app` continues using its current routing and authentication. The dedicated `origin-api.egdata.app` hostname requires a private `X-Egdata-Origin-Token` supplied by the Worker; direct unauthenticated requests there return `403 ORIGIN_ACCESS_DENIED`. Never put this credential in client applications. A `503 ORIGIN_NOT_CONFIGURED` or `502 ORIGIN_UNAVAILABLE` response on the staging gateway indicates a deployment problem. Moving the public API to the Worker and enabling global origin enforcement require a separate cutover.

Fetch an offer by its catalog offer ID:

```js
const response = await fetch(
  "https://api.egdata.app/offers/offer-id?locale=en-US",
);

if (!response.ok) {
  throw new Error(`egdata returned ${response.status}`);
}

const offer = await response.json();
console.log(offer.title);
```

A successful response includes the offer ID and its catalog details:

```json
{ "id": "offer-id", "title": "Example Game", "locale": "en-US" }
```

Offer IDs come from search results or the Epic catalog. Responses are JSON; check the HTTP status before reading a response as successful. If an ID is unknown, the API returns `404`.

Start with [Find games](/docs/offer-search), then use [Game details](/docs/game-details) to load offers, items, and their relationships. See [Request essentials](/docs/regions-pagination-errors) for country, locale, pagination, and error behavior.
