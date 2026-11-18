import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi/index.js";
import { buildV1OpenApiDocument } from "../src/openapi/v1.js";

describe("the public Rust-generated documents preserve the Node origin contracts", () => {
  for (const [filename, build] of [
    ["egdata.openapi.json", buildOpenApiDocument],
    ["egdata.v1.openapi.json", buildV1OpenApiDocument],
  ] as const) {
    it(filename, () => {
      const published = readFileSync(new URL("../openapi/" + filename, import.meta.url), "utf8");
      expect(published.trimEnd()).toBe(JSON.stringify(build(), null, 2));
    });
  }
});
