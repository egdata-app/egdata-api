---
title: Game details
description: Load an offer, discover its items, and follow catalog relationships.
---

Search returns offer IDs. Load a complete offer with `GET https://api.egdata.app/v1/offers/{id}` and load the store items connected to it with `GET https://api.egdata.app/v1/offers/{id}/items`.

List endpoints such as `GET /v1/offers`, `GET /v1/offers/top-sellers`, and `GET /v1/sellers/{id}` return `{ data, meta }` with cursor-paginated or bounded arrays of offer documents, including tags, items, custom attributes, and the complete key image set.

```js
const base = "https://api.egdata.app/v1";
const offerId = "offer-id";
const headers = { "X-API-Key": process.env.EGDATA_API_KEY };

const [offerResponse, itemsResponse] = await Promise.all([
  fetch(`${base}/offers/${encodeURIComponent(offerId)}?locale=en-US`, {
    headers,
  }),
  fetch(`${base}/offers/${encodeURIComponent(offerId)}/items`, { headers }),
]);

if (!offerResponse.ok || !itemsResponse.ok) {
  throw new Error("Failed to load offer details");
}

const { data: offer } = await offerResponse.json();
const { data: items } = await itemsResponse.json();
```

An offer response includes its catalog identity and metadata in `data`. Item results identify related catalog items; load a specific item with `GET https://api.egdata.app/v1/items/{id}`. Items may link to multiple offers, and offers can reference direct items, subitems, or linked offers, so use the returned IDs to follow relationships instead of assuming one offer maps to one item.

```json
{
  "data": {
    "id": "offer-id",
    "title": "Example Game",
    "namespace": "example-namespace",
    "items": [{ "id": "item-id" }]
  },
  "meta": {
    "country": "US",
    "region": "US",
    "locale": "en-US"
  }
}
```

Offer and item IDs are opaque strings. Offers may also have catalog item IDs, namespace IDs, and Epic product identifiers; keep the identifier type with the value when storing or sharing it. Add `locale` to offer requests to localize public offer text. The [API reference](/docs/api-reference) lists related routes for assets, bundles, builds, mappings, and suggestions.

## Technical requirements

Use `GET https://api.egdata.app/v1/offers/{id}/requirements` to retrieve the offer's Windows and macOS technical requirements. The endpoint resolves each platform independently and returns `null` for a platform without a requirements record. DLCs inherit requirements only when their source confirms that they have no requirements of their own and an explicit, valid base-game relationship exists. Partial DLC requirements are returned as recorded without filling missing tiers from the parent.

```js
const response = await fetch(
  `https://api.egdata.app/v1/offers/${encodeURIComponent(offerId)}/requirements`,
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);

if (!response.ok) {
  const problem = await response.json().catch(() => null);
  throw new Error(`${problem?.code ?? response.status}: ${problem?.detail ?? ""}`);
}

const {
  data: { windows, macos },
} = await response.json();
```

Each non-null platform result includes its processing state, inheritance and parent metadata, observation time, and minimum and recommended requirement tiers. A `404` (`OFFER_NOT_FOUND` or `REQUIREMENTS_NOT_FOUND`) means the offer does not exist or neither platform has a requirements record.

## Offer reviews

Retrieve community reviews and aggregated scores with `GET https://api.egdata.app/v1/offers/{id}/reviews` and `GET https://api.egdata.app/v1/offers/{id}/reviews-summary` (both require the `offers:read` scope).

- `GET /v1/offers/{id}/reviews`: keyset-paginated public reviews ordered newest first. Accepts optional `verified` (`true` or `false`), `limit` (default `20`, maximum `25`), and `cursor`.
- `GET /v1/offers/{id}/reviews-summary`: aggregates public reviews into `overallScore`, `recommendedPercentage`, `notRecommendedPercentage`, and `totalReviews`. Accepts optional `verified` (`true` or `false`).

```js
const headers = { "X-API-Key": process.env.EGDATA_API_KEY };

const [reviewsRes, summaryRes] = await Promise.all([
  fetch(
    `https://api.egdata.app/v1/offers/${encodeURIComponent(offerId)}/reviews?verified=true&limit=20`,
    { headers },
  ),
  fetch(
    `https://api.egdata.app/v1/offers/${encodeURIComponent(offerId)}/reviews-summary?verified=true`,
    { headers },
  ),
]);

const { data: reviews, meta: reviewsMeta } = await reviewsRes.json();
const { data: summary } = await summaryRes.json();
```

`reviewsMeta.pagination` carries `{ limit, hasMore, nextCursor, total }`. Pass `nextCursor` as `cursor` to read older reviews.

## Offer preview images

Use `GET https://api.egdata.app/v1/offers/{id}/og.webp` for a 1200 x 630 WebP database summary, or `GET https://api.egdata.app/v1/offers/{id}/og` for the same layout as PNG.

- Both routes require `X-API-Key` (`offers:read` scope) and return binary `image/webp` or `image/png` (not JSON-wrapped).
- Both accept `country` for regional pricing (for example, `?country=US`). `country` defaults to `US`; v1 never reads cookies.
- Requests count toward the `heavy` per-minute limit and the `image-period` budget (**2,000** Free / **15,000** Pro / **50,000** Scale).
- Shared HTTP caching is disabled (`Cache-Control: private, no-cache`; `CDN-Cache-Control: no-store`).
- Unknown offer IDs return RFC 9457 Problem Details (`404 OFFER_NOT_FOUND`), and invalid country codes return `400 INVALID_COUNTRY`.

```js
const imageRes = await fetch(
  `https://api.egdata.app/v1/offers/${encodeURIComponent(offerId)}/og.webp?country=US`,
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);

if (!imageRes.ok) {
  const problem = await imageRes.json().catch(() => null);
  throw new Error(`${problem?.code ?? imageRes.status}: ${problem?.detail ?? ""}`);
}

const bytes = await imageRes.arrayBuffer();
```

The card shows the title, offer type, publisher, release date, current regional price, last catalog modification date (UTC), and latest download size in decimal GB (1 GB = 1,000,000,000 bytes). Missing dates or sizes show `Not available`, and missing or country-restricted pricing shows `Unavailable`.

## Sandbox preview images

Use `GET https://api.egdata.app/v1/sandboxes/{sandboxId}/og.webp` for a 1200 x 630 WebP sandbox summary, or `GET https://api.egdata.app/v1/sandboxes/{sandboxId}/og` for PNG (`catalog:read` scope). The card renders the base game's title and artwork, totals for offers, items, and assets, and the sandbox's last update date (UTC).

Like offer preview images, sandbox preview routes require `X-API-Key`, return binary `image/webp` or `image/png` (with `Cache-Control: private, no-cache`; `CDN-Cache-Control: no-store`), count toward the `heavy` per-minute limit and `image-period` budget, and return RFC 9457 Problem Details (`404 SANDBOX_NOT_FOUND`) when the sandbox does not exist.

## Price history

`GET https://api.egdata.app/v1/offers/{id}/price-history` returns newest-first observations:

- Pass `country` or `region` for forward-only cursor pagination using `cursor` and `limit` (default `20`, maximum `100`), with optional `since` (ISO 8601 timestamp) and `locale`.
- Omit both `country` and `region` to receive a single non-paginated response grouped by pricing region.
