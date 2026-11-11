import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { buildOpenApiDocument, documentedOperations } from "../src/openapi/index.js";
import { buildV1OpenApiDocument } from "../src/openapi/v1.js";
import { routeClassifications } from "../src/openapi/route-inventory.js";
import type { Method } from "../src/openapi/types.js";
import { v1Exclusions } from "../src/openapi/v1-coverage.js";
import { v1Operations } from "../src/v1/operations/index.js";
import { validateV1OperationCoverage } from "../src/v1/router.js";
import { renderWorkerRouteTable } from "./v1-worker-routes.js";

type Route = {
  method: Method;
  path: string;
  file: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_SPEC_PATH = resolve(ROOT, "openapi", "egdata.openapi.json");
const STATIC_V1_SPEC_PATH = resolve(ROOT, "openapi", "egdata.v1.openapi.json");
const WORKER_ROUTES_PATH = resolve(
  ROOT,
  "dashboard",
  "worker",
  "v1-routes.generated.ts",
);
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
      routes.push(
        ...(await collectRoutes(target, joinPaths(prefix, match[1]), seen)),
      );
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

function findClassification(route: Route) {
  return routeClassifications.find((classification) => {
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

function isClassified(route: Route): boolean {
  return Boolean(findClassification(route));
}

function validateDocument(
  document: OpenAPIV3.Document,
  label: string,
): string[] {
  const errors: string[] = [];
  const operationIds = new Set<string>();

  if (!document.openapi.startsWith("3.0.")) {
    errors.push(`${label}: expected OpenAPI 3.0.x, received ${document.openapi}`);
  }

  for (const [path, item] of Object.entries(document.paths)) {
    if (path.includes(":")) {
      errors.push(
        `${label}: path ${path} uses Hono-style params; use OpenAPI {param} syntax.`,
      );
    }

    const pathParams = new Set(
      [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
    );

    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
    ] as const) {
      const operation = item?.[method] as
        | (OpenAPIV3.OperationObject & { "x-egdata-visibility"?: string })
        | undefined;
      if (!operation) continue;

      if (!operation.operationId) {
        errors.push(`${label}: ${method.toUpperCase()} ${path} is missing operationId.`);
      } else if (operationIds.has(operation.operationId)) {
        errors.push(`${label}: duplicate operationId ${operation.operationId}.`);
      } else {
        operationIds.add(operation.operationId);
      }

      if (!operation.summary || operation.summary.startsWith("Endpoint for")) {
        errors.push(
          `${label}: ${method.toUpperCase()} ${path} needs a non-placeholder summary.`,
        );
      }

      if (!operation.tags?.length) {
        errors.push(`${label}: ${method.toUpperCase()} ${path} needs at least one tag.`);
      }

      if (!operation["x-egdata-visibility"]) {
        errors.push(
          `${label}: ${method.toUpperCase()} ${path} is missing x-egdata-visibility.`,
        );
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
              ("name" in ((referencedParam ?? {}) as OpenAPIV3.ParameterObject) &&
                (referencedParam as OpenAPIV3.ParameterObject).name === paramName &&
                (referencedParam as OpenAPIV3.ParameterObject).in === "path")
            );
          }
          return param.in === "path" && param.name === paramName;
        });
        if (!hasParam) {
          errors.push(
            `${label}: ${method.toUpperCase()} ${path} is missing path parameter ${paramName}.`,
          );
        }
      }
    }
  }

  return errors;
}

const document = buildOpenApiDocument();
const v1Document = buildV1OpenApiDocument();
const errors = [
  ...validateDocument(document, "legacy"),
  ...validateDocument(v1Document, "v1"),
];

for (const spec of [
  { path: STATIC_SPEC_PATH, document, label: "legacy" },
  { path: STATIC_V1_SPEC_PATH, document: v1Document, label: "v1" },
]) {
  try {
    const staticSpec = JSON.parse(await readFile(spec.path, "utf8"));
    if (JSON.stringify(staticSpec) !== JSON.stringify(spec.document)) {
      errors.push(
        `openapi/${relative(resolve(ROOT, "openapi"), spec.path)} is stale for ${spec.label}. Run \`pnpm openapi:generate\`.`,
      );
    }
  } catch {
    errors.push(
      `Missing or unreadable static ${spec.label} OpenAPI document. Run \`pnpm openapi:generate\`.`,
    );
  }
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

// ---------------------------------------------------------------------------
// Version 1 coverage
// ---------------------------------------------------------------------------

const v1RouterCoverage = validateV1OperationCoverage();
if (v1RouterCoverage.missingHandlers.length > 0) {
  errors.push(
    [
      "v1 operations without a registered handler:",
      ...v1RouterCoverage.missingHandlers.map((entry) => `- ${entry}`),
      "Register the handler or remove the operation metadata.",
    ].join("\n"),
  );
}
if (v1RouterCoverage.undocumentedHandlers.length > 0) {
  errors.push(
    [
      "v1 handlers without operation metadata (undocumented operations):",
      ...v1RouterCoverage.undocumentedHandlers.map((entry) => `- ${entry}`),
    ].join("\n"),
  );
}

const v1Documented = new Set(
  Object.entries(v1Document.paths).flatMap(([path, item]) =>
    (["get", "post"] as const)
      .filter((method) => Boolean(item?.[method]))
      .map((method) => `${method.toUpperCase()} ${path}`),
  ),
);
for (const operation of v1Operations) {
  const key = `${operation.method} ${operation.path}`;
  if (!v1Documented.has(key)) {
    errors.push(`v1 operation ${key} is missing from the generated OpenAPI document.`);
  }
  if (!operation.path.startsWith("/v1/")) {
    errors.push(`v1 operation ${key} must start with /v1/.`);
  }
  if (operation.paginated) {
    const params = operation.parameters ?? [];
    if (!params.some((parameter) => parameter.name === "cursor")) {
      errors.push(`v1 paginated operation ${key} must document cursor.`);
    }
    if (!params.some((parameter) => parameter.name === "limit")) {
      errors.push(`v1 paginated operation ${key} must document limit.`);
    }
    if (params.some((parameter) => parameter.name === "page")) {
      errors.push(`v1 paginated operation ${key} must not document page.`);
    }
  }
}

const normalizedLegacyForOperation = new Set<string>();
for (const operation of v1Operations) {
  for (const legacy of operation.legacy ?? []) {
    normalizedLegacyForOperation.add(
      `${operation.method} ${normalizePath(legacy)}`,
    );
  }
}

const discovered = new Set(
  routes.map((route) => `${route.method} ${normalizePath(route.path)}`),
);
for (const operation of v1Operations) {
  for (const legacy of operation.legacy ?? []) {
    const key = `${operation.method} ${normalizePath(legacy)}`;
    if (!discovered.has(key)) {
      errors.push(
        `v1 operation ${operation.operationId} maps to ${key}, but no such legacy route was discovered.`,
      );
    }
  }
}

const excludedSet = new Set(
  v1Exclusions.map(
    (exclusion) =>
      `${exclusion.method ?? "*"} ${normalizePath(exclusion.path)}`,
  ),
);

function isV1Excluded(route: Route): boolean {
  return v1Exclusions.some((exclusion) => {
    if (exclusion.method && exclusion.method !== "*" && exclusion.method !== route.method) {
      return false;
    }
    return patternToRegExp(normalizePath(exclusion.path)).test(route.path);
  });
}

const uncoveredPublic: string[] = [];
for (const route of routes) {
  const key = `${route.method} ${normalizePath(route.path)}`;
  if (documented.has(key) || normalizedLegacyForOperation.has(key)) continue;
  const classification = findClassification(route);
  if (isV1Excluded(route)) continue;
  if (
    !classification ||
    classification.visibility === "public" ||
    classification.visibility === "public-deferred" ||
    classification.visibility === "non-json"
  ) {
    uncoveredPublic.push(`${key} (${route.file})`);
  }
}
if (uncoveredPublic.length > 0) {
  errors.push(
    [
      "Public legacy routes are neither mapped to v1 nor explicitly excluded:",
      ...uncoveredPublic.map((entry) => `- ${entry}`),
    ].join("\n"),
  );
}

for (const exclusion of v1Exclusions) {
  const matched = routes.some((route) => {
    if (
      exclusion.method &&
      exclusion.method !== "*" &&
      exclusion.method !== route.method
    ) {
      return false;
    }
    return patternToRegExp(normalizePath(exclusion.path)).test(route.path);
  });
  if (!matched) {
    errors.push(
      `Stale v1 exclusion ${exclusion.method ?? "*"} ${exclusion.path} does not match any discovered route. Remove it or correct the pattern.`,
    );
  }
}

try {
  const generatedWorkerRoutes = await readFile(WORKER_ROUTES_PATH, "utf8");
  if (generatedWorkerRoutes !== renderWorkerRouteTable()) {
    errors.push(
      "dashboard/worker/v1-routes.generated.ts is stale. Run `pnpm openapi:generate`.",
    );
  }
} catch {
  errors.push(
    "Missing or unreadable dashboard worker v1 route table. Run `pnpm openapi:generate`.",
  );
}

if (errors.length > 0) {
  fail(errors.join("\n"));
}

console.log(
  `OpenAPI check passed (${documented.size} legacy operations, ${v1Operations.length} v1 operations, ${routes.length} discovered routes, ${v1Exclusions.length} explicit v1 exclusions).`,
);
// Importing the v1 router initializes shared Redis/OpenSearch clients. Their
// reconnect timers are irrelevant to this static check and would keep the
// process alive after a successful pass.
process.exit(0);
