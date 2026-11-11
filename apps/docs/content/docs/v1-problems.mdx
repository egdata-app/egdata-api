---
title: v1 Problem Details
description: Error fields, stable codes, and client recovery steps.
---

v1 errors use `application/problem+json` (RFC 9457). Use the stable `code` for
handling and the `requestId` for support. `type` identifies the problem category;
it is an identifier, not a deployment signal. `title`, `status`, and `detail`
describe the failure. Optional `instance` and `errors` add request and field-level
context. Field issues can include `pointer`, `parameter`, `code`, and `message`.

```json
{
  "type": "https://api.egdata.app/problems/invalid-query",
  "title": "Bad Request",
  "status": 400,
  "detail": "The query parameters are invalid.",
  "code": "INVALID_QUERY",
  "requestId": "req_example",
  "errors": [{ "parameter": "limit", "code": "INVALID", "message": "Expected an integer." }]
}
```

| Category | Examples | Client action |
| --- | --- | --- |
| Invalid request | `INVALID_PATH`, `INVALID_QUERY`, `INVALID_BODY`, `MALFORMED_JSON` | Correct the indicated path, parameter, or JSON body. |
| Cursor | `INVALID_CURSOR` | Restart pagination with the same filters and a fresh cursor; do not edit opaque cursors. |
| Missing/invalid credentials | `MISSING_API_KEY`, `INVALID_API_KEY`, `INVALID_AUTHORIZATION`, `CONFLICTING_CREDENTIALS` | Supply one valid key in `X-API-Key` or `Authorization: Bearer`; remove conflicting credentials. |
| Permission denied | Scope, method, path, IP, origin, expiry, or revocation policy codes | Check the key's permissions and current status. Repeating a denied request does not grant access. |
| Missing resource | `NOT_FOUND`, `OFFER_NOT_FOUND`, `ITEM_NOT_FOUND`, `BUILD_NOT_FOUND`, `SANDBOX_NOT_FOUND`, `MEDIA_NOT_FOUND`, `BUNDLE_NOT_FOUND`, `EVENT_NOT_FOUND`, `PROMOTION_NOT_FOUND`, `SELLER_NOT_FOUND` | Check the identifier and operation in the deployed contract. |
| Unsupported method/content | `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE` | Use the documented method and content type; consult `Allow` where present. |
| Bounded work | `CATALOG_ROOT_TOO_LARGE`, `CATALOG_HYDRATION_TOO_LARGE`, `MANIFEST_NOT_COMPARABLE` | Reduce requested work or choose comparable resources as described by the operation. |
| Quota exhausted | `RATE_LIMITED` | Wait for `Retry-After`; inspect `RateLimit`, `RateLimit-Policy`, and `X-RateLimit-Policy`. |
| Quota uncertain | `QUOTA_UNAVAILABLE` | Retry after the indicated delay. The request was not forwarded without confirmed admission. |
| Upstream/service unavailable | `ORIGIN_UNAVAILABLE`, `SEARCH_UNAVAILABLE`, `NATURAL_LANGUAGE_SEARCH_UNAVAILABLE`, `INTERNAL_ERROR` | Retry with backoff where appropriate; report persistent failures with the request ID. |
| Operator configuration/provenance | `ORIGIN_NOT_CONFIGURED`, `WORKER_AUTH_NOT_CONFIGURED`, `UNTRUSTED_WORKER`, `MISSING_KEY_CONTEXT`, `INVALID_KEY_CONTEXT`, `NATURAL_LANGUAGE_SEARCH_NOT_CONFIGURED` | Contact the operator. Never obtain or send private Worker-to-origin credentials. |

The deployed operation's response schemas and examples are available in the
[developer explorer](https://devs.egdata.app/docs). Response errors still count
as attempted endpoint usage when a known request passed authentication,
permissions, and quota admission. Authentication/permission failures, quota
denials, unknown paths, and preflights are excluded from alert relevance.
