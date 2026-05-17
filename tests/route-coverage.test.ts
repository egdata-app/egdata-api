import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { documentedOperations } from "../src/openapi/index.js";
import { routeClassifications } from "../src/openapi/route-inventory.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const rootSnapshot = JSON.parse(
  readFileSync(join(HERE, "__snapshots__", "root.json"), "utf8"),
) as {
  body: {
    endpoints: string[];
  };
};

function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function patternToRegExp(pattern: string): RegExp {
  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const source = pattern
    .split("**")
    .map((segment) =>
      segment
        .split("*")
        .map((part) => escapeRegExp(part))
        .join("[^/]+"),
    )
    .join(".*");

  return new RegExp(`^${source}$`);
}

const documented = new Set(
  documentedOperations.map((route) => `${route.method} ${route.path}`),
);

function isClassified(method: string, path: string): boolean {
  return routeClassifications.some((classification) => {
    if (
      classification.method &&
      classification.method !== "*" &&
      classification.method !== method
    ) {
      return false;
    }

    return patternToRegExp(classification.path).test(path);
  });
}

describe("route documentation coverage", () => {
  it("documents or classifies every known route from the committed inventory", () => {
    const uncovered = rootSnapshot.body.endpoints.filter((entry) => {
      const [method, rawPath] = entry.split(" ");
      const path = normalizePath(rawPath);

      if (documented.has(`${method} ${path}`)) return false;
      return !isClassified(method, path);
    });

    expect(uncovered).toEqual([]);
  });
});

