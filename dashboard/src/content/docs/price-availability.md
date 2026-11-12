---
title: Prices
description: Read current regional prices, discounts, and price history.
---

Get an offer's current price for a country with `GET /offers/{id}/price`. The route maps the country to an Epic pricing region and returns its price record, including the current price and discount fields when available.

```js
const response = await fetch(
  "https://api.egdata.app/offers/offer-id/price?country=GB",
);
const price = await response.json();
```

For prices across regions, use `GET /offers/{id}/regional-price`. Include `country` to get the selected country's current price and historical range; without it, the response covers eligible regions. `GET /offers/{id}/price-history?country=GB` returns observations for that country's region. Add `since` with an ISO date to limit history to later observations; omit `country` and `region` to receive history grouped by region.

```json
{
  "currentPrice": { "region": "GB", "price": { "currencyCode": "GBP", "discountPrice": 1999, "discount": 20 } },
  "minPrice": 1999,
  "maxPrice": 2499
}
```

The sample shows the shape of a country-specific regional-price response. Price amounts use the currency's minor units (for example, pence for GBP); use `currencyCode` when formatting them. A discount value of zero means no discount; use the returned price data rather than inferring availability from a discount.

The offer's country whitelist and blacklist control current-price access. A non-empty whitelist restricts eligible countries; a blacklist excludes countries. If the requested country is ineligible, or has no price record, the current-price endpoint returns `404`. Regional lists omit regions with no eligible countries. Historical observations remain available even when an offer is no longer available in that region; historical data does not restore current availability.
