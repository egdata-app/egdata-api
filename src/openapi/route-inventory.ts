import type { Method, Visibility } from "./types.js";

export type RouteClassification = {
  method?: Method | "*";
  path: string;
  visibility: Visibility | "public-deferred" | "non-json";
  reason: string;
};

export const routeClassifications: RouteClassification[] = [
  {
    path: "/",
    visibility: "diagnostic",
    reason: "Runtime route inventory for humans and smoke checks.",
  },
  {
    path: "/open-api.json",
    visibility: "diagnostic",
    reason: "Canonical OpenAPI document endpoint.",
  },
  {
    path: "/doc",
    visibility: "diagnostic",
    reason: "Compatibility alias for the OpenAPI document.",
  },
  {
    path: "/ui",
    visibility: "diagnostic",
    reason: "Swagger UI route.",
  },
  {
    path: "/graphql",
    visibility: "public-deferred",
    reason:
      "GraphQL documentation is intentionally deferred until the REST contract is stable.",
  },
  {
    path: "/ping",
    visibility: "diagnostic",
    reason: "Telemetry/smoke endpoint; POST has analytics side effects.",
  },
  {
    path: "/search",
    visibility: "diagnostic",
    reason:
      "Legacy placeholder GET and legacy POST search; v2 is the documented public search API.",
  },
  {
    path: "/multisearch",
    visibility: "diagnostic",
    reason: "Placeholder root route; concrete multisearch routes are deferred.",
  },
  {
    path: "/robots.txt",
    visibility: "non-json",
    reason: "Robots response is text/plain.",
  },
  {
    path: "/sitemap.xml",
    visibility: "non-json",
    reason: "Sitemap response is application/xml.",
  },
  {
    path: "/items-sitemap.xml",
    visibility: "non-json",
    reason: "Sitemap response is application/xml.",
  },
  {
    path: "/promotions-sitemap.xml",
    visibility: "non-json",
    reason: "Sitemap response is application/xml.",
  },
  {
    path: "/items/sitemap.xml",
    visibility: "non-json",
    reason: "Sitemap response is application/xml.",
  },
  {
    path: "/profiles/sitemap.xml",
    visibility: "non-json",
    reason: "Sitemap response is application/xml.",
  },
  {
    path: "/sandboxes/sitemap.xml",
    visibility: "non-json",
    reason: "Sitemap response is application/xml.",
  },
  {
    path: "/free-games/og",
    visibility: "non-json",
    reason: "Generated OG image response.",
  },
  {
    path: "/game-awards/og",
    visibility: "non-json",
    reason: "Generated OG image response.",
  },
  {
    path: "/collections/{slug}/{week}/og",
    visibility: "non-json",
    reason: "Generated OG image response.",
  },
  {
    path: "/accounts/**",
    visibility: "private",
    reason: "Authenticated account routes.",
  },
  {
    path: "/accounts",
    visibility: "private",
    reason: "Authenticated account routes.",
  },
  {
    path: "/admin/**",
    visibility: "internal",
    reason: "Admin-only routes.",
  },
  {
    path: "/admin",
    visibility: "internal",
    reason: "Admin-only routes.",
  },
  {
    path: "/auth/**",
    visibility: "private",
    reason: "Browser session and Epic OAuth routes.",
  },
  {
    path: "/auth",
    visibility: "private",
    reason: "Browser session and Epic OAuth routes.",
  },
  {
    path: "/donate/**",
    visibility: "private",
    reason: "Donation key redemption routes.",
  },
  {
    path: "/launcher/**",
    visibility: "internal",
    reason: "Launcher service routes.",
  },
  {
    path: "/push/vapid-public-key",
    visibility: "public-deferred",
    reason: "Public browser helper; outside search/catalog pilot.",
  },
  {
    path: "/push/**",
    visibility: "private",
    reason: "API-key protected push notification routes.",
  },
  {
    path: "/refresh-meilisearch",
    visibility: "internal",
    reason: "Search index maintenance route.",
  },
  {
    path: "/refresh/**",
    visibility: "internal",
    reason: "Search index maintenance routes.",
  },
  {
    path: "/users/**",
    visibility: "private",
    reason: "User identity routes.",
  },
  {
    path: "/users",
    visibility: "private",
    reason: "User identity routes.",
  },
  {
    path: "/users-service/**",
    visibility: "internal",
    reason: "Service-to-service user routes.",
  },
  {
    path: "/users-service",
    visibility: "internal",
    reason: "Service-to-service user routes.",
  },
  {
    method: "PATCH",
    path: "/free-games/index",
    visibility: "internal",
    reason: "Free-games index maintenance route.",
  },
  {
    path: "/offers/regen/**",
    visibility: "internal",
    reason: "Offer regeneration queue route.",
  },
  {
    path: "/offers/regen-by-id/**",
    visibility: "internal",
    reason: "Offer regeneration queue route.",
  },
  {
    path: "/offers/bulk-regen",
    visibility: "internal",
    reason: "Offer regeneration queue route.",
  },
  {
    path: "/items/regen/**",
    visibility: "internal",
    reason: "Item regeneration route.",
  },
  {
    path: "/items/bulk-regen",
    visibility: "internal",
    reason: "Item regeneration route.",
  },
  {
    method: "PUT",
    path: "/profiles/{id}/refresh",
    visibility: "private",
    reason: "Profile refresh mutation.",
  },
  {
    path: "/profiles/me",
    visibility: "private",
    reason: "Authenticated profile route.",
  },
  {
    path: "/assets/**",
    visibility: "public-deferred",
    reason: "Public catalog data; outside first documentation slice.",
  },
  {
    path: "/base-game/**",
    visibility: "public-deferred",
    reason: "Public catalog lookup; outside first documentation slice.",
  },
  {
    path: "/builds/**",
    visibility: "public-deferred",
    reason: "Public build data needs response review before stable docs.",
  },
  {
    path: "/builds",
    visibility: "public-deferred",
    reason: "Public build data needs response review before stable docs.",
  },
  {
    path: "/changelog",
    visibility: "public-deferred",
    reason: "Legacy changelog route; search/changelog is documented first.",
  },
  {
    path: "/collections/**",
    visibility: "public-deferred",
    reason: "Public collection data; outside first documentation slice.",
  },
  {
    path: "/franchises/**",
    visibility: "public-deferred",
    reason: "Public catalog data; outside first documentation slice.",
  },
  {
    path: "/game-awards/**",
    visibility: "public-deferred",
    reason: "Public event route; outside first documentation slice.",
  },
  {
    path: "/game-awards",
    visibility: "public-deferred",
    reason: "Public event route; outside first documentation slice.",
  },
  {
    path: "/items-from-offer/**",
    visibility: "public-deferred",
    reason:
      "Public catalog lookup; alias needs consolidation with /offers/{id}/items.",
  },
  {
    path: "/multisearch/**",
    visibility: "public-deferred",
    reason: "Public search routes; outside first documentation slice.",
  },
  {
    path: "/offer-by-slug/**",
    visibility: "public-deferred",
    reason: "Public lookup route; outside first documentation slice.",
  },
  {
    method: "POST",
    path: "/offers/{id}/reviews",
    visibility: "private",
    reason: "Authenticated review creation route.",
  },
  {
    method: "PATCH",
    path: "/offers/{id}/reviews",
    visibility: "private",
    reason: "Authenticated review update route.",
  },
  {
    method: "DELETE",
    path: "/offers/{id}/reviews",
    visibility: "private",
    reason: "Authenticated review deletion route.",
  },
  {
    path: "/offers/{id}/reviews/permissions",
    visibility: "private",
    reason: "Authenticated review permission route.",
  },
  {
    path: "/offers/{id}/ownership",
    visibility: "private",
    reason: "Authenticated ownership route.",
  },
  {
    path: "/offers/{id}/og",
    visibility: "non-json",
    reason: "Generated OG image response.",
  },
  {
    path: "/profiles/**",
    visibility: "public-deferred",
    reason: "Public profile data; outside first documentation slice.",
  },
  {
    path: "/promotions/**",
    visibility: "public-deferred",
    reason: "Public promotion data; outside first documentation slice.",
  },
  {
    path: "/promotions",
    visibility: "public-deferred",
    reason: "Public promotion data; outside first documentation slice.",
  },
  {
    path: "/sales",
    visibility: "public-deferred",
    reason: "Public catalog listing; outside first documentation slice.",
  },
  {
    path: "/tags",
    visibility: "public-deferred",
    reason: "Public tag list; outside first documentation slice.",
  },
];
