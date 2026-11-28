---
title: Prices
description: Read current regional prices, discounts, and price history.
---

Get an offer's current price for a country with `GET https://api.egdata.app/v1/offers/{id}/price`. The route maps `country` (default `US`) to an Epic pricing region and returns its price record in `data`, including the current price and discount fields when available.

```js
const response = await fetch(
  "https://api.egdata.app/v1/offers/offer-id/price?country=GB",
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

const { data: price, meta } = await response.json();
```

For prices across regions or historical bounds, use `GET https://api.egdata.app/v1/offers/{id}/regional-price`. Include `country` to get the selected country's current price and historical range; omit `country` to receive an object keyed by eligible pricing region.

```js
const response = await fetch(
  "https://api.egdata.app/v1/offers/offer-id/regional-price?country=GB",
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);

const { data: regionalPrice, meta } = await response.json();
```

A country-specific `regional-price` response returns `{ data, meta }`:

```json
{
  "data": {
    "currentPrice": {
      "offerId": "offer-id",
      "region": "GB",
      "currencyCode": "GBP",
      "precision": 2,
      "originalPrice": 2499,
      "discountPrice": 1999,
      "price": {
        "currencyCode": "GBP",
        "originalPrice": 2499,
        "discountPrice": 1999,
        "discount": 20,
        "precision": 2
      }
    },
    "minPrice": 1999,
    "maxPrice": 2499
  },
  "meta": {
    "country": "GB",
    "region": "GB"
  }
}
```

For historical snapshots, call `GET https://api.egdata.app/v1/offers/{id}/price-history?country=GB` (or pass `region`). It supports `since` (ISO 8601 timestamp), `limit` (default `20`, max `100`), `cursor` for forward-only pagination, and `locale`. Omit both `country` and `region` to receive history grouped by pricing region.

Price amounts are integer minor units. Use `currencyCode` and `precision` together when formatting them (for example, `precision: 2` means pence for `GBP` and cents for `USD`). A `discount` value of `0` means no discount; use the returned price data rather than inferring availability from a discount.

The offer's `countriesWhitelist` and `countriesBlacklist` control current-price access. A non-empty whitelist restricts eligible countries; a blacklist excludes listed countries. If the requested country is ineligible or has no price record, `/v1/offers/{id}/price` and `/v1/offers/{id}/regional-price?country=...` return `404 PRICE_NOT_FOUND` (or `404 OFFER_NOT_FOUND` if the offer does not exist). Multi-region responses omit regions with no eligible countries. Historical observations remain available even when an offer is no longer available in that region; historical data does not restore current availability.
