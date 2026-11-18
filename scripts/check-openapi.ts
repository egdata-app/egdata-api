import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import {
  rustContracts,
  registrationJson,
  type MountedRoute as Route,
} from "./rust-contracts.js";
import policy from "../openapi/route-policy.json" with { type: "json" };
const { routeClassifications, v1Exclusions } = policy;
import { renderWorkerRouteTable } from "./v1-worker-routes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_SPEC_PATH = resolve(ROOT, "openapi", "egdata.openapi.json");
const STATIC_V1_SPEC_PATH = resolve(ROOT, "openapi", "egdata.v1.openapi.json");
const WORKER_ROUTES_PATH = resolve(
  ROOT,
  "dashboard",
  "worker",
  "v1-routes.generated.ts",
);

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
    errors.push(
      `${label}: expected OpenAPI 3.0.x, received ${document.openapi}`,
    );
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
        errors.push(
          `${label}: ${method.toUpperCase()} ${path} is missing operationId.`,
        );
      } else if (operationIds.has(operation.operationId)) {
        errors.push(
          `${label}: duplicate operationId ${operation.operationId}.`,
        );
      } else {
        operationIds.add(operation.operationId);
      }

      if (!operation.summary || operation.summary.startsWith("Endpoint for")) {
        errors.push(
          `${label}: ${method.toUpperCase()} ${path} needs a non-placeholder summary.`,
        );
      }

      if (!operation.tags?.length) {
        errors.push(
          `${label}: ${method.toUpperCase()} ${path} needs at least one tag.`,
        );
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
              referencedName &&
              document.components?.parameters?.[referencedName];

            return (
              referencedName === paramName ||
              ("name" in
                ((referencedParam ?? {}) as OpenAPIV3.ParameterObject) &&
                (referencedParam as OpenAPIV3.ParameterObject).name ===
                  paramName &&
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

const {
  legacyDocument: document,
  v1Document,
  v1Operations,
  v1Coverage: v1RouterCoverage,
  legacyRoutes: routes,
} = rustContracts();
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

const registeredPath = resolve(ROOT, "openapi", "rust-routes.generated.json");
if (
  !existsSync(registeredPath) ||
  (await readFile(registeredPath, "utf8")) !== registrationJson()
)
  errors.push("Rust route manifest is stale. Run pnpm openapi:generate.");
const documented = new Set(
  Object.entries(document.paths).flatMap(([path, item]) =>
    (
      [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
      ] as const
    )
      .filter((method) => item?.[method]?.operationId)
      .map((method) => method.toUpperCase() + " " + path),
  ),
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
    errors.push(
      `v1 operation ${key} is missing from the generated OpenAPI document.`,
    );
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
    if (
      exclusion.method &&
      exclusion.method !== "*" &&
      exclusion.method !== route.method
    ) {
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
