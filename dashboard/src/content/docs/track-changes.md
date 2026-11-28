---
title: Track changes
description: Retrieve catalog updates for an offer and its related records.
---

Use `GET /v1/offers/{id}/changelog` (`offers:read` scope) to page through changes to an offer and its related items and assets. The newest changes appear first.

```js
const response = await fetch(
  "https://api.egdata.app/v1/offers/offer-id/changelog?limit=10",
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

const { data: changes, meta } = await response.json();
```

The response places change entries in `data` and cursor pagination state in `meta.pagination`:

```json
{
  "data": [
    {
      "_id": "64c000000000000000000001",
      "timestamp": "2026-09-30T10:00:00.000Z",
      "metadata": {
        "contextId": "offer-id",
        "contextType": "offer",
        "changes": [{ "field": "title", "oldValue": "Old title", "newValue": "New title" }]
      },
      "document": {
        "id": "offer-id",
        "title": "New title"
      }
    }
  ],
  "meta": {
    "pagination": {
      "limit": 10,
      "hasMore": false,
      "nextCursor": null,
      "total": 1
    }
  }
}
```

Use `cursor` and `limit` to continue forward through the list (`limit` defaults to 20 and is capped at 50; pass `meta.pagination.nextCursor` as `cursor`). Optional `query`, `type`, and `field` parameters narrow changes by text, change type, or changed field. Missing enrichment does not prevent a change record from being returned; `document` context is best effort.

For cross-catalog change search, use `GET /v1/search/changelog` (`search:read` scope, cursor-paginated, accepting `query`, `type`, `id`, `limit`, and `cursor`); for a specific record, use `GET /v1/changelist/{id}` (`catalog:read` scope). Browse all changelog operations in the [API reference](/docs).
