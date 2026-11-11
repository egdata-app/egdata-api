import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  CATALOG_HYDRATION_MAX_IDENTIFIERS,
  CATALOG_HYDRATION_MAX_KNOWN_RECORDS,
  CATALOG_HYDRATION_MAX_LINE_BYTES,
  CATALOG_HYDRATION_SCHEMA_VERSION,
  type CatalogHydrationIdentifier,
  type CatalogHydrationRequest,
  type CatalogHydrationRootResult,
  catalogHydrationRootKey,
} from "../../catalog/hydration.js";
import { MongoCatalogHydrationResolver } from "../../catalog/resolver.js";
import { db } from "../../db/index.js";
import { badRequest, ProblemError } from "../errors.js";
import { requireJsonContentType } from "../query.js";
import type { V1Variables } from "../request-context.js";

const app = new Hono<{ Variables: V1Variables }>();

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_KEY_LENGTH = 4_096;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const boundedString = (value: unknown, maximum = MAX_ID_LENGTH): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum;

const parseIdentifier = (value: unknown): CatalogHydrationIdentifier | null => {
  if (!isObject(value) || !boundedString(value.namespace)) return null;
  switch (value.type) {
    case "item":
      return boundedString(value.id)
        ? { type: "item", namespace: value.namespace, id: value.id }
        : null;
    case "asset":
      return boundedString(value.artifactId) &&
        boundedString(value.platform, 64)
        ? {
            type: "asset",
            namespace: value.namespace,
            artifactId: value.artifactId,
            platform: value.platform,
          }
        : null;
    case "release-app":
      return boundedString(value.appId) && boundedString(value.platform, 64)
        ? {
            type: "release-app",
            namespace: value.namespace,
            appId: value.appId,
            platform: value.platform,
          }
        : null;
    default:
      return null;
  }
};

export const parseCatalogHydrationRequest = (
  value: unknown,
): CatalogHydrationRequest | null => {
  if (
    !isObject(value) ||
    value.schemaVersion !== CATALOG_HYDRATION_SCHEMA_VERSION
  ) {
    return null;
  }
  if (
    !Array.isArray(value.identifiers) ||
    value.identifiers.length === 0 ||
    value.identifiers.length > CATALOG_HYDRATION_MAX_IDENTIFIERS ||
    !Array.isArray(value.knownRoots) ||
    value.knownRoots.length > CATALOG_HYDRATION_MAX_IDENTIFIERS ||
    !Array.isArray(value.knownRecords) ||
    value.knownRecords.length > CATALOG_HYDRATION_MAX_KNOWN_RECORDS
  ) {
    return null;
  }
  const identifiers = value.identifiers.map(parseIdentifier);
  if (identifiers.some((entry) => !entry)) return null;
  const typedIdentifiers = identifiers as CatalogHydrationIdentifier[];
  if (
    new Set(typedIdentifiers.map(catalogHydrationRootKey)).size !==
    typedIdentifiers.length
  ) {
    return null;
  }

  const parseHashes = (entries: unknown[], key: "rootKey" | "recordKey") =>
    entries.flatMap((entry) => {
      if (
        !isObject(entry) ||
        !boundedString(entry[key], MAX_KEY_LENGTH) ||
        (typeof entry.sha256 !== "string" && typeof entry.graphHash !== "string")
      ) {
        return [];
      }
      const hash = key === "rootKey" ? entry.graphHash : entry.sha256;
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return [];
      return [
        key === "rootKey"
          ? { rootKey: entry[key], graphHash: hash }
          : { recordKey: entry[key], sha256: hash },
      ];
    });

  const knownRoots = parseHashes(
    value.knownRoots,
    "rootKey",
  ) as CatalogHydrationRequest["knownRoots"];
  const knownRecords = parseHashes(
    value.knownRecords,
    "recordKey",
  ) as CatalogHydrationRequest["knownRecords"];
  if (
    knownRoots.length !== value.knownRoots.length ||
    knownRecords.length !== value.knownRecords.length
  ) {
    return null;
  }
  if (
    new Set(knownRoots.map((entry) => entry.rootKey)).size !== knownRoots.length ||
    new Set(knownRecords.map((entry) => entry.recordKey)).size !==
      knownRecords.length
  ) {
    return null;
  }

  return {
    schemaVersion: 2,
    identifiers: typedIdentifiers,
    knownRoots,
    knownRecords,
  };
};

const oversizedResult = (
  result: CatalogHydrationRootResult,
): CatalogHydrationRootResult => ({
  schemaVersion: 2,
  rootKey: result.rootKey,
  identifier: result.identifier,
  hydratedAt: new Date().toISOString(),
  status: "error",
  error: {
    code: "CATALOG_ROOT_TOO_LARGE",
    message: "This catalog root exceeds the hydration limit.",
  },
});

app.post("/catalog/hydrate", async (c) => {
  requireJsonContentType(c);
  const declaredLength = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ProblemError({
      status: 413,
      code: "CATALOG_HYDRATION_TOO_LARGE",
      detail: "The catalog hydration request is too large (maximum 256 KiB).",
    });
  }
  const body = await c.req.text();
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new ProblemError({
      status: 413,
      code: "CATALOG_HYDRATION_TOO_LARGE",
      detail: "The catalog hydration request is too large (maximum 256 KiB).",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw badRequest(
      "CATALOG_HYDRATION_INVALID_REQUEST",
      "The catalog hydration request is not valid JSON.",
    );
  }
  const request = parseCatalogHydrationRequest(parsed);
  if (!request) {
    throw badRequest(
      "CATALOG_HYDRATION_INVALID_REQUEST",
      "The catalog hydration request is invalid.",
    );
  }

  const reader = new MongoCatalogHydrationResolver(db.db);
  c.header("Content-Type", "application/x-ndjson; charset=utf-8");
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return stream(c, async (output) => {
    let cancelled = false;
    output.onAbort(() => {
      cancelled = true;
    });
    for (const identifier of request.identifiers) {
      if (cancelled || c.req.raw.signal.aborted) break;
      let result: CatalogHydrationRootResult;
      try {
        result = await reader.resolve(identifier, request);
      } catch {
        result = {
          schemaVersion: 2,
          rootKey: catalogHydrationRootKey(identifier),
          identifier,
          hydratedAt: new Date().toISOString(),
          status: "error",
          error: {
            code: "CATALOG_ROOT_RESOLUTION_FAILED",
            message: "This catalog root could not be hydrated.",
          },
        };
      }
      let line = `${JSON.stringify(result)}\n`;
      if (Buffer.byteLength(line, "utf8") > CATALOG_HYDRATION_MAX_LINE_BYTES) {
        result = oversizedResult(result);
        line = `${JSON.stringify(result)}\n`;
      }
      await output.write(line);
    }
  });
});

export default app;

