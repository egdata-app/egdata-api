export type V1Exclusion = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  path: string;
  reason: string;
};

/**
 * Legacy routes that intentionally have no v1 operation. Everything not
 * listed here and not documented in the legacy contract must be mapped to a
 * registered v1 operation; scripts/check-openapi.ts enforces that.
 */
export const v1Exclusions: V1Exclusion[] = [
  {
    path: "/",
    reason: "Runtime route inventory for humans; not a data contract.",
  },
  {
    path: "/ui",
    reason: "Swagger UI HTML, not a versioned data operation.",
  },
  {
    path: "/doc",
    reason:
      "Legacy OpenAPI alias, superseded by /open-api.json and /v1/open-api.json.",
  },  {
    path: "/ping",
    reason: "Diagnostic/smoke endpoint; POST has analytics side effects.",
  },
  {
    path: "/search",
    reason:
      "Retired placeholder search route; /v1/search replaces /search/v2/search.",
  },
  {
    path: "/refresh-meilisearch",
    reason: "Search-index maintenance mutation.",
  },
  {
    path: "/refresh/**",
    reason: "Search-index maintenance mutations.",
  },
  {
    path: "/offers/regen/**",
    reason: "Offer regeneration mutation.",
  },
  {
    path: "/offers/regen-by-id/**",
    reason: "Offer regeneration mutation.",
  },
  {
    path: "/offers/bulk-regen",
    reason: "Offer regeneration mutation.",
  },
  {
    path: "/items/regen/**",
    reason: "Item regeneration mutation.",
  },
  {
    path: "/items/bulk-regen",
    reason: "Item regeneration mutation.",
  },
  {
    method: "PATCH",
    path: "/free-games/index",
    reason: "Free-games index maintenance mutation.",
  },
  {
    path: "/donate/**",
    reason: "Private donation key redemption.",
  },
  {
    path: "/auth/**",
    reason: "Browser session and Epic OAuth routes.",
  },
  {
    path: "/users/**",
    reason: "User identity routes.",
  },
  {
    path: "/users-service/**",
    reason: "Service-to-service user routes.",
  },
  {
    path: "/admin/**",
    reason: "Admin-only routes.",
  },
  {
    path: "/launcher/**",
    reason: "Authenticated launcher proxy routes.",
  },
  {
    path: "/push/**",
    reason: "Push notification subscription routes; private or non-catalog.",
  },
  {
    path: "/profiles/me",
    reason: "Authenticated profile route.",
  },
  {
    path: "/profiles/{id}/refresh",
    reason: "Profile refresh mutation.",
  },
  {
    path: "/profiles/{id}/refresh-status",
    reason: "Authenticated refresh status.",
  },
  {
    method: "POST",
    path: "/offers/{id}/reviews",
    reason: "Authenticated review mutation.",
  },
  {
    method: "PATCH",
    path: "/offers/{id}/reviews",
    reason: "Authenticated review mutation.",
  },
  {
    method: "DELETE",
    path: "/offers/{id}/reviews",
    reason: "Authenticated review mutation.",
  },
  {
    path: "/offers/{id}/reviews/permissions",
    reason: "Authenticated review permission route.",
  },
  {
    path: "/offers/{id}/ownership",
    reason: "Authenticated ownership route.",
  },
];
