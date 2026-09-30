---
title: Track changes
description: Retrieve catalog updates for an offer and its related records.
---

Use `GET /offers/{id}/changelog` to page through changes to an offer and its related items and assets. The newest changes appear first.

```js
const response = await fetch(
  "https://api.egdata.app/offers/offer-id/changelog?page=1&limit=10",
);
const result = await response.json();
```

The response includes `elements`, pagination details, and each change's timestamp, metadata, and available catalog context:

```json
{
  "elements": [
    {
      "timestamp": "2026-09-30T10:00:00.000Z",
      "metadata": {
        "contextId": "offer-id",
        "contextType": "offer",
        "changes": [{ "field": "title", "oldValue": "Old title", "newValue": "New title" }]
      }
    }
  ],
  "page": 1,
  "limit": 10,
  "totalCount": 1,
  "totalPages": 1,
  "hasNextPage": false
}
```

Use `page` and `limit` to continue through the list (`page` defaults to 1, `limit` defaults to 10 and is capped at 50). Optional `query`, `type`, and `field` parameters narrow changes by text, change type, or changed field. Missing enrichment does not prevent a change record from being returned; context is best effort.

For cross-catalog change search, use `GET /search/changelog`; for a specific record, use `GET /changelist/{id}`. Both are listed in the [API reference](/docs/api-reference).
