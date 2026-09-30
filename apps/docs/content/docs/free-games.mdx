---
title: Free games
description: Find active and upcoming giveaways with regional restrictions.
---

Use `GET /free-games` for active and upcoming store giveaways. Send `country` to select the price and store region and `locale` for offer text.

```js
const response = await fetch(
  "https://api.egdata.app/free-games?country=US&locale=en-US",
);
const promotions = await response.json();
```

The response is an array of promotion records. A record may include the localized offer, related items, regional price, and a `giveaway` object with promotion dates and country restrictions.

```json
[
  {
    "id": "offer-id",
    "title": "Example Game",
    "countriesWhitelist": [],
    "countriesBlacklist": ["XX"],
    "giveaway": {
      "offerId": "offer-id",
      "startDate": "2026-09-28T15:00:00.000Z",
      "endDate": "2026-10-05T15:00:00.000Z",
      "platform": null
    },
    "price": null
  }
]
```

Use `giveaway.startDate` and `giveaway.endDate` to show the promotion window. When offer details are present, check `countriesWhitelist` and `countriesBlacklist` against the visitor's country before presenting a claim link. A non-empty whitelist limits eligible countries, and a blacklist always excludes its listed countries. The active-promotion route returns promotion records with country metadata; it does not remove records based on the visitor's country. Some entries, including mobile promotions, may not include a matching offer, so read the nested `giveaway` fields even when offer details are absent. `GET /free-games/history` returns past promotions and accepts `country`, `locale`, `page`, and `limit` (up to 25).
