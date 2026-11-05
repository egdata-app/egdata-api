import type { OpenAPIV3 } from "openapi-types";
import { describe, expect, it } from "vitest";
import { withAntiAbuseContract } from "../src/openapi/anti-abuse.js";
import { buildOpenApiDocument } from "../src/openapi/index.js";

describe("conditional PoW contract", () => {
  it("keeps public catalog operations accessible without PoW credentials", () => {
    const document = buildOpenApiDocument();
    for (const path of ["/offers", "/items", "/sellers"]) {
      expect(document.paths[path]?.get?.security).toContainEqual({});
      expect(document.paths[path]?.get?.security).toContainEqual({
        AbuseSessionHeader: [],
      });
      expect(document.paths[path]?.get?.description).toContain(
        "current risk <= 0.5",
      );
    }
  });

  it("makes PoW optional without relaxing existing account authentication", () => {
    const document: OpenAPIV3.Document = {
      openapi: "3.0.3",
      info: { title: "test", version: "1" },
      security: [{ GlobalAccount: [] }],
      paths: {
        "/offers/private": {
          get: {
            security: [{ Account: ["read"] }],
            responses: { 200: { description: "ok" } },
          },
        },
        "/items/private": {
          get: { responses: { 200: { description: "ok" } } },
        },
        "/sellers": {
          get: { security: [], responses: { 200: { description: "ok" } } },
        },
      },
    };
    const result = withAntiAbuseContract(document);
    expect(result.paths["/offers/private"]?.get?.security).toEqual([
      { Account: ["read"] },
      { Account: ["read"], AbuseSessionHeader: [] },
      { Account: ["read"], AbuseSessionCookie: [] },
    ]);
    expect(result.paths["/items/private"]?.get?.security).toEqual([
      { GlobalAccount: [] },
      { GlobalAccount: [], AbuseSessionHeader: [] },
      { GlobalAccount: [], AbuseSessionCookie: [] },
    ]);
    expect(result.paths["/sellers"]?.get?.security).toContainEqual({});
    expect(document.paths["/offers/private"]?.get?.security).toEqual([
      { Account: ["read"] },
    ]);
  });
});
