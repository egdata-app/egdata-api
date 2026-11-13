import {
  type EffectiveProjectEntitlement,
  type ExpensivePeriodBudgetKey,
  legacyExpensiveLimitsForProject,
  PLAN_VERSIONS,
  resolveExpensivePeriodBudgetKey,
} from "./plans.js";
import { quotaForProject } from "./project-quota.js";
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
})).sort((a, b) => {
  const left = a.path.split("/");
  const right = b.path.split("/");
  // Static segments take precedence over parameters, just like the origin router.
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const parameterDifference =
      Number(left[i].startsWith("{")) - Number(right[i].startsWith("{"));
    if (parameterDifference) return parameterDifference;
  }
  return right.length - left.length;
});

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

/**
 * Returns the explicit minute ceiling for an expensive policy family.
 * Commercial tiers and subscriptions use explicit published/configured tables
 * instead of proportional tier-RPM scaling; manual/grandfathered non-commercial
 * grants retain their explicit grant ceiling.
 */
export function expensivePolicyLimitForProject(
  policy: V1ExpensivePolicy,
  project: { tier: string; customRpm: number | null },
  entitlement?: EffectiveProjectEntitlement | null,
  commercialLimitsEnabled = false,
): number {
  if (entitlement) {
    return entitlement.expensiveMinuteLimits[policy];
  }
  if (project.tier === "scale") {
    return PLAN_VERSIONS["scale-v1"].expensiveMinuteLimits[policy];
  }
  if (commercialLimitsEnabled) {
    if (project.tier === "pro") {
      return PLAN_VERSIONS["pro-v1"].expensiveMinuteLimits[policy];
    }
    if (project.tier === "free") {
      return PLAN_VERSIONS["free-v1"].expensiveMinuteLimits[policy];
    }
  }
  const effectiveRpm = quotaForProject(project, undefined, commercialLimitsEnabled);
  return legacyExpensiveLimitsForProject(
    (project.tier as "free" | "pro" | "scale" | "enterprise") ?? "free",
    effectiveRpm,
  )[policy];
}

export function resolveExpensivePeriodPolicyName(
  pathname: string,
  method: string,
  operationId?: string,
): { key: ExpensivePeriodBudgetKey; policyName: string } | null {
  const key = resolveExpensivePeriodBudgetKey(pathname, method, operationId);
  if (!key) return null;
  return { key, policyName: `${key}-period` };
}

/**
 * Maps legacy gateway paths to the same expensive policy tiers as `/v1` so
 * callers cannot bypass per-operation limits via the legacy `/proxy` gateway.
 */
export function resolveLegacyExpensivePolicy(
  pathname: string,
  method: string,
): V1ExpensivePolicy | undefined {
  const upper = method.toUpperCase();
  const isRead = upper === "GET" || upper === "HEAD";

  if (pathname === "/offers" && isRead) return "offers-list";

  if (
    (pathname === "/autocomplete" && isRead) ||
    (pathname === "/search/v2/search" && (isRead || upper === "POST")) ||
    (pathname === "/search/changelog" && isRead) ||
    (pathname === "/free-games/search" && isRead)
  ) {
    return "search";
  }

  if (
    pathname === "/catalog" ||
    pathname.startsWith("/catalog/") ||
    pathname === "/builds/resolve-launcher-records"
  ) {
    return "bulk";
  }

  if (
    pathname === "/graphql" ||
    pathname === "/search/natural-language" ||
    /^\/search\/[^/]+\/count$/.test(pathname) ||
    pathname === "/multisearch" ||
    pathname.startsWith("/multisearch/") ||
    ((pathname === "/profiles" || pathname.startsWith("/profiles/")) &&
      pathname !== "/profiles/sitemap.xml") ||
    /^\/offers\/[^/]+\/og(?:\.webp)?$/.test(pathname) ||
    /^\/sandboxes\/[^/]+\/og(?:\.webp)?$/.test(pathname) ||
    pathname === "/game-awards/og" ||
    pathname === "/free-games/og" ||
    /^\/collections\/[^/]+(?:\/[^/]+)?(?:\/og)?$/.test(pathname) ||
    /^\/promotions\/[^/]+$/.test(pathname) ||
    /^\/sellers\/[^/]+(?:\/cover)?$/.test(pathname)
  ) {
    return "heavy";
  }

  return undefined;
}
