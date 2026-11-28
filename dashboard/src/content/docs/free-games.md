---
title: Free games
description: Find active and upcoming giveaways with regional restrictions.
---

Use `GET https://api.egdata.app/v1/free-games` (requires the `catalog:read` scope) for active and upcoming store giveaways. Send `country` to select the price and store region and `locale` for localized offer text (defaults are `US` and `en-US`; cookies are never read).

```js
const response = await fetch(
  "https://api.egdata.app/v1/free-games?country=US&locale=en-US",
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

const { data: promotions, meta } = await response.json();
```

`data` is an array of promotion records. Each record includes the `giveaway` object (with promotion dates and platform) and, when an offer document exists, the localized offer fields, `items`, `countriesWhitelist`/`countriesBlacklist`, and regional `price`:

```json
{
  "data": [
    {
      "id": "offer-id",
      "title": "Example Game",
      "countriesWhitelist": [],
      "countriesBlacklist": ["XX"],
      "items": [],
      "giveaway": {
        "id": "offer-id",
        "offerId": "offer-id",
        "platform": "PC",
        "startDate": "2026-09-28T15:00:00.000Z",
        "endDate": "2026-10-05T15:00:00.000Z",
        "historical": []
      },
      "price": null
    }
  ],
  "meta": {
    "country": "US",
    "region": "US",
    "locale": "en-US",
    "count": 1
  }
}
```

Use `giveaway.startDate` and `giveaway.endDate` to show the promotion window. When offer details are present, check `countriesWhitelist` and `countriesBlacklist` against the visitor's country before presenting a claim link: a non-empty whitelist limits eligible countries, and a blacklist always excludes its listed countries. The endpoint returns promotion records with country metadata and does not filter records out by `country`. Some entries, including mobile promotions, may not have a matching offer document, so read the nested `giveaway` fields even when offer fields are absent.

## Giveaway history

`GET https://api.egdata.app/v1/free-games/history` (`catalog:read` scope) returns past promotions ordered by `endDate` descending. It accepts `country`, `locale`, `limit` (default `20`, maximum `25`), and `cursor` for forward-only pagination:

```js
const historyRes = await fetch(
  "https://api.egdata.app/v1/free-games/history?country=US&locale=en-US&limit=20",
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);

const { data: pastPromotions, meta: historyMeta } = await historyRes.json();
```

Pass `historyMeta.pagination.nextCursor` as `cursor` on subsequent requests while `historyMeta.pagination.hasMore` is `true`.
