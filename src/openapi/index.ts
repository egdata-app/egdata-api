import type { OpenAPIV3 } from "openapi-types";
import { API_VERSION } from "../version.js";
import { withAntiAbuseContract } from "./anti-abuse.js";
import { components } from "./components.js";
import { paths } from "./paths.js";
import { withProjectGatewayQuota } from "./project-quota.js";

export function buildOpenApiDocument(): OpenAPIV3.Document {
  const document = withAntiAbuseContract({
    openapi: "3.0.3",
    info: {
      title: "egdata.app API",
      version: API_VERSION,
      description:
        "REST API for Epic Games Store catalog, pricing, search, and public egdata.app data. Public access at https://api.egdata.app is unchanged while the Worker gateway is staged separately. The dedicated origin-api.egdata.app hostname requires a private Worker-to-origin credential; direct requests return 403 ORIGIN_ACCESS_DENIED (or 503 ORIGIN_NOT_CONFIGURED if the origin lacks configuration). Clients must not send or obtain X-Egdata-Origin-Token. Global origin enforcement and moving the public hostname to the Worker require a separate explicit cutover. This contract starts with public stable REST endpoints and will expand as legacy routes are classified. The separately documented GraphQL endpoint defaults to 30 POST requests per minute per client IP (RATE_LIMIT_GRAPHQL_POST_PER_MINUTE); exceeding the quota returns 429 with Retry-After. GraphQL GET/APQ has a separate default quota of 1200 per minute.",
      contact: {
        name: "egdata.app",
        url: "https://egdata.app",
      },
    },
    servers: [
      {
        url: "https://api.egdata.app",
        description: "Production",
      },
      {
        url: "https://api-gcp.egdata.app",
        description: "Production GCP mirror",
      },
      {
        url: "http://localhost:4000",
        description: "Local development",
      },
    ],
    tags: [
      {
        name: "System",
        description: "API metadata and health checks.",
      },
      {
        name: "Regions",
        description: "Country and Epic pricing region helpers.",
      },
      {
        name: "Catalog",
        description: "Cross-catalog discovery endpoints.",
      },
      {
        name: "Offers",
        description: "Epic Games Store offer data.",
      },
      {
        name: "Offer Details",
        description:
          "Offer subresources such as items, media, builds, ratings, and related data.",
      },
      {
        name: "Offer Reviews",
        description: "Read-only public review data for offers.",
      },
      {
        name: "Prices",
        description: "Regional pricing and price history.",
      },
      {
        name: "Items",
        description: "Epic catalog item data.",
      },
      {
        name: "Sandboxes",
        description: "Epic namespace and sandbox resources.",
      },
      {
        name: "Free Games",
        description: "Current and historical free game promotions.",
      },
      {
        name: "Search",
        description: "Search and facet endpoints.",
      },
      {
        name: "Sellers",
        description: "Seller metadata and statistics.",
      },
      {
        name: "Stats",
        description: "Aggregate catalog statistics.",
      },
    ],
    paths,
    components,
  });
  return withProjectGatewayQuota(document);
}

export { documentedOperations } from "./paths.js";
