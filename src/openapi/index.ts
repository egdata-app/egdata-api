import type { OpenAPIV3 } from "openapi-types";
import { API_VERSION } from "../version.js";
import { components } from "./components.js";
import { paths } from "./paths.js";

export function buildOpenApiDocument(): OpenAPIV3.Document {
  return {
    openapi: "3.0.3",
    info: {
      title: "egdata.app API",
      version: API_VERSION,
      description:
        "REST API for Epic Games Store catalog, pricing, search, and public egdata.app data. This contract starts with public stable REST endpoints and will expand as legacy routes are classified.",
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
  };
}

export { documentedOperations } from "./paths.js";
