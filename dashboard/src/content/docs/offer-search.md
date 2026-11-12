---
title: Find games
description: Search the catalog, combine filters, and order results.
---

Use `GET /search/v2/search` to find store offers by title and filter them by offer type, tags, seller, developer, publisher, category, detected technology, or regional price. Send the visitor's two-letter country code as `country` so price filters and returned prices use the right region. GET defaults to `US` and does not read the country cookie, keeping each URL safe to share and cache.

Filters are flat query parameters: `title`, `offerType`, `tags`, `categories`, `customAttributes`, `seller`, `developerDisplayName`, `publisherDisplayName`, `refundType`, `sortBy`, `sortDir`, `limit`, `page`, `facets`, `technologies`, `priceMin`, `priceMax`, and the boolean filters (`isCodeRedemptionOnly`, `excludeBlockchain`, `onSale`, `pastGiveaways`, `isLowestPrice`, `isLowestPriceEver`). Boolean query values accept `true`/`false` or `1`/`0`. Lists use commas; for values containing literal commas, use repeated bracketed parameters such as `technologies[]=Engine%2C%20Inc.`. Bracketed parameters take precedence over CSV values.

```js
const params = new URLSearchParams({
  country: "US",
  locale: "en-US",
  title: "co-op adventure",
  offerType: "BASE_GAME",
  onSale: "true",
  sortBy: "discountPercent",
  sortDir: "desc",
  limit: "20",
});
const response = await fetch(
  `https://api.egdata.app/search/v2/search?${params}`,
);
const result = await response.json();
```

Successful GET responses are cacheable for 60 seconds in browsers and 300 seconds at the CDN, with stale-while-revalidate. The CDN must have a cache rule that enables JSON caching and includes the full query string in its cache key.

`POST /search/v2/search` remains as a compatibility endpoint. It validates the JSON filter object and returns **303 See Other** with an empty body and a relative GET URL in `Location`. Standard `fetch` follows this redirect automatically using GET; clients with redirect following disabled must follow `Location` themselves. Prefer calling GET directly to avoid the extra request. POST redirects use `Cache-Control: no-store` and do not execute a search or access the response cache.

Sanitization removes unknown fields, trims strings, deduplicates and sorts lists, and normalizes integer pagination (`page` at least 1; `limit` between 1 and 100). Default pagination/facet/sort-direction values are omitted from redirect URLs. POST uses typed JSON booleans/numbers/arrays, with nested `price: { min, max }` converted to `priceMin`/`priceMax`. Invalid JSON, wrong filter types, fractional pagination, invalid sort options, or empty list entries return `400`. Unknown facet modes use `full`. The legacy `spt` field has no effect and is discarded.

POST preserves `country`, `locale`, and `expand` from the query string. When country is absent, it resolves `EGDATA_COUNTRY` (or `US`) into an explicit URL parameter; unknown countries fall back to `US`. Unknown query parameters are discarded. Filter values come from the JSON body.

The response contains a total count, matching offers, the requested page and limit, facet aggregations, and metadata. `offers` contains full offer documents, including tags, items, custom attributes, and the complete key image set.

Facets are controlled with `facets`:

- `full` (default) returns offer type, technology, tag, developer, publisher, and seller buckets.
- `minimal` returns offer type and technology buckets only.
- `none` omits aggregations entirely.

```json
{
  "total": 1,
  "offers": [{ "id": "offer-id", "title": "Example Game", "price": null }],
  "page": 1,
  "limit": 20
}
```

`title` searches titles and related text with fuzzy and synonym matching. Filters can be combined. `tags` requires all supplied tag IDs; `technologies` requires every named detected technology.

`page` starts at 1. `limit` defaults to 10 and is capped at 100. Without `sortBy`, text searches rank by relevance and other searches sort by most recently modified. Common `sortBy` values include `releaseDate`, `lastModifiedDate`, `price`, `discount`, `discountPercent`, `priceUpdatedAt`, `upcoming`, and `giveawayDate`; `sortDir` is `asc` or `desc` and defaults to `desc`. Set `sortBy=price` and `sortDir=asc` for the lowest price first. Price sorting uses the selected country's region. Some release date sorts also restrict results to future or released offers.

The legacy `GET`/`POST /search` routes now return `410 Gone` with code `DEPRECATED`; use search v2 instead. Existing saved-query hashes can still be read through `GET /search/{id}`.

For meaning-based queries, see [natural-language search](/docs/natural-language-search).
