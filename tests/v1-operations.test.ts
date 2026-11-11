import { describe, expect, it } from "vitest";
import { v1Operations } from "../src/v1/operations/index.js";

const normalize = (path: string) =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/+$/, "") || "/";

const expectedV1Path = (legacy: string) => {
  const normalized = normalize(legacy);
  if (normalized === "/search/v2/search") return "/v1/search";
  return `/v1${normalized}`;
};

describe("v1 path preservation inventory", () => {
  it("maps every legacy operation to the same resource path beneath /v1", () => {
    const violations: string[] = [];
    for (const operation of v1Operations) {
      for (const legacy of operation.legacy ?? []) {
        if (operation.path !== expectedV1Path(legacy)) {
          violations.push(
            `${operation.operationId}: ${legacy} -> ${operation.path} (expected ${expectedV1Path(legacy)})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("registers unique operation IDs and method/path pairs", () => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const operation of v1Operations) {
      expect(ids.has(operation.operationId)).toBe(false);
      expect(keys.has(`${operation.method} ${operation.path}`)).toBe(false);
      ids.add(operation.operationId);
      keys.add(`${operation.method} ${operation.path}`);
      expect(operation.path.startsWith("/v1/")).toBe(true);
    }
  });

  it("keeps only the versioned v1 document as the public metadata exception", () => {
    const publicOperations = v1Operations.filter(
      (operation) => operation.auth === "public",
    );
    expect(publicOperations.map((operation) => operation.path).sort()).toEqual([
      "/v1/health",
      "/v1/open-api.json",
    ]);
  });
});
