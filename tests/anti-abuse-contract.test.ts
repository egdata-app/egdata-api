import type { OpenAPIV3 } from "openapi-types";
import { describe, expect, it } from "vitest";
import { withAntiAbuseContract } from "../src/openapi/anti-abuse.js";
import { buildOpenApiDocument } from "../src/openapi/index.js";

describe("conditional PoW contract", () => {
  it("documents bodyless marked 204 tarpits separately from unchanged 200 challenges", () => {
    const document = buildOpenApiDocument();
    for (const operation of [
      document.paths["/offers"]?.get,
      document.paths["/search/v2/search"]?.post,
    ]) {
      expect(operation?.responses["204"]).toMatchObject({
        headers: { "X-Egdata-Mitigation": { schema: { enum: ["tarpit"] } } },
      });
      expect(operation?.responses["204"]).not.toHaveProperty("content");
      expect(JSON.stringify(operation?.responses["200"])).toContain(
        "SessionChallengeRequired",
      );
      expect(JSON.stringify(operation?.responses["200"])).not.toContain(
        "AbuseTruncatedResponse",
      );
    }
  });
  it("keeps public catalog operations accessible without PoW credentials", () => {
    const document = buildOpenApiDocument();
    for (const path of [
      "/offers",
      "/items",
      "/sellers",
      "/sales",
      "/active-sales",
    ]) {
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
