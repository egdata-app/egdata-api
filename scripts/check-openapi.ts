import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { buildOpenApiDocument, documentedOperations } from "../src/openapi/index.js";
import { routeClassifications } from "../src/openapi/route-inventory.js";
import type { Method } from "../src/openapi/types.js";

type Route = {
  method: Method;
  path: string;
  file: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_SPEC_PATH = resolve(ROOT, "openapi", "egdata.openapi.json");
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function normalizePath(path: string): string {
  const normalized = path
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
  return normalized === "" ? "/" : normalized;
}

function joinPaths(a: string, b: string): string {
  const joined = `/${[a, b].join("/").split("/").filter(Boolean).join("/")}`;
  return normalizePath(joined === "/" ? "/" : joined.replace(/\/$/, ""));
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const withoutJs = specifier.replace(/\.js$/, "");
  const base = resolve(dirname(fromFile), withoutJs);
  for (const extension of [".ts", ".tsx"]) {
    const file = `${base}${extension}`;
    if (existsSync(file)) return file;
  }
  for (const extension of [".ts", ".tsx"]) {
    const file = resolve(base, `index${extension}`);
    if (existsSync(file)) return file;
  }
  return null;
}

async function read(file: string): Promise<string> {
  return readFile(file, "utf8");
}

async function getImports(file: string): Promise<Map<string, string>> {
  const text = await read(file);
  const imports = new Map<string, string>();
  const importRe =
    /import\s+([A-Za-z0-9_$]+)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/g;

  for (const match of text.matchAll(importRe)) {
    const resolved = resolveImport(file, match[2]);
    if (resolved) imports.set(match[1], resolved);
  }

  return imports;
}

async function collectRoutes(
  file: string,
  prefix = "",
  seen = new Set<string>(),
): Promise<Route[]> {
  const key = `${file}|${prefix}`;
  if (seen.has(key)) return [];
  seen.add(key);

  const text = await read(file);
  const routes: Route[] = [];

  for (const method of methods) {
    const routeRe = new RegExp(
      `app\\.${method.toLowerCase()}\\(\\s*["']([^"']+)["']`,
      "g",
    );
    for (const match of text.matchAll(routeRe)) {
      routes.push({
        method,
        path: joinPaths(prefix, match[1]),
        file: relative(ROOT, file),
      });
    }
  }

  const imports = await getImports(file);
  const mountedRouteRe = /app\.route\(\s*["']([^"']+)["']\s*,\s*([A-Za-z0-9_$]+)/g;
  for (const match of text.matchAll(mountedRouteRe)) {
    const target = imports.get(match[2]);
    if (target) {
      routes.push(...(await collectRoutes(target, joinPaths(prefix, match[1]), seen)));
    }
  }

  return routes;
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

function isClassified(route: Route): boolean {
  return routeClassifications.some((classification) => {
    if (
      classification.method &&
      classification.method !== "*" &&
      classification.method !== route.method
    ) {
      return false;
    }

    return patternToRegExp(classification.path).test(route.path);
  });
}

function validateDocument(document: OpenAPIV3.Document): string[] {
  const errors: string[] = [];
  const operationIds = new Set<string>();

  if (!document.openapi.startsWith("3.0.")) {
    errors.push(`Expected OpenAPI 3.0.x, received ${document.openapi}`);
  }

  for (const [path, item] of Object.entries(document.paths)) {
    if (path.includes(":")) {
      errors.push(`Path ${path} uses Hono-style params; use OpenAPI {param} syntax.`);
    }

    const pathParams = new Set(
      [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
    );

    for (const method of ["get", "post", "put", "patch", "delete", "options"] as const) {
      const operation = item?.[method] as
        | (OpenAPIV3.OperationObject & { "x-egdata-visibility"?: string })
        | undefined;
      if (!operation) continue;

      if (!operation.operationId) {
        errors.push(`${method.toUpperCase()} ${path} is missing operationId.`);
      } else if (operationIds.has(operation.operationId)) {
        errors.push(`Duplicate operationId ${operation.operationId}.`);
      } else {
        operationIds.add(operation.operationId);
      }

      if (!operation.summary || operation.summary.startsWith("Endpoint for")) {
        errors.push(`${method.toUpperCase()} ${path} needs a non-placeholder summary.`);
      }

      if (!operation.tags?.length) {
        errors.push(`${method.toUpperCase()} ${path} needs at least one tag.`);
      }

      if (!operation["x-egdata-visibility"]) {
        errors.push(`${method.toUpperCase()} ${path} is missing x-egdata-visibility.`);
      }

      const operationParams = operation.parameters ?? [];
      for (const paramName of pathParams) {
        const hasParam = operationParams.some((param) => {
          if ("$ref" in param) {
            const referencedName = param.$ref.split("/").at(-1);
            const referencedParam =
              referencedName && document.components?.parameters?.[referencedName];

            return (
              referencedName === paramName ||
              ("name" in (referencedParam ?? {}) &&
                (referencedParam as OpenAPIV3.ParameterObject).name === paramName &&
                (referencedParam as OpenAPIV3.ParameterObject).in === "path")
            );
          }
          return param.in === "path" && param.name === paramName;
        });
        if (!hasParam) {
          errors.push(`${method.toUpperCase()} ${path} is missing path parameter ${paramName}.`);
        }
      }
    }
  }

  return errors;
}

const document = buildOpenApiDocument();
const errors = validateDocument(document);

const staticSpec = JSON.parse(await readFile(STATIC_SPEC_PATH, "utf8"));
if (JSON.stringify(staticSpec) !== JSON.stringify(document)) {
  errors.push("openapi/egdata.openapi.json is stale. Run `pnpm openapi:generate`.");
}

const routes = await collectRoutes(resolve(ROOT, "src", "index.ts"));
const documented = new Set(
  documentedOperations.map((route) => `${route.method} ${route.path}`),
);

const unclassified = routes.filter((route) => {
  if (documented.has(`${route.method} ${route.path}`)) return false;
  return !isClassified(route);
});

if (unclassified.length > 0) {
  errors.push(
    [
      "Some routes are neither documented nor classified:",
      ...unclassified.map(
        (route) => `- ${route.method} ${route.path} (${route.file})`,
      ),
    ].join("\n"),
  );
}

if (errors.length > 0) {
  fail(errors.join("\n"));
}

console.log(
  `OpenAPI check passed (${documented.size} documented operations, ${routes.length} discovered routes).`,
);
