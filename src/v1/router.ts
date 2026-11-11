import { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
import { responseEtag } from "../middlewares/response-etag.js";
import { ProblemError, problemResponse } from "./errors.js";
import { v1Operations } from "./operations/index.js";
import {
  type V1Variables,
  v1CachePolicy,
  v1Context,
} from "./request-context.js";
import type { V1OperationMetadata } from "./route-types.js";
import assetsRoutes from "./routes/assets.js";
import buildsRoutes from "./routes/builds.js";
import catalogRoutes from "./routes/catalog.js";
import catalogHydrateRoutes from "./routes/catalog-hydrate.js";
import collectionsRoutes from "./routes/collections.js";
import franchisesRoutes from "./routes/franchises.js";
import freeGamesRoutes from "./routes/free-games.js";
import gameAwardsRoutes from "./routes/game-awards.js";
import itemsRoutes from "./routes/items.js";
import multisearchRoutes from "./routes/multisearch.js";
import nativeRoutes from "./routes/native.js";
import offerDetailsRoutes from "./routes/offer-details.js";
import offersRoutes from "./routes/offers.js";
import ogRoutes from "./routes/og.js";
import profilesRoutes from "./routes/profiles.js";
import promotionsRoutes from "./routes/promotions.js";
import sandboxesRoutes from "./routes/sandboxes.js";
import searchRoutes from "./routes/search.js";
import sellersRoutes from "./routes/sellers.js";
import statsRoutes from "./routes/stats.js";
import systemRoutes from "./routes/system.js";

const v1 = new Hono<{ Variables: V1Variables }>();

v1.use("*", v1Context());
v1.use("*", async (c, next) => {
  // NDJSON hydration is a streaming protocol; buffering it for an ETag would
  // turn the response into a single delayed document.
  if (c.req.path.endsWith("/catalog/hydrate")) return next();
  return responseEtag(c, next);
});
v1.use("*", v1CachePolicy());

// Direct origin deployments may receive browser preflights when the Worker is
// not in front. Preflights never authenticate and never consume quota.
v1.options("*", (c) => {
  const origin = c.req.header("origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "X-API-Key, Authorization, Content-Type, If-None-Match, X-Request-Id",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "private, no-store",
    "X-Request-Id": c.get("requestId") as string,
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
});

v1.route("/", systemRoutes);
v1.route("/", catalogRoutes);
v1.route("/", catalogHydrateRoutes);
v1.route("/", offersRoutes);
v1.route("/", offerDetailsRoutes);
v1.route("/", searchRoutes);
v1.route("/", multisearchRoutes);
v1.route("/", nativeRoutes);
v1.route("/", ogRoutes);
v1.route("/", itemsRoutes);
v1.route("/", sellersRoutes);
v1.route("/", sandboxesRoutes);
v1.route("/", buildsRoutes);
v1.route("/", freeGamesRoutes);
v1.route("/", promotionsRoutes);
v1.route("/", collectionsRoutes);
v1.route("/", profilesRoutes);
v1.route("/", statsRoutes);
v1.route("/", franchisesRoutes);
v1.route("/", gameAwardsRoutes);
v1.route("/", assetsRoutes);

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

const compiledOperations = v1Operations.map((operation) => ({
  operation,
  pattern: patternFor(operation.path),
}));

v1.all("*", (c) => {
  const requestPath =
    c.req.path === "/v1" || c.req.path.startsWith("/v1/")
      ? c.req.path
      : `/v1${c.req.path === "/" ? "" : c.req.path}`;
  const matches = compiledOperations.filter((entry) =>
    entry.pattern.test(requestPath),
  );
  if (matches.length === 0) {
    throw new ProblemError({
      status: 404,
      code: "NOT_FOUND",
      detail: "No version 1 operation exists at this path.",
    });
  }
  const allowed = Array.from(
    new Set(
      matches.flatMap((entry) =>
        entry.operation.method === "GET"
          ? ["GET", "HEAD"]
          : [entry.operation.method],
      ),
    ),
  );
  throw new ProblemError({
    status: 405,
    code: "METHOD_NOT_ALLOWED",
    detail: `The ${c.req.method} method is not supported for ${requestPath}.`,
    headers: { Allow: allowed.join(", ") },
  });
});

v1.onError((error, c) => {
  if (error instanceof ProblemError) {
    return problemResponse(c, error);
  }
  console.error("[v1] Unhandled error", error);
  return problemResponse(
    c,
    new ProblemError({
      status: 500,
      code: "INTERNAL_ERROR",
      detail:
        "The API could not complete the request. Retry later and include the request ID when contacting support.",
    }),
  );
});

v1.notFound((c) =>
  problemResponse(
    c,
    new ProblemError({
      status: 404,
      code: "NOT_FOUND",
      detail: "No version 1 operation exists at this path.",
    }),
  ),
);

export function validateV1OperationCoverage(): {
  missingHandlers: string[];
  undocumentedHandlers: string[];
} {
  const normalize = (path: string) =>
    path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/+$/, "") || "/";
  const routes = inspectRoutes(v1)
    .filter(
      (route) =>
        !route.isMiddleware &&
        route.method !== "ALL" &&
        route.method !== "OPTIONS" &&
        route.path !== "*",
    )
    .map(
      (route) =>
        `${route.method} ${normalize(`/v1${route.path === "/" ? "" : route.path}`)}`,
    );

  const registered = new Set(routes);
  const documented = new Set(
    v1Operations.map((operation) => `${operation.method} ${operation.path}`),
  );

  return {
    missingHandlers: [...documented].filter((entry) => !registered.has(entry)),
    undocumentedHandlers: [...registered].filter(
      (entry) => !documented.has(entry),
    ),
  };
}

export const v1Router = v1;
export { v1Operations };
export type { V1OperationMetadata };
export default v1;
