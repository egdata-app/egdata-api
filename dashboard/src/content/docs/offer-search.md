---
title: Find games
description: Search the catalog, combine filters, and order results.
---

Use `GET https://api.egdata.app/v1/search` (requires the `search:read` scope) to find store offers by title and filter them by offer type, tags, seller, developer, publisher, category, detected technology, or regional price. Pass the visitor's two-letter ISO 3166-1 alpha-2 country code as `country` so price filters and returned prices use the right region. `country` defaults to `US` and `locale` defaults to `en-US`; v1 never reads cookies.

```js
const params = new URLSearchParams({
  country: "US",
  locale: "en-US",
  title: "co-op adventure",
  offerType: "BASE_GAME",
  onSale: "true",
  sortBy: "discountPercent",
  sortDir: "desc",
  fields: "card",
  facets: "none",
  limit: "20",
});

const response = await fetch(`https://api.egdata.app/v1/search?${params}`, {
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

## Query parameters

Filters are flat query parameters:

- **Text & taxonomy**: `title`, `offerType`, `tags` (all must match), `categories` (any must match), `customAttributes`, `technologies` (all must match), `seller`, `developerDisplayName`, `publisherDisplayName`, `refundType`.
- **Boolean flags** (`true`/`false` or `1`/`0`): `isCodeRedemptionOnly`, `excludeBlockchain`, `onSale`, `pastGiveaways`, `isLowestPrice`, `isLowestPriceEver`.
- **Price & region**: `priceMin`, `priceMax` (integer minor units in the selected region's currency), `country`, `locale`.
- **Sorting**: `sortBy` (`releaseDate`, `lastModifiedDate`, `effectiveDate`, `creationDate`, `viewableDate`, `pcReleaseDate`, `upcoming`, `priceAsc`, `priceDesc`, `price`, `discount`, `discountPercent`, `priceUpdatedAt`, `giveawayDate`), `sortDir` (`asc` or `desc`, defaults to `desc`).
- **Response shaping**: `fields` (`full` default or `card`), `facets` (`none` default, `minimal`, or `full`).
- **Pagination**: `limit` (default `20`, max `100`) and `cursor` (opaque forward-only token from `meta.pagination.nextCursor`).

List parameters (`tags`, `categories`, `customAttributes`, `technologies`) accept comma-separated values. For values containing literal commas, use repeated bracketed parameters such as `technologies[]=Engine%2C%20Inc.`. Bracketed parameters take precedence over CSV values.

Without `sortBy`, text searches (`title`) rank by relevance and unfiltered searches sort by `lastModifiedDate` descending. Price sorting uses the selected `country`'s region. Some date sorts (`upcoming`, `releaseDate`) also restrict results to future or released offers.

## Response format

Results are wrapped in `{ data, meta }`:

```json
{
  "data": [
    {
      "id": "offer-id",
      "title": "Example Game",
      "offerType": "BASE_GAME",
      "price": null
    }
  ],
  "meta": {
    "country": "US",
    "region": "US",
    "locale": "en-US",
    "facets": {},
    "result": {
      "tookMs": 12,
      "timedOut": false
    },
    "pagination": {
      "limit": 20,
      "hasMore": true,
      "nextCursor": "opaque-cursor",
      "total": null
    }
  }
}
```

Pass `meta.pagination.nextCursor` as `cursor` on the next request to page forward. `meta.pagination.total` is an integer when available or `null` during live cursor traversal.

## Projections (`fields`)

Use `fields` to control the size of each offer in `data`:

- `full` (default): returns the complete offer document, including description, tags, items, custom attributes, and all key images.
- `card`: returns only the fields needed for store cards (`id`, `namespace`, `title`, `offerType`, `keyImages`, `seller`, `tags`, `developerDisplayName`, `publisherDisplayName`, `prePurchase`, `releaseDate`, `price`, `locale`, `localeStatus`, `canonicalLocale`).

## Facets and `GET /v1/search/facets`

Control inline facet aggregations on `GET /v1/search` with `facets`:

- `none` (default): omits aggregations.
- `minimal`: returns `offerType` and `technologies` buckets only.
- `full`: returns `offerType`, `technologies`, `tags`, `developer`, `publisher`, `seller`, and `price` buckets.

To load filter aggregations without fetching offer hits, call `GET https://api.egdata.app/v1/search/facets` with the same filter parameters plus a comma-separated `facets` section list (`offerType`, `tags`, `technologies`, `developer`, `publisher`, `seller`, `price`, or `all`):

```js
const response = await fetch(
  "https://api.egdata.app/v1/search/facets?onSale=true&facets=offerType,tags,price",
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);
const { data: facets, meta } = await response.json();
```

## Redirect helper (`POST /v1/search`)

`POST https://api.egdata.app/v1/search` (`search:read` scope) validates a JSON filter body (with nested `price: { min, max }`, typed booleans/arrays, and optional `country`/`locale`) and returns **303 See Other** (`Cache-Control: no-store`) with a `Location` header pointing to the normalized `GET /v1/search` URL. Standard `fetch` follows `303` redirects automatically via `GET`; prefer calling `GET /v1/search` directly to avoid the extra round trip.

For meaning-based queries, see [Natural-language search](/docs/natural-language-search). Legacy `/search/v2/search` is deprecated in favor of `/v1/search`.
