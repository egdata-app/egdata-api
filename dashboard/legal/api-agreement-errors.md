# Agreement and access errors: proposed API contract

Status: future mandatory-update design specification, not deployed. Example dates and
versions below are illustrative, not an announced policy release. Publish this
contract in the public API documentation and OpenAPI when implementing the gate.

## Initial portal-only implementation

The current local implementation gates protected dashboard routes and existing/new
console sessions after explicit publication. It requires verified email before
terms acceptance. **Existing external API keys keep working**, including after an
incomplete dashboard visit. The deadline/error-metadata model below describes the
later universal-enforcement phase, not an active API-key terms requirement.

Current account routes use `/_dashboard/api/account`: GET status, POST `/email`,
POST `/email/verify`, POST `/agreements`, GET `/receipts`, GET `/receipt`,
GET `/export`, and DELETE account. They
remain reachable with an authenticated session during onboarding. Acceptance
requires `{ revision, version, sha256, accepted: true }`; email verification requires
`{ token }`. Stale acceptance returns `409 AGREEMENT_CHANGED`; unverified contact
returns `403 EMAIL_VERIFICATION_REQUIRED`. The SPA reloads authoritative status
after either error. The initial 409 envelope has code/message, not all future
metadata fields specified below.

Protected dashboard calls return `403 AGREEMENT_REQUIRED` with `reviewUrl`,
`requirementRevision`, and terms-only `requiredDocuments`, or
`403 EMAIL_VERIFICATION_REQUIRED`. Console calls use Problem Details with the same
codes and direct users to the portal. Public documents and privacy information
remain available without agreement. No privacy acknowledgement is required.

Account closure is independent: old API keys return `401 INVALID_API_KEY`, including
warm caches. Credential/account-store failures return uncacheable
`503 ACCOUNT_STATUS_UNAVAILABLE`, `Retry-After: 30`, before quota/upstream access;
legacy uses its error envelope and v1 uses Problem Details. HEAD has no body for
that error. Broader `ACCESS_SUSPENDED`/scheduled material-update workflows below
remain planned. The complete implemented account, privacy-case and notification
contract is `openapi/egdata.dashboard.openapi.json`. See
[initial rollout operations](initial-rollout.md).

## Status codes and recovery

| HTTP status | Machine code | Meaning | Client action |
| --- | --- | --- | --- |
| 403 | `AGREEMENT_REQUIRED` | Authenticated owner has not accepted the currently required terms edition | Pause automated work and direct the owner to `reviewUrl` |
| 403 | `ACCESS_SUSPENDED` | An independent global, account, project, or operation restriction blocks access | Pause affected work and contact support; acceptance does not lift the restriction |
| 409 | `AGREEMENT_CHANGED` | The agreement submission references a stale requirement revision or document version/hash | Reload status and documents; obtain a fresh explicit action before submitting |
| 503 | `LEGAL_STATUS_UNAVAILABLE` | The server cannot reliably determine legal-access status | Retry with bounded exponential backoff and jitter; respect `Retry-After` if supplied |

These checks apply after authentication; existing missing/invalid/revoked-key
errors retain their authentication semantics. A 403 agreement pause is neither
an expired key nor a 429 quota failure. Do not rotate keys or create accounts to
recover. Newly issued keys for the same owner are subject to the same requirement.

If both a suspension and an agreement requirement apply, return
`ACCESS_SUSPENDED`; the owner can still review documents in the portal. If status
cannot be determined reliably, return 503 rather than invent a 403 decision.
`AGREEMENT_CHANGED` applies to the acceptance endpoint, not ordinary data calls.

Keep `AGREEMENT_REQUIRED` as the single chosen code for missing terms acceptance;
do not introduce `TERMS_ACCEPTANCE_REQUIRED` as an alias. Privacy publication,
unread notices, and declined optional consent never produce this error.

## Publication, notice, and cutoff

Publishing a document does not itself change API eligibility. Initial access
requires terms acceptance. An ordinary material terms update has an announced
effective time following at least 30 calendar days' advance notice. Before then,
existing accounts that accepted the current edition continue to receive normal
API responses, even if they have not yet accepted the upcoming edition. At the
effective time, accounts missing the newly required acceptance receive 403.
Urgent material updates may have an explicitly justified shorter deadline.

Editorial terms versions retain the same substantive edition and do not require
renewed acceptance. The server maps exact version evidence to an edition; clients
must not compare version strings or assume “latest version not accepted” means
access is blocked. Privacy notices stay separate and informational. Independent
suspensions may apply at any time justified by their own rules and scope.

The portal exposes current and upcoming requirements and permits early acceptance.
During notice, show a non-blocking banner rather than the blocking review screen.
The account's current edition remains required until the cutoff; early acceptance
does not bring the new duties into effect early. Notifications and reminders do
not count as acceptance. Their delivery workflow is defined in the
[implementation plan](README.md#5-publication-and-emergency-operation).

## Shared agreement metadata

Both 403 `AGREEMENT_REQUIRED` and 409 `AGREEMENT_CHANGED` carry:

| Field | Type | Meaning |
| --- | --- | --- |
| `requirementRevision` | String | Opaque current server revision; compare for equality, never infer ordering |
| `effectiveAt` | String | RFC 3339 UTC effective time of the referenced requirement |
| `reviewUrl` | String | Fixed first-party review URL: `https://devs.egdata.app/profile/agreements` |
| `requiredDocuments` | Array | Terms documents that can satisfy the referenced requirement still needing acceptance by this owner |

For this initial contract, `requiredDocuments` has one entry when acceptance is
missing: `kind: "terms"`, `version` (opaque string), `action: "accept"`, and
`url` (absolute first-party version-archive URL). It identifies the current
presentation version within the required terms edition. Prior acceptance of an
equivalent editorial version in that edition also satisfies the requirement;
such an account must not receive this error. Privacy entries and `acknowledge`
actions are not permitted in blocking metadata.

A stale-submission response may have an empty array if another tab already
completed the current requirement; refresh server status to confirm. The version
used for the actual acceptance receipt must always be the exact version submitted
and validated, never a newer equivalent revision substituted by the server.

The portal fetches the authoritative full text and hashes before an explicit
submission. Error metadata alone is not evidence that a person saw or agreed
to a document. Never send an acceptance POST automatically in response to a 403.

Populate metadata from the same authoritative decision snapshot. Do not reflect
caller-supplied URLs or include account IDs, contact details, credentials,
acceptance history, or confidential suspension reasons. Never put a key in a
review URL. The revision also covers upcoming-release changes relevant to an
acceptance submission; a stale early-acceptance form must refresh the available
current and upcoming releases before asking the user to act again.

## v1 API and interactive console

Return RFC 9457 Problem Details with `Content-Type: application/problem+json`.
Example after a material terms-update deadline:

```json
{
  "type": "https://api.egdata.app/problems/agreement-required",
  "title": "Forbidden",
  "status": 403,
  "detail": "The account owner must accept the required terms before API access can continue.",
  "instance": "/v1/offers",
  "code": "AGREEMENT_REQUIRED",
  "requestId": "req_example",
  "requirementRevision": "legal_example_2",
  "effectiveAt": "2026-12-01T00:00:00Z",
  "reviewUrl": "https://devs.egdata.app/profile/agreements",
  "requiredDocuments": [
    {
      "kind": "terms",
      "version": "2.0",
      "action": "accept",
      "url": "https://devs.egdata.app/terms/2.0"
    }
  ]
}
```

Use the existing request-ID convention and keep `instance` to the request path,
without query parameters. Other errors use the same Problem Details base, with
their corresponding status/code and lowercase hyphenated problem-type suffix.
Only agreement-required/changed errors carry the shared agreement metadata.
For `ACCESS_SUSPENDED`, include `supportUrl: "mailto:contact@egdata.app"` with a
generic explanation. A 503 must not fabricate a required version or imply the
user has failed to agree.

## Legacy API and private dashboard endpoints

Keep their established JSON error envelope and `application/json` content type.
Put shared metadata inside `error`, alongside `code` and `message`. The same
terms pause in the legacy/dashboard envelope is:

```json
{
  "error": {
    "code": "AGREEMENT_REQUIRED",
    "message": "The account owner must accept the required terms before API access can continue.",
    "requirementRevision": "legal_example_2",
    "effectiveAt": "2026-12-01T00:00:00Z",
    "reviewUrl": "https://devs.egdata.app/profile/agreements",
    "requiredDocuments": [
      {
        "kind": "terms",
        "version": "2.0",
        "action": "accept",
        "url": "https://devs.egdata.app/terms/2.0"
      }
    ]
  }
}
```

The private acceptance endpoint returns 409 with `error.code` set to
`AGREEMENT_CHANGED` and the same metadata fields. For suspension, put
`supportUrl` inside `error`. Preserve any existing request-ID headers; the new
legal gate must not require changing unrelated legacy error responses.

## Headers, HEAD requests, and caches

All legal-access failures are uncacheable:

```http
Cache-Control: private, no-store
CDN-Cache-Control: no-store
Cloudflare-CDN-Cache-Control: no-store
```

For every error in the status table, include `X-Egdata-Error-Code` with its
machine code. For agreement-required/changed errors, also include:

```http
Link: <https://devs.egdata.app/profile/agreements>; rel="help"
```

HEAD responses contain the same status and relevant headers but no body.
The error-code header and help link therefore allow HEAD clients to identify
the pause. Preserve the gateway's existing CORS policy and expose
`X-Egdata-Error-Code` and `Link`, alongside existing exposed headers, for allowed
browser responses. Do not add cookies or relax authentication to handle the gate.

Check legal access before any cached 200/304 response or upstream forwarding.
Neither a warm key cache nor a conditional `If-None-Match` request bypasses the
check. Do not send `Retry-After` for an agreement pause: user action, rather
than waiting a fixed duration, resolves it.

## Recommended integration behavior

1. Inspect the machine code, not the wording of `message` or `detail`.
2. On `AGREEMENT_REQUIRED`, stop recurring requests for the affected integration
   and notify its operator once, including the first-party review link. Deduplicate
   notifications by requirement revision rather than emailing on every failure.
3. The account owner signs in and expressly accepts the required terms in the portal.
   Applications must not impersonate that action or ask the owner to share a key.
4. Resume through an explicit operator action or a low-frequency, bounded probe
   after the operator reports completion. Do not busy-loop or rotate credentials.
5. On `ACCESS_SUSPENDED`, contact support. On 503, use transient-error handling.
   On 409 from an agreement form, refresh and present the current documents.

Clients should tolerate unknown additional JSON fields. Authenticated portal
status, not a previously cached error response, determines whether access can
resume. Revoked or expired keys still require their normal recovery procedure.
The portal must keep narrowly scoped credential-status/revocation and contact
repair/recovery controls available during an agreement pause, with appropriate
identity checks. Replacement-key creation requires current eligibility and does
not override an independent restriction or quota.

An agreement pause or account closure alone does not require deleting existing
bounded, lawfully obtained caches. Continued use follows the terms applicable
when obtained, including attribution and extraction limits; it grants no API
refresh access. A specific lawful stop-use/removal obligation may still apply.
