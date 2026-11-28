---
title: Catalog hydration
description: Incrementally retrieve catalog records and relationships for discovered roots.
---

Use `POST /v1/catalog/hydrate` (`catalog:read` scope) when a client needs the records related to catalog identifiers it has discovered. The endpoint returns newline-delimited JSON (`application/x-ndjson`), with one result line per requested root. Hydration requests count against the project's `bulk` per-minute rate limit and `bulk-period` budget.

```js
const response = await fetch("https://api.egdata.app/v1/catalog/hydrate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.EGDATA_API_KEY,
  },
  body: JSON.stringify({
    schemaVersion: 2,
    identifiers: [
      { type: "asset", namespace: "example-namespace", artifactId: "ExampleGame", platform: "Windows" },
    ],
    knownRoots: [],
    knownRecords: [],
  }),
});

if (!response.ok || !response.body) throw new Error(`Hydration failed: ${response.status}`);
const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
let pending = "";
while (true) {
  const { value, done } = await reader.read();
  pending += value ?? "";
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) if (line) console.log(JSON.parse(line));
  if (done) break;
}
if (pending) console.log(JSON.parse(pending));
```

Send up to 25 unique composite item, platform-qualified asset, or platform-qualified release-app identifiers. The request uses schema version 2 and may include up to 25 `knownRoots` and up to 5,000 `knownRecords` to request only changes. The whole request body is limited to 256 KiB.

Each line reports one root as `resolved`, `unchanged`, `not-found`, or `error`. A resolved result contains record membership and records whose hashes changed. An unchanged result confirms the root is current. A not-found result clears only that root. An error is isolated to that root (`error.code` such as [CATALOG_ROOT_TOO_LARGE](/docs/catalog-root-too-large) or [CATALOG_ROOT_RESOLUTION_FAILED](/docs/catalog-root-resolution-failed)); keep its local data and retry that root independently. Process each line as it arrives so a failed or interrupted stream does not discard earlier results.

```json
{"schemaVersion":2,"rootKey":"asset:example-namespace:examplegame:windows","identifier":{"type":"asset","namespace":"example-namespace","artifactId":"ExampleGame","platform":"Windows"},"hydratedAt":"2026-09-30T10:00:00.000Z","status":"unchanged","graphHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Each output line is bounded to 2 MiB and 500 records. A resolved graph can include linked offers, related items, assets, and normalized release apps. Prices, price history, build history, signed URLs, and image binaries are excluded. See the [API reference](/docs) for the complete request and response schemas.
