---
title: Launcher record resolution
description: Resolve parsed Windows build metadata to matching launcher records.
---

After parsing an Epic build manifest locally, use `POST /builds/resolve-launcher-records` to match its metadata to a catalog record. Send metadata only; requests must not contain manifest bytes or local file paths.

```js
const response = await fetch(
  "https://api.egdata.app/builds/resolve-launcher-records",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
const result = await response.json();
```

Send 1 to 100 candidates with unique `requestId` values. Optional `catalogHint` values can narrow a match, but they do not establish a relationship by themselves. Results retain request order and report one of four statuses:

```json
{
  "results": [{ "requestId": "candidate-1", "status": "resolved", "record": { "displayName": "Example Game", "kind": "base-game" } }]
}
```

`resolved` includes normalized launcher metadata. `not-found` means no match was found; `ambiguous` means multiple matches remain; `unsupported` means the known relationship cannot form a complete record. Only use records with status `resolved`; keep other candidates for review rather than guessing a relationship.
