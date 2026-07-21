import { createHash } from "node:crypto";
import type { CatalogRecord } from "./types.js";

export const CATALOG_HYDRATION_SCHEMA_VERSION = 2 as const;
export const CATALOG_HYDRATION_MAX_IDENTIFIERS = 25;
export const CATALOG_HYDRATION_MAX_KNOWN_RECORDS = 5_000;
export const CATALOG_HYDRATION_MAX_ROOT_RECORDS = 500;
export const CATALOG_HYDRATION_MAX_LINE_BYTES = 2 * 1024 * 1024;

export type CatalogHydrationIdentifier =
  | { type: "item"; namespace: string; id: string }
  | { type: "asset"; namespace: string; artifactId: string; platform: string }
  | { type: "release-app"; namespace: string; appId: string; platform: string };

export type CatalogHydrationRequest = {
  schemaVersion: 2;
  identifiers: CatalogHydrationIdentifier[];
  knownRoots: Array<{ rootKey: string; graphHash: string }>;
  knownRecords: Array<{ recordKey: string; sha256: string }>;
};

export type CatalogHydrationRecord = {
  recordKey: string;
  sha256: string;
  record: CatalogRecord;
};

type RootBase = {
  schemaVersion: 2;
  rootKey: string;
  identifier: CatalogHydrationIdentifier;
  hydratedAt: string;
};

export type CatalogHydrationRootResult =
  | (RootBase & { status: "unchanged"; graphHash: string })
  | (RootBase & { status: "not-found" })
  | (RootBase & {
      status: "resolved";
      graphHash: string;
      recordKeys: string[];
      records: CatalogHydrationRecord[];
    })
  | (RootBase & {
      status: "error";
      error: { code: string; message: string };
    });

const encoded = (value: string): string =>
  encodeURIComponent(value.trim().toLocaleLowerCase("en-US"));
const entityKey = (namespace: string, id: string): string =>
  encoded(namespace) + ":" + encoded(id);

export const catalogHydrationRootKey = (
  identifier: CatalogHydrationIdentifier,
): string => {
  switch (identifier.type) {
    case "item":
      return "item:" + entityKey(identifier.namespace, identifier.id);
    case "asset":
      return `asset:${[identifier.namespace, identifier.artifactId, identifier.platform].map(encoded).join(":")}`;
    case "release-app":
      return `release-app:${[identifier.namespace, identifier.appId, identifier.platform].map(encoded).join(":")}`;
  }
};

export const catalogRecordKey = (record: CatalogRecord): string => {
  switch (record.type) {
    case "offer":
    case "item":
      return `${record.type}:${entityKey(record.namespace, record.id)}`;
    case "asset":
      return `asset:${[record.namespace, record.artifactId, record.platform, record.itemNamespace, record.itemId].map(encoded).join(":")}`;
    case "release-app":
      return `release-app:${[record.namespace, record.appId, record.platform, record.itemNamespace, record.itemId].map(encoded).join(":")}`;
    case "offer-item":
      return `offer-item:${[record.offerNamespace, record.offerId, record.itemNamespace, record.itemId].map(encoded).join(":")}`;
  }
};

export const stableJson = (value: unknown): string => {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([key, item]) => {
            const normalized = normalize(item);
            return normalized === undefined ? [] : [[key, normalized]];
          }),
      );
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    )
      return candidate;
    return undefined;
  };
  return JSON.stringify(normalize(value));
};

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const graphHashForRecords = (
  records: readonly CatalogHydrationRecord[],
): string =>
  sha256Hex(
    stableJson(
      records
        .map(({ recordKey, sha256 }) => [recordKey, sha256] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
