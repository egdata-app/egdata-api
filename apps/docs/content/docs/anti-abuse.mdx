---
title: API sessions and abuse protection
description: Initialize proof-of-work sessions and handle conditional catalog protection.
---

When the API operator enables enforcement, **clean clients can keep requesting
catalog data without a proof-of-work session**. Normal desktop clients do not
need a startup handshake, cookies, browser headers, or any API integration changes.
Only clients whose current behavioral risk exceeds 0.5 are challenged or mitigated.
Existing account authentication requirements still apply.

Browser preflight responses advertise `Access-Control-Max-Age: 600`. HTTPS
`egdata.app` and its subdomains are accepted alongside explicitly configured
integration/development origins; suffix lookalikes are rejected. Browsers cache
preflights per URL, so different GraphQL variables can still require new preflights.
Apollo's CSRF preflight header remains required where applicable.

Fingerprint v2 preserves relative header order while ignoring Apollo client and
CORS request-control headers. OPTIONS requests are never behaviorally scored.
Offer-page hydration and fast typing chains are collapsed for volume/cadence;
deep-only access alone carries no risk weight. Repeated distinct title lookups
can contribute sweep risk even when each request asks only for the first page.
The behavior window remains 60 seconds, capped at 128 events per tracking key.

An operator can also run a short, fingerprint-scoped trial while the default mode
remains observe. Such trials are limited to offer details or catalog search and
expire within 15 minutes; clients outside the selected scope remain unaffected.

Clients that want to recover automatically from a challenge can implement the
handshake below on demand. The session is separate from account authentication:
send the token in `x-egdata-session`, or use the secure `__Host-egdata-session`
cookie with `credentials: 'include'` from `https://egdata.app`. The frontend does
not need to block normal requests on proactive session initialization.

## Initialize a session

1. Send `POST /auth/challenge` with a JSON body of `{}`. The response contains
   `challenge`, `difficulty`, `algorithm: 'SHA-256'`, and `expiresAt` (Unix milliseconds).
2. In a browser Web Worker, find an ASCII nonce matching `[a-zA-Z0-9_-]{1,64}` such
   that SHA-256 of the UTF-8 string `challenge + ':' + nonce` has at least
   `difficulty` leading zero **bits**. At difficulty 16, the first two digest bytes
   must be zero. At difficulty 20, the first two bytes and the top four bits of
   the third byte must be zero. Solve time varies by device and implementation;
   20–40 ms is a tuning target, not a guarantee. Do not run the search on the UI thread.
3. Send `POST /auth/challenge` with `{ "challenge": "...", "nonce": "..." }`.
   Success returns `{ "token": "...", "expiresAt": 1800000600000 }` and sets the cookie.
   An invalid or expired proof returns a new challenge with HTTP 200; solve that challenge.

Challenges expire in 60 seconds. Sessions expire ten minutes after the original
challenge was issued. Reusing a solved challenge yields the same session and does
not extend its lifetime. Keep the same transport/header profile through the
handshake and subsequent requests. A changed transport fingerprint invalidates the
token; a new handshake is needed only if the new profile is challenged. Rotating
just IP addresses or User-Agent values does not change the fingerprint
within the same ASN. A change of ASN changes the composite fingerprint.

Malformed JSON, invalid field types, or request bodies over 4096 bytes return 400
with `error.code: 'INVALID_CHALLENGE'`. A disabled service returns 503 with
`error.code: 'ANTI_ABUSE_DISABLED'`. Never send a challenge string as a session token.

## Protected requests

Protection applies to the roots and all subroutes under `/offers`, `/items`,
`/sellers`, `/builds`, `/changelist`, `/free-games`, `/collections`, `/franchises`,
`/promotions`, `/sandboxes`, `/game-awards`, `/multisearch`, `/sales`, and `/active-sales`, plus `/graphql`,
`/catalog/hydrate`, `/search/v2/search`, and requests containing `page`, `limit`,
`offset`, or `cursor` query parameters. This includes preview images and sitemaps
under protected prefixes. The challenge endpoint and CORS preflights are exempt.
Supporting country, region, tag, featured and search routes contribute behavioral
signals. Account authentication requirements still apply independently.

Catalog search (`GET` and `POST /search/v2/search`) is scored as catalog traffic;
lightweight search metadata remains supporting traffic. Sequential traversal is
grouped by normalized filters, so unrelated queries do not form one page sweep.
The same grouping applies to `/sandboxes/{sandboxId}/offers`. Repeated page
advances less than five seconds apart and sustained large searches contribute to
risk; a single query, large page, or occasional pagination does not trigger PoW.

Enforcement uses the current score:

- **0.0–0.5:** serve normally, with or without a session. A missing, invalid or
  expired PoW token alone does not trigger a challenge.
- **Above 0.5 through 0.8:** require a valid session less than 30 seconds old.
  Otherwise return the challenge response below.
- **Above 0.8:** return the delayed, bodyless response described below, even if
  a valid session is present.

Only a suspicious client with a missing, invalid, or early-expired session receives
**HTTP 200** with:

```json
{"error":{"code":"SESSION_CHALLENGE_REQUIRED","challengeUrl":"/auth/challenge"}}
```

Check this body before interpreting a successful HTTP status as catalog data.
Perform the handshake and retry once, sharing one in-flight handshake across
concurrent requests. Suspicious clients receive difficulty 20 instead of 16 and
their sessions are accepted for less than 30 seconds from challenge issuance.
If the current score falls back to 0.5 or below, requests are allowed without a
session again; a historical risk score stored in an old token does not keep the
client challenged. Confirmed
abuse receives a 3–5 second delay followed by **HTTP 204 No Content**, with no
response body and `X-Egdata-Mitigation: tarpit`. The marker is exposed through
CORS. Clients must handle this as a recoverable mitigation error before REST or
GraphQL parsing: do not cache it as successful data, automatically retry, or start
a PoW handshake. Offer a manual retry after waiting; a successful PoW solve does
not bypass an ongoing high-risk score. Ordinary 204 responses without the marker
are unaffected. The
protection layer does not return 403 or 429. Existing baseline rate limits still
apply and can return 429 with Retry-After, including for clients without trusted
transport signals or sessions. Route authorization and upstream security controls
can also return their own errors.

Normal responses retain their existing cache policies and conditional ETags in
all modes. Challenges, bodyless tarpit responses and synthetic canary lists
are private/no-store and have no ETag. The origin only scores requests that reach
it; Cloudflare cache hits require separate edge-side controls and do not contribute
to origin telemetry. Enforcement does not turn public cached catalog data into
session-restricted content.

## Synthetic records

If the operator also enables canaries, `GET /items` with a valid session includes one extra record with
`synthetic: true`, `namespace: 'egdata-canary'`, an empty `title`, and an opaque
`egcanary_...` ID. Filter these records before rendering, prefetching, hydrating or
following links. They are not catalog products and are not included in `total` or
the requested `limit`. Looking up one through a protected URL path or query
immediately flags the requesting session/fingerprint. Canaries are disabled by default.

## Operational limitations

Fingerprints describe client families, not unique humans. The service combines
them with behavioral evidence; missing client hints alone never confirms abuse.
Missing trusted edge signals disable fingerprint-wide risk sharing, while signed
session continuity still works. Anonymous requests without trusted edge signals
are not assigned a shared fallback fingerprint risk or forced to solve PoW just
because those signals are missing. Transport impersonation, changing ASNs, fresh
profiles and low-rate scraping can evade these heuristics. Cross-instance risk
updates are asynchronous; an instance with a cold cache can admit requests before
Redis telemetry arrives. This is not a synchronous global rate limit.

For Cloudflare analytics, filter response status 204 and exclude OPTIONS (CORS
preflights also use 204). On routes with legitimate 204 responses, status alone
is not sufficient attribution; use the mitigation marker in configured logs.
Deploy frontend support before enabling this backend response contract.
