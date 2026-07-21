import type { Db, Document, Filter } from "mongodb";
import {
  CATALOG_HYDRATION_MAX_ROOT_RECORDS,
  type CatalogHydrationIdentifier,
  type CatalogHydrationRecord,
  type CatalogHydrationRequest,
  type CatalogHydrationRootResult,
  catalogHydrationRootKey,
  catalogRecordKey,
  graphHashForRecords,
  sha256Hex,
  stableJson,
} from "./hydration.js";
import { projectCatalogGraph } from "./projector.js";

const QUERY_LIMIT = 600;
const safeError = {
  code: "CATALOG_ROOT_RESOLUTION_FAILED",
  message: "This catalog root could not be hydrated.",
} as const;

const value = (document: Document, key: string): string | undefined =>
  typeof document[key] === "string" ? document[key] : undefined;
const asArray = (candidate: unknown): unknown[] =>
  Array.isArray(candidate) ? candidate : [];
const asDocument = (candidate: unknown): Document | undefined =>
  candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Document)
    : undefined;

const itemIdentity = (
  document: Document,
): { namespace: string; id: string } | null => {
  const namespace = value(document, "namespace");
  const id = value(document, "id");
  return namespace && id ? { namespace, id } : null;
};

const findOwner = async (
  database: Db,
  identifier: CatalogHydrationIdentifier,
): Promise<Document | null> => {
  if (identifier.type === "item") {
    return database.collection("items").findOne({
      namespace: identifier.namespace,
      id: identifier.id,
    });
  }
  if (identifier.type === "asset") {
    const asset = await database.collection("assets").findOne({
      namespace: identifier.namespace,
      artifactId: identifier.artifactId,
      platform: identifier.platform,
    });
    const itemId = asset && value(asset, "itemId");
    if (!itemId) return null;
    return database.collection("items").findOne({
      namespace: identifier.namespace,
      id: itemId,
    });
  }
  return database.collection("items").findOne({
    namespace: identifier.namespace,
    releaseInfo: {
      $elemMatch: {
        appId: identifier.appId,
        platform: identifier.platform,
      },
    },
  });
};

const findLimited = async (
  database: Db,
  collection: string,
  filter: Filter<Document>,
): Promise<Document[]> =>
  database.collection(collection).find(filter).limit(QUERY_LIMIT).toArray();

const collectItemReferences = (
  offers: readonly Document[],
  subItems: readonly Document[],
): Array<{ namespace?: string; id: string }> => {
  const result = new Map<string, { namespace?: string; id: string }>();
  const add = (candidate: unknown, fallbackNamespace?: string): void => {
    const document = asDocument(candidate);
    const id = document && value(document, "id");
    if (!id) return;
    const namespace = value(document, "namespace") ?? fallbackNamespace;
    result.set(`${namespace ?? ""}\0${id}`, {
      id,
      ...(namespace ? { namespace } : {}),
    });
  };
  for (const offer of offers) {
    const namespace = value(offer, "namespace");
    for (const candidate of asArray(offer["items"])) add(candidate, namespace);
  }
  for (const relation of subItems) {
    const namespace =
      value(relation, "namespace") ?? value(relation, "offerNamespace");
    for (const candidate of asArray(relation["subItems"]))
      add(candidate, namespace);
  }
  return [...result.values()];
};

const resolveRecords = async (
  database: Db,
  owner: Document,
): Promise<CatalogHydrationRecord[]> => {
  const identity = itemIdentity(owner);
  if (!identity) throw new Error("Owner item is invalid");
  const linkedOfferIds = asArray(owner["linkedOffers"]).filter(
    (entry): entry is string => typeof entry === "string",
  );
  const directOffers = await findLimited(database, "offers", {
    $or: [
      {
        items: {
          $elemMatch: { id: identity.id, namespace: identity.namespace },
        },
      },
      {
        namespace: identity.namespace,
        items: {
          $elemMatch: { id: identity.id, namespace: { $exists: false } },
        },
      },
    ],
  });
  const ownerSubItems = await findLimited(database, "offersubitems", {
    "subItems.id": identity.id,
  });
  const observedOfferIds = new Set(linkedOfferIds);
  for (const offer of directOffers) {
    const offerId = value(offer, "id");
    if (offerId) observedOfferIds.add(offerId);
  }
  for (const relation of ownerSubItems) {
    const offerId = value(relation, "offerId") ?? value(relation, "_id");
    if (offerId) observedOfferIds.add(offerId);
  }

  const offerIds = [...observedOfferIds];
  const relatedOffers =
    offerIds.length === 0
      ? []
      : await findLimited(database, "offers", {
          id: { $in: offerIds },
        });
  const offersByIdentity = new Map<string, Document>();
  for (const offer of [...directOffers, ...relatedOffers]) {
    const namespace = value(offer, "namespace");
    const offerId = value(offer, "id");
    if (
      namespace &&
      offerId &&
      (namespace === identity.namespace || directOffers.includes(offer))
    ) {
      offersByIdentity.set(`${namespace}\0${offerId}`, offer);
    }
  }
  const offers = [...offersByIdentity.values()];
  const selectedOfferIds = offers.flatMap((offer) => {
    const offerId = value(offer, "id");
    return offerId ? [offerId] : [];
  });
  const subItems =
    selectedOfferIds.length === 0
      ? []
      : await findLimited(database, "offersubitems", {
          $or: [
            { _id: { $in: selectedOfferIds as never[] } },
            { offerId: { $in: selectedOfferIds } },
          ],
        });
  const references = collectItemReferences(offers, subItems);
  references.push(identity);
  const siblingIds = [...new Set(references.map((entry) => entry.id))];
  const linkedItems =
    selectedOfferIds.length === 0
      ? []
      : await findLimited(database, "items", {
          namespace: identity.namespace,
          linkedOffers: { $in: selectedOfferIds },
        });
  const referencedItems = await findLimited(database, "items", {
    id: { $in: siblingIds },
  });
  const itemsByIdentity = new Map<string, Document>();
  for (const item of [owner, ...referencedItems, ...linkedItems]) {
    const itemIdentityValue = itemIdentity(item);
    if (!itemIdentityValue) continue;
    const explicitlyReferenced = references.some(
      (reference) =>
        reference.id === itemIdentityValue.id &&
        (!reference.namespace ||
          reference.namespace === itemIdentityValue.namespace),
    );
    const linked = asArray(item["linkedOffers"]).some(
      (entry) => typeof entry === "string" && selectedOfferIds.includes(entry),
    );
    if (explicitlyReferenced || linked) {
      itemsByIdentity.set(
        `${itemIdentityValue.namespace}\0${itemIdentityValue.id}`,
        item,
      );
    }
  }
  const items = [...itemsByIdentity.values()];
  const itemFilters = items.flatMap((item) => {
    const candidate = itemIdentity(item);
    return candidate
      ? [{ namespace: candidate.namespace, itemId: candidate.id }]
      : [];
  });
  const assets =
    itemFilters.length === 0
      ? []
      : await findLimited(database, "assets", { $or: itemFilters });

  const projected = projectCatalogGraph({ offers, items, assets, subItems });
  const unique = new Map<string, CatalogHydrationRecord>();
  for (const record of projected) {
    const recordKey = catalogRecordKey(record);
    unique.set(recordKey, {
      recordKey,
      sha256: sha256Hex(stableJson(record)),
      record,
    });
  }
  if (unique.size > CATALOG_HYDRATION_MAX_ROOT_RECORDS) {
    throw new Error("Root exceeds record limit");
  }
  return [...unique.values()].sort((left, right) =>
    left.recordKey.localeCompare(right.recordKey),
  );
};

export class MongoCatalogHydrationResolver {
  constructor(private readonly database: Db) {}

  async resolve(
    identifier: CatalogHydrationIdentifier,
    request: CatalogHydrationRequest,
  ): Promise<CatalogHydrationRootResult> {
    const rootKey = catalogHydrationRootKey(identifier);
    const hydratedAt = new Date().toISOString();
    try {
      const owner = await findOwner(this.database, identifier);
      if (!owner) {
        return {
          schemaVersion: 2,
          rootKey,
          identifier,
          hydratedAt,
          status: "not-found",
        };
      }
      const records = await resolveRecords(this.database, owner);
      const graphHash = graphHashForRecords(records);
      const knownRoot = request.knownRoots.find(
        (entry) => entry.rootKey === rootKey,
      );
      if (knownRoot?.graphHash === graphHash) {
        return {
          schemaVersion: 2,
          rootKey,
          identifier,
          hydratedAt,
          status: "unchanged",
          graphHash,
        };
      }
      const knownRecords = new Map(
        request.knownRecords.map((entry) => [entry.recordKey, entry.sha256]),
      );
      return {
        schemaVersion: 2,
        rootKey,
        identifier,
        hydratedAt,
        status: "resolved",
        graphHash,
        recordKeys: records.map((entry) => entry.recordKey),
        records: records.filter(
          (entry) => knownRecords.get(entry.recordKey) !== entry.sha256,
        ),
      };
    } catch {
      return {
        schemaVersion: 2,
        rootKey,
        identifier,
        hydratedAt,
        status: "error",
        error: safeError,
      };
    }
  }
}

export const ensureCatalogHydrationIndexes = async (
  database: Db,
): Promise<void> => {
  await Promise.all([
    database
      .collection("items")
      .createIndex({ namespace: 1, id: 1 }, { name: "catalog_item_identity" }),
    database
      .collection("offers")
      .createIndex({ namespace: 1, id: 1 }, { name: "catalog_offer_identity" }),
    database
      .collection("assets")
      .createIndex(
        { namespace: 1, artifactId: 1, platform: 1 },
        { name: "catalog_asset_identity" },
      ),
    database
      .collection("assets")
      .createIndex(
        { namespace: 1, itemId: 1 },
        { name: "catalog_asset_owner" },
      ),
    database
      .collection("offersubitems")
      .createIndex({ "subItems.id": 1 }, { name: "catalog_subitem_item" }),
  ]);
};
