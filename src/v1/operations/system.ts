import { defineOperations } from "../route-types.js";

export const systemOperations = defineOperations([
  {
    operationId: "getHealth",
    method: "GET",
    path: "/v1/health",
    summary: "Service health",
    description:
      "Reports Redis and MongoDB connectivity. This endpoint is public and does not require an API key.",
    tags: ["System"],
    scope: "catalog:read",
    auth: "public",
    legacy: ["/health"],
  },
  {
    operationId: "getV1OpenApi",
    method: "GET",
    path: "/v1/open-api.json",
    summary: "Version 1 OpenAPI document",
    description:
      "Machine-readable OpenAPI 3.0 contract for the versioned public API. The legacy contract remains at /open-api.json.",
    tags: ["System"],
    scope: "catalog:read",
    auth: "public",
    legacy: ["/open-api.json"],
  },
] as const);
