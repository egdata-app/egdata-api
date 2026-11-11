import { defineOperations, pathParameter } from "../route-types.js";

export const assetsOperations = defineOperations([
  {
    operationId: "getAsset",
    method: "GET",
    path: "/v1/assets/{id}",
    summary: "Get an asset",
    description:
      "Looks up a single catalog asset by its Epic Games artifact ID and returns the serialized asset document. Returns `404` when no asset matches.",
    tags: ["Assets"],
    scope: "catalog:read",
    auth: "key",
    responseKind: "json",
    parameters: [pathParameter("id", "Epic Games artifact ID of the asset.")],
    legacy: ["/assets/{id}"],
  },
] as const);
