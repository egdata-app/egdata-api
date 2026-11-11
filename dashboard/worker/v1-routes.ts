import type { ApiScope } from "./types.js";
import { generatedV1Routes } from "./v1-routes.generated.js";

export type V1ExpensivePolicy = "offers-list" | "search" | "heavy" | "bulk";

export type V1Route = {
  operationId: string;
  path: string;
  methods: Array<"GET" | "POST">;
  scope: ApiScope;
  expensive?: V1ExpensivePolicy;
};

/**
 * Worker-side operation table, generated from the origin registry. It
 * deliberately contains only routing metadata (never handler code) so the edge
 * bundle does not pull in the VM's MongoDB/OpenSearch stack. CI checks that the
 * generated file is current.
 */
const ROUTES: V1Route[] = generatedV1Routes;

function patternFor(path: string): RegExp {
  const escaped = path
    .split("/")
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${escaped}$`);
}

const COMPILED = ROUTES.map((route) => ({
  ...route,
  pattern: patternFor(route.path),
}));

export const PUBLIC_V1_PATHS = new Set(["/v1/health", "/v1/open-api.json"]);

/**
 * Canonicalizes a v1 path and rejects encoded separators, dot segments, and
 * duplicate slashes so a permission check cannot be bypassed with `%2F`.
 */
export function canonicalV1Path(rawPathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith("/v1") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("//") ||
    decoded === "/v1/" ||
    (decoded.length > 5 && !decoded.startsWith("/v1/"))
  ) {
    return null;
  }
  if (decoded.includes("%") || decoded.includes("?")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return decoded;
}

export function resolveV1Route(
  pathname: string,
  method: string,
): V1Route | null {
  const normalizedMethod =
    method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const route of COMPILED) {
    if (!route.pattern.test(pathname)) continue;
    if (!route.methods.includes(normalizedMethod as "GET" | "POST")) continue;
    return route;
  }
  return null;
}

export function isKnownV1Path(pathname: string): boolean {
  return COMPILED.some((route) => route.pattern.test(pathname));
}

export function allowedMethodsForV1Path(pathname: string): string[] {
  const methods = new Set<string>();
  for (const route of COMPILED) {
    if (!route.pattern.test(pathname)) continue;
    for (const method of route.methods) {
      methods.add(method);
      if (method === "GET") methods.add("HEAD");
    }
  }
  return [...methods].sort((a, b) => a.localeCompare(b));
}

export const expensivePolicyLimits: Record<V1ExpensivePolicy, number> = {
  "offers-list": 5,
  search: 300,
  heavy: 60,
  bulk: 10,
};

export const tierQuotas: Record<string, number> = {
  free: 120,
  pro: 1_200,
  enterprise: 6_000,
};

export function quotaForKey(meta: {
  tier: string;
  customRpm: number | null;
}): number {
  if (
    typeof meta.customRpm === "number" &&
    Number.isInteger(meta.customRpm) &&
    meta.customRpm >= 1 &&
    meta.customRpm <= 1_000_000
  ) {
    return meta.customRpm;
  }
  return tierQuotas[meta.tier] ?? tierQuotas.free;
}
