---
title: Natural-language search
description: Find games by describing what you are looking for.
---

Use `POST /search/natural-language` when a phrase describes the kind of game you want better than exact filters.

```js
const response = await fetch(
  "https://api.egdata.app/search/natural-language?locale=en-US",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "open world co-op survival games", topK: 10 }),
  },
);
const result = await response.json();
```

Each match contains a similarity score and a current offer. Results are ordered by similarity:

```json
{
  "query": "open world co-op survival games",
  "count": 1,
  "matches": [{ "score": 0.91, "offer": { "id": "offer-id", "title": "Example Game" } }]
}
```

`query` is required and may contain up to 500 characters. `topK` defaults to 10 and accepts 1 through 50. `count` may be lower than `topK` if a match no longer has a corresponding offer. Treat scores as relative ranking hints, not fixed relevance thresholds.
