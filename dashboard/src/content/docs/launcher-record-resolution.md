---
title: Launcher record resolution
description: Resolve parsed Windows build metadata to matching launcher records.
---

After parsing an Epic build manifest locally, use `POST /v1/builds/resolve-launcher-records` (`builds:read` scope) to match its metadata to a catalog record. Send metadata only; requests must not contain manifest bytes or local file paths. Requests count against the project's `bulk` per-minute rate limit and `bulk-period` budget.

```js
const response = await fetch(
  "https://api.egdata.app/v1/builds/resolve-launcher-records",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
    body: JSON.stringify({
      candidates: [{
        requestId: "candidate-1",
        buildAppName: "ParsedManifestAppName",
        buildVersion: "1.2.3",
        platform: "Windows",
      }],
    }),
  },
);
if (!response.ok) {
  const problem = await response.json().catch(() => null);
  throw new Error(`${problem?.code ?? response.status}: ${problem?.detail ?? ""}`);
}

const { data, meta } = await response.json();
```

Send 1 to 100 candidates with unique `requestId` values. Optional `catalogHint` values can narrow a match, but they do not establish a relationship by themselves. Results retain request order inside `data.results` (with `meta.count`) and report one of four statuses:

```json
{
  "data": {
    "results": [
      {
        "requestId": "candidate-1",
        "status": "resolved",
        "record": { "displayName": "Example Game", "kind": "base-game" }
      }
    ]
  },
  "meta": {
    "count": 1
  }
}
```

`resolved` includes normalized launcher metadata. `not-found` means no match was found; `ambiguous` means multiple matches remain; `unsupported` means the known relationship cannot form a complete record. Only use records with status `resolved`; keep other candidates for review rather than guessing a relationship. See the [API reference](/docs) for the full schema.
