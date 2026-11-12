import { type DocEntry, problemSlug } from "./types";

type ProblemSeed = {
  code: string;
  status: number;
  title: string;
  summary: string;
  fix: string;
  operations?: string[];
};

type ProblemGroup = {
  category: DocEntry["category"];
  problems: ProblemSeed[];
};

/**
 * Stable v1 problem codes emitted by the API gateway and origin. Keep this list
 * in sync with `src/v1/errors.ts`, `src/v1/router.ts`, the v1 route handlers,
 * and `dashboard/worker/v1.ts`.
 */
const groups: ProblemGroup[] = [
  {
    category: "Credentials",
    problems: [
      {
        code: "MISSING_API_KEY",
        status: 401,
        title: "Missing API key",
        summary:
          "The request reached an authenticated v1 operation without an API key in either `X-API-Key` or `Authorization`.",
        fix: "Send exactly one credential: `X-API-Key: <key>` or `Authorization: Bearer <key>`. Create or rotate keys in the developer dashboard.",
      },
      {
        code: "INVALID_API_KEY",
        status: 401,
        title: "Invalid API key",
        summary:
          "The supplied key is unknown, revoked, deactivated, expired, or does not belong to an active project.",
        fix: "Check the key status in **API Keys**, rotate it if it was revoked or expired, and retry with the replacement value. Keys are shown only once when created.",
      },
      {
        code: "INVALID_AUTHORIZATION",
        status: 401,
        title: "Invalid Authorization header",
        summary:
          "The `Authorization` header was present but did not use the `Bearer` scheme.",
        fix: "Use `Authorization: Bearer <key>`, or move the value to `X-API-Key`.",
      },
      {
        code: "CONFLICTING_CREDENTIALS",
        status: 401,
        title: "Conflicting credentials",
        summary:
          "The request supplied different values in `X-API-Key` and `Authorization`.",
        fix: "Send the key in exactly one place. Remove the duplicate header and retry.",
      },
      {
        code: "MISSING_KEY_CONTEXT",
        status: 401,
        title: "Missing key context",
        summary:
          "The origin received a request that claimed to be authenticated but did not carry the Worker's signed key context. Direct origin requests cannot authenticate this way.",
        fix: "Send requests through the documented gateway host (`devs.egdata.app/proxy/v1` or the announced production host). Never call the private origin directly.",
      },
      {
        code: "INVALID_KEY_CONTEXT",
        status: 403,
        title: "Invalid key context",
        summary:
          "The origin rejected the Worker's key context because it was malformed, tampered with, or signed with the wrong secret.",
        fix: "Use the documented gateway host. If the problem persists, the deployment has a configuration error; report it with the `requestId`.",
      },
      {
        code: "UNTRUSTED_WORKER",
        status: 403,
        title: "Untrusted Worker",
        summary:
          "The origin rejected a request whose Worker identity or shared secret did not match the configured value.",
        fix: "This is an operator configuration issue. Report it with the `requestId`; client retries will not help.",
      },
    ],
  },
  {
    category: "Permissions",
    problems: [
      {
        code: "KEY_INACTIVE",
        status: 403,
        title: "API key inactive",
        summary:
          "The API key was revoked or deactivated in the developer dashboard.",
        fix: "Use an active key or create a replacement. Repeating the request does not restore access.",
      },
      {
        code: "KEY_EXPIRED",
        status: 403,
        title: "API key expired",
        summary: "The API key has passed its configured expiry date.",
        fix: "Create a replacement key or extend the key's expiry in the dashboard.",
      },
      {
        code: "METHOD_DENIED",
        status: 403,
        title: "Method not permitted",
        summary:
          "The key's method allowlist does not include this HTTP method.",
        fix: "Update the key's permitted methods, or use an allowed method.",
      },
      {
        code: "IP_DENIED",
        status: 403,
        title: "IP address not permitted",
        summary:
          "The caller's IP address is outside the key's IP or CIDR allowlist.",
        fix: "Add the egress IP or CIDR range used by your service, or remove the IP restriction if appropriate.",
      },
      {
        code: "ORIGIN_DENIED",
        status: 403,
        title: "Origin not permitted",
        summary:
          "The browser `Origin` header is not in the key's origin allowlist.",
        fix: "Add the exact scheme and host that your browser client uses, or make the request server-side without a browser `Origin`.",
      },
      {
        code: "PATH_DENIED",
        status: 403,
        title: "Path not permitted",
        summary:
          "The requested `/v1` path is outside the key's path restrictions.",
        fix: "Grant the operation's path pattern to the key. Legacy grants such as `/offers/*` do not automatically grant `/v1/offers`.",
      },
      {
        code: "SCOPE_DENIED",
        status: 403,
        title: "Scope not permitted",
        summary:
          "The key does not hold the permission scope required by the operation.",
        fix: "Grant the missing scope shown in the problem detail or in the operation's `x-egdata-scope` metadata.",
      },
    ],
  },
  {
    category: "Request validation",
    problems: [
      {
        code: "INVALID_PATH",
        status: 400,
        title: "Invalid request path",
        summary:
          "The path is not a valid versioned API path. Encoded separators and dot segments are rejected before routing.",
        fix: "Use a documented `/v1/...` path. Encode identifier segments as single path segments and do not include `..` or encoded slashes.",
      },
      {
        code: "INVALID_QUERY",
        status: 400,
        title: "Invalid query parameters",
        summary:
          "One or more query parameters could not be parsed or are outside their allowed range.",
        fix: "Read the `errors` array for the exact parameter, pointer, and message, then correct the value.",
      },
      {
        code: "INVALID_BODY",
        status: 400,
        title: "Invalid request body",
        summary:
          "The JSON body does not match the operation's documented schema.",
        fix: "Compare the body with the operation's request schema in the API reference and fix the fields reported in `errors`.",
      },
      {
        code: "INVALID_PARAMETER",
        status: 400,
        title: "Invalid parameter",
        summary:
          "A required parameter is present but has an unsupported value.",
        fix: "Use the documented type, format, or enum value for the parameter named in the problem.",
      },
      {
        code: "MISSING_PARAMETER",
        status: 400,
        title: "Missing parameter",
        summary: "A required query or path parameter was omitted.",
        fix: "Send the parameter named in the problem. Required parameters are marked in the API reference.",
      },
      {
        code: "MALFORMED_JSON",
        status: 400,
        title: "Malformed JSON",
        summary:
          "The request declared a JSON body but the payload could not be parsed.",
        fix: "Validate the JSON before sending and make sure `Content-Type: application/json` matches the body.",
      },
      {
        code: "INVALID_COUNTRY",
        status: 400,
        title: "Invalid country",
        summary:
          "The `country` parameter is not a supported two-letter country code.",
        fix: "Send an ISO 3166-1 alpha-2 country code such as `US`, `GB`, or `ES`.",
      },
      {
        code: "INVALID_LOCALE",
        status: 400,
        title: "Invalid locale",
        summary: "The `locale` parameter is not a recognized locale.",
        fix: "Use a supported locale such as `en-US`, `en-GB`, or `es-ES`.",
      },
      {
        code: "INVALID_LIMIT",
        status: 400,
        title: "Invalid limit",
        summary:
          "The requested page size is not a positive integer within the operation's maximum.",
        fix: "Use an integer between 1 and the maximum documented by the operation.",
      },
    ],
  },
  {
    category: "Pagination",
    problems: [
      {
        code: "INVALID_CURSOR",
        status: 400,
        title: "Invalid cursor",
        summary: "The cursor is not a valid opaque value for this operation.",
        fix: "Restart pagination with the original filters and a fresh cursor. Do not edit, decode, or reuse a cursor across queries.",
      },
      {
        code: "EXPIRED_CURSOR",
        status: 400,
        title: "Expired cursor",
        summary: "The cursor is older than the operation's cursor lifetime.",
        fix: "Restart the listing from the first page and continue with the new cursor.",
      },
      {
        code: "CURSOR_MISMATCH",
        status: 400,
        title: "Cursor does not match query",
        summary:
          "The cursor was issued for different filters, ordering, or a different operation.",
        fix: "Use the cursor with exactly the same filters and sort order that produced it.",
      },
      {
        code: "CURSOR_NOT_CONFIGURED",
        status: 503,
        title: "Cursor signing not configured",
        summary:
          "The deployment cannot issue or verify pagination cursors because the cursor secret is missing.",
        fix: "This is an operator configuration issue. Retry later and report it with the `requestId` if it persists.",
      },
    ],
  },
  {
    category: "Request validation",
    problems: [
      {
        code: "INVALID_BUILD_ID",
        status: 400,
        title: "Invalid build identifier",
        summary:
          "A build identifier is not in the format expected by the operation.",
        fix: "Use the build ID exactly as returned by a build listing or build detail response.",
      },
      {
        code: "INVALID_REGION",
        status: 400,
        title: "Invalid region",
        summary: "The requested pricing region is not supported.",
        fix: "Use a region returned by `GET /v1/regions`, or send a supported `country` instead.",
      },
      {
        code: "INVALID_TIMESTAMP",
        status: 400,
        title: "Invalid timestamp",
        summary:
          "A timestamp parameter could not be parsed as an ISO 8601 date-time.",
        fix: "Send an ISO 8601 timestamp, for example `2026-11-12T00:00:00.000Z`.",
      },
      {
        code: "INVALID_WEEK",
        status: 400,
        title: "Invalid collection week",
        summary:
          "The collection week is not in the expected `YYYY-MM-DD` format or is outside the supported range.",
        fix: "Send the week date in `YYYY-MM-DD` form using a week boundary returned by the collections endpoint.",
      },
      {
        code: "BULK_LIMIT_EXCEEDED",
        status: 400,
        title: "Bulk request too large",
        summary:
          "A bulk operation received more identifiers than it accepts in one request.",
        fix: "Split the identifiers into smaller batches and retry. The maximum is reported in `errors[].message`.",
      },
      {
        code: "INCOMPATIBLE_BUILDS",
        status: 400,
        title: "Incompatible builds",
        summary:
          "A build comparison requires builds from the same app or stream and the supplied pair is not comparable.",
        fix: "Choose builds from the same app and stream, then retry the comparison.",
      },
      {
        code: "CATALOG_HYDRATION_INVALID_REQUEST",
        status: 400,
        title: "Invalid catalog hydration request",
        summary:
          "The catalog hydration body is not valid JSON or does not match the documented request shape.",
        fix: "Send a JSON object with a `roots` array of catalog identifiers. Each root is resolved independently.",
      },
    ],
  },
  {
    category: "Payload and protocol",
    problems: [
      {
        code: "CATALOG_HYDRATION_TOO_LARGE",
        status: 413,
        title: "Catalog hydration request too large",
        summary:
          "The catalog hydration body exceeds the 256 KiB request limit.",
        fix: "Reduce the number of roots or split the hydration request into smaller batches.",
      },
      {
        code: "MANIFEST_NOT_COMPARABLE",
        status: 409,
        title: "Manifests not comparable",
        summary:
          "Two build manifests use different apps, streams, or manifest formats and cannot be compared directly.",
        fix: "Compare manifests from the same app and stream, or use a build comparison operation that supports the pair.",
      },
      {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
        title: "Method not allowed",
        summary:
          "The path exists but does not support the requested HTTP method.",
        fix: "Read the `Allow` response header and use one of the listed methods.",
      },
      {
        code: "UNSUPPORTED_MEDIA_TYPE",
        status: 415,
        title: "Unsupported media type",
        summary:
          "The request body's content type is not accepted by the operation.",
        fix: "Send `Content-Type: application/json` for JSON operations and match the documented request format.",
      },
    ],
  },
  {
    category: "Resource lookup",
    problems: [
      {
        code: "OFFER_NOT_FOUND",
        status: 404,
        title: "Offer not found",
        summary:
          "No offer matches the supplied offer ID, slug, or catalog identifier.",
        fix: "Resolve the offer through search first and use the returned offer ID. Offer IDs are opaque strings.",
        operations: ["getOffer", "getOfferBySlug"],
      },
      {
        code: "ITEM_NOT_FOUND",
        status: 404,
        title: "Item not found",
        summary: "No store item matches the supplied item identifier.",
        fix: "Use an item ID returned by an offer's items, item listing, or search response.",
        operations: ["getItem"],
      },
      {
        code: "BUILD_NOT_FOUND",
        status: 404,
        title: "Build not found",
        summary: "No build matches the supplied build identifier.",
        fix: "List builds for the app first and use a build ID from that response.",
      },
      {
        code: "SANDBOX_NOT_FOUND",
        status: 404,
        title: "Sandbox not found",
        summary:
          "No sandbox matches the supplied sandbox identifier, or the offer has no associated sandbox.",
        fix: "Check the sandbox ID and the operation's expected identifier type.",
      },
      {
        code: "MEDIA_NOT_FOUND",
        status: 404,
        title: "Media not found",
        summary: "No media records are stored for this offer.",
        fix: "Request the offer's media from an operation that supports the data available for that offer.",
      },
      {
        code: "BUNDLE_NOT_FOUND",
        status: 404,
        title: "Bundle not found",
        summary:
          "The offer is not a bundle, or no bundle contents are stored for it.",
        fix: "Verify the offer type before requesting bundle contents.",
      },
      {
        code: "EVENT_NOT_FOUND",
        status: 404,
        title: "Event not found",
        summary: "No active event matches the supplied event ID.",
        fix: "Use an event ID from a current event or promotion listing.",
      },
      {
        code: "PROMOTION_NOT_FOUND",
        status: 404,
        title: "Promotion not found",
        summary: "No promotion matches the supplied promotion identifier.",
        fix: "List promotions first and use a promotion ID from the response.",
      },
      {
        code: "SELLER_NOT_FOUND",
        status: 404,
        title: "Seller not found",
        summary: "No seller matches the supplied seller identifier.",
        fix: "Resolve the seller through seller search and use the returned seller ID.",
      },
      {
        code: "ASSET_NOT_FOUND",
        status: 404,
        title: "Asset not found",
        summary: "No asset matches the supplied asset identifier.",
        fix: "Use an asset ID from an item or offer asset listing.",
      },
      {
        code: "BASE_GAME_NOT_FOUND",
        status: 404,
        title: "Base game not found",
        summary:
          "The sandbox or offer does not expose a base game relationship.",
        fix: "Verify the offer type and try an operation that reads the sandbox directly.",
      },
      {
        code: "CHANGELOG_NOT_FOUND",
        status: 404,
        title: "Changelog not found",
        summary:
          "No changelog entry exists for the supplied identifier or time range.",
        fix: "Widen the requested time range or use a current changelog listing.",
      },
      {
        code: "COLLECTION_NOT_FOUND",
        status: 404,
        title: "Collection not found",
        summary:
          "No collection matches the supplied collection identifier or week.",
        fix: "List collection weeks first and use a published collection identifier.",
      },
      {
        code: "COLLECTION_ENTRY_NOT_FOUND",
        status: 404,
        title: "Collection entry not found",
        summary:
          "The collection exists but does not contain the requested offer or entry.",
        fix: "Load the collection first and pick an entry from its returned items.",
      },
      {
        code: "FRANCHISE_NOT_FOUND",
        status: 404,
        title: "Franchise not found",
        summary: "No franchise matches the supplied franchise identifier.",
        fix: "Use a franchise ID returned by an offer's franchise relationship.",
      },
      {
        code: "HLTB_NOT_FOUND",
        status: 404,
        title: "HowLongToBeat data not found",
        summary: "No HowLongToBeat record is stored for this offer.",
        fix: "Request the offer without this optional relationship, or treat the absence as unavailable data.",
      },
      {
        code: "IGDB_NOT_FOUND",
        status: 404,
        title: "IGDB data not found",
        summary: "No IGDB record is linked to this offer.",
        fix: "Treat the optional IGDB relationship as unavailable for this offer.",
      },
      {
        code: "ITEM_OFFER_NOT_FOUND",
        status: 404,
        title: "Item offer not found",
        summary: "No offer is linked to the supplied item.",
        fix: "Use the item's offer relationship from a listing that includes linked offers.",
      },
      {
        code: "MAPPINGS_NOT_FOUND",
        status: 404,
        title: "Offer mappings not found",
        summary: "No catalog mapping records are stored for this offer.",
        fix: "Treat mappings as optional data and fall back to the offer's catalog identifiers.",
      },
      {
        code: "PRICE_NOT_FOUND",
        status: 404,
        title: "Price not found",
        summary:
          "No price record exists for the offer in the requested region or country.",
        fix: "Try another supported country or region, and verify the offer is available in that market.",
      },
      {
        code: "PRICE_FAIRNESS_NOT_FOUND",
        status: 404,
        title: "Price fairness data not found",
        summary: "No regional price fairness record is stored for this offer.",
        fix: "Treat price fairness as optional data for this offer.",
      },
      {
        code: "PRODUCT_NOT_FOUND",
        status: 404,
        title: "Product not found",
        summary: "No Epic product record is linked to this offer.",
        fix: "Treat the product relationship as unavailable and use the offer's own identifiers.",
      },
      {
        code: "PROFILE_NOT_FOUND",
        status: 404,
        title: "Profile not found",
        summary: "No public profile matches the supplied account identifier.",
        fix: "Use an Epic account ID returned by a profile search or the GraphQL profile resolver.",
      },
      {
        code: "PROFILE_ACHIEVEMENTS_NOT_FOUND",
        status: 404,
        title: "Profile achievements not found",
        summary: "No achievements are available for this profile.",
        fix: "Treat achievements as optional data for the profile.",
      },
      {
        code: "PROFILE_SANDBOX_ACHIEVEMENTS_NOT_FOUND",
        status: 404,
        title: "Profile sandbox achievements not found",
        summary:
          "No achievements are available for this profile in the requested sandbox.",
        fix: "Verify the sandbox ID or treat the relationship as unavailable.",
      },
      {
        code: "PROMOTION_COVER_NOT_FOUND",
        status: 404,
        title: "Promotion cover not found",
        summary: "No cover image is stored for this promotion.",
        fix: "Render a fallback image and treat the cover as optional.",
      },
      {
        code: "RATINGS_NOT_FOUND",
        status: 404,
        title: "Ratings not found",
        summary: "No ratings summary is stored for this offer.",
        fix: "Treat ratings as optional data for this offer.",
      },
      {
        code: "REQUIREMENTS_NOT_FOUND",
        status: 404,
        title: "Requirements not found",
        summary: "No system requirements are stored for this offer.",
        fix: "Treat system requirements as optional data for this offer.",
      },
      {
        code: "SEARCH_QUERY_NOT_FOUND",
        status: 404,
        title: "Saved search not found",
        summary: "No saved search matches the supplied query identifier.",
        fix: "Use a saved search ID returned by the search query listing.",
      },
      {
        code: "AGE_RATING_NOT_FOUND",
        status: 404,
        title: "Age rating not found",
        summary:
          "No age rating record is stored for this offer in the requested region.",
        fix: "Treat age ratings as optional data, or try another supported country.",
      },
      {
        code: "NOT_FOUND",
        status: 404,
        title: "Not found",
        summary: "No version 1 operation exists at the requested path.",
        fix: "Check the path in the API reference. Use the `/v1` prefix and the documented method.",
      },
    ],
  },
  {
    category: "Quota and service",
    problems: [
      {
        code: "RATE_LIMITED",
        status: 429,
        title: "Rate limited",
        summary:
          "The project exhausted its global 60-second or per-operation quota for the current UTC-aligned window.",
        fix: "Wait for `Retry-After` seconds before retrying. Inspect `RateLimit`, `RateLimit-Policy`, and `X-RateLimit-Policy` to see which policy was exhausted.",
      },
      {
        code: "MONTHLY_QUOTA_EXCEEDED",
        status: 429,
        title: "Monthly quota exceeded",
        summary:
          "The account exhausted its shared 100,000-request monthly free-tier allowance across all free projects, API keys, and console sessions.",
        fix: "Wait until the next calendar month reset at 00:00 UTC (`Retry-After` seconds), or request a Pro/Enterprise tier upgrade in **Rate Limits**.",
      },
      {
        code: "QUOTA_UNAVAILABLE",
        status: 503,
        title: "Quota decision unavailable",
        summary:
          "The quota service could not confirm admission, so the request was not forwarded.",
        fix: "Retry after the `Retry-After` delay. Requests that receive this response do not consume quota.",
      },
      {
        code: "INTERNAL_ERROR",
        status: 500,
        title: "Internal error",
        summary: "An unexpected error occurred while processing the request.",
        fix: "Retry with backoff. If the failure persists, report the `requestId` to support.",
      },
      {
        code: "ORIGIN_UNAVAILABLE",
        status: 502,
        title: "API origin unavailable",
        summary: "The gateway could not reach the API origin.",
        fix: "Retry with exponential backoff and report persistent failures with the `requestId`.",
      },
      {
        code: "ORIGIN_NOT_CONFIGURED",
        status: 503,
        title: "API origin not configured",
        summary: "The gateway is missing its upstream origin configuration.",
        fix: "This is an operator configuration issue. Retry later and report it if it persists.",
      },
      {
        code: "SEARCH_UNAVAILABLE",
        status: 503,
        title: "Search unavailable",
        summary: "The search backend is temporarily unavailable.",
        fix: "Retry with backoff. Use a non-search operation if the data can be resolved by identifier.",
      },
      {
        code: "NATURAL_LANGUAGE_SEARCH_UNAVAILABLE",
        status: 502,
        title: "Natural-language search unavailable",
        summary:
          "The natural-language provider could not be reached or returned an unusable response.",
        fix: "Retry with backoff, or fall back to structured search filters.",
      },
      {
        code: "NATURAL_LANGUAGE_SEARCH_NOT_CONFIGURED",
        status: 503,
        title: "Natural-language search not configured",
        summary:
          "The deployment is missing the natural-language provider configuration.",
        fix: "Use structured search instead. Report the problem if the feature is expected to be available.",
      },
      {
        code: "WORKER_AUTH_NOT_CONFIGURED",
        status: 503,
        title: "Worker authentication not configured",
        summary:
          "The origin cannot verify Worker requests because the shared secret is missing.",
        fix: "This is an operator configuration issue. Client retries will not help until it is fixed.",
      },
    ],
  },
];

export const problemDocs: DocEntry[] = groups.flatMap((group) =>
  group.problems.map((problem) => ({
    slug: problemSlug(problem.code),
    kind: "problem" as const,
    title: problem.title,
    description: `${problem.code} is returned with HTTP ${problem.status}. ${problem.summary}`,
    category: group.category,
    code: problem.code,
    status: problem.status,
    summary: problem.summary,
    fix: problem.fix,
    operations: problem.operations,
    related: ["v1-problems", "problems"],
  })),
);

export const streamResultDocs: DocEntry[] = [
  {
    slug: "catalog-root-too-large",
    kind: "stream",
    title: "Catalog root too large",
    description:
      "A catalog hydration root exceeded the per-root limit and returned an error line.",
    category: "Stream results",
    code: "CATALOG_ROOT_TOO_LARGE",
    summary:
      "The root's resolved graph is larger than the catalog hydration limit. Other roots in the same request can still succeed.",
    fix: "Reduce the scope of the root, resolve its relationships in separate requests, or choose a narrower catalog identifier.",
    related: ["catalog-hydration", "problems"],
  },
  {
    slug: "catalog-root-resolution-failed",
    kind: "stream",
    title: "Catalog root resolution failed",
    description:
      "A catalog hydration root could not be resolved and returned an error line.",
    category: "Stream results",
    code: "CATALOG_ROOT_RESOLUTION_FAILED",
    summary:
      "The root identifier could not be hydrated. The rest of the newline-delimited response is still returned.",
    fix: "Verify the identifier and retry that root in a separate request. Report the root and request ID if it keeps failing.",
    related: ["catalog-hydration", "problems"],
  },
];

export const fieldIssueDocs: DocEntry[] = [
  {
    slug: "invalid",
    kind: "issue",
    title: "Invalid field value",
    description:
      "A field-level issue code used when one value in a structured request is invalid.",
    category: "Field issues",
    code: "INVALID",
    summary:
      "The request was rejected because a specific parameter or body field has an invalid type, format, or value.",
    fix: "Read `errors[].pointer` or `errors[].parameter` to find the field, then correct the value to match the documented schema.",
    related: ["v1-problems", "field-issues"],
  },
  {
    slug: "unknown-field",
    kind: "issue",
    title: "Unknown field",
    description:
      "A field-level issue code used when a request body contains an unsupported property.",
    category: "Field issues",
    code: "UNKNOWN_FIELD",
    summary:
      "The request included a field that the operation does not accept. Unknown fields are rejected instead of being ignored.",
    fix: "Remove the field named by `errors[].pointer` or `errors[].parameter`, or move it to an operation that documents it.",
    related: ["v1-problems", "field-issues"],
  },
  {
    slug: "too-many",
    kind: "issue",
    title: "Too many values",
    description:
      "A field-level issue code used when a list or selection exceeds the operation's limit.",
    category: "Field issues",
    code: "TOO_MANY",
    summary:
      "A parameter or body field contains more values than the operation accepts.",
    fix: "Reduce the number of values to the maximum reported in `errors[].message`, or split the work into multiple requests.",
    related: ["v1-problems", "field-issues"],
  },
  {
    slug: "too-many-items",
    kind: "issue",
    title: "Too many items",
    description:
      "A field-level issue code used by bulk operations that receive too many identifiers.",
    category: "Field issues",
    code: "TOO_MANY_ITEMS",
    summary:
      "The `items` array in a bulk request contains more identifiers than the operation accepts.",
    fix: "Split the identifiers into smaller batches and retry. The maximum appears in `errors[].message`.",
    related: ["v1-problems", "field-issues", "bulk-limit-exceeded"],
  },
];
