---
title: Natural-language search
description: Find games by describing what you are looking for.
---

Use `POST https://api.egdata.app/v1/search/natural-language` (requires the `search:read` scope) when a phrase describes the kind of game you want better than exact filters. Send only the JSON body (`{ query, topK }`)—do not pass query parameters such as `?locale=en-US`.

```js
const response = await fetch(
  "https://api.egdata.app/v1/search/natural-language",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
    body: JSON.stringify({
      query: "open world co-op survival games",
      topK: 10,
    }),
  },
);

if (!response.ok) {
  const problem = await response.json().catch(() => null);
  throw new Error(`${problem?.code ?? response.status}: ${problem?.detail ?? ""}`);
}

const { data: matches, meta } = await response.json();
```

Each entry in `data` contains a similarity `score` and the matching `offer`, ordered from highest to lowest similarity, with query metadata in `meta`:

```json
{
  "data": [
    {
      "score": 0.91,
      "offer": {
        "id": "offer-id",
        "title": "Example Game"
      }
    }
  ],
  "meta": {
    "query": "open world co-op survival games",
    "count": 1,
    "locale": "en-US"
  }
}
```

- `query` is required and must be between 1 and 500 characters.
- `topK` is optional, defaults to `10`, and accepts integers from `1` through `50`.
- `meta.count` may be lower than `topK` if a vector match no longer maps to a catalog offer. Treat `score` values as relative ranking hints rather than fixed relevance thresholds.

Natural-language search counts toward the `heavy` per-minute policy and the `nl-search-period` budget (**500** Free, **2,500** Pro, **10,000** Scale per period). See [Versioned v1 API](/docs/versioned-api) for quota details.
