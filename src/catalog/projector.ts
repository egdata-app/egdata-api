import type {
  CatalogAssetRecord,
  CatalogCustomAttribute,
  CatalogImage,
  CatalogItemRecord,
  CatalogOfferItemRecord,
  CatalogOfferItemSource,
  CatalogOfferRecord,
  CatalogRecord,
  CatalogReleaseAppRecord,
  CatalogTag,
} from "./types.js";

const MAX_ID = 256;
const MAX_TITLE = 512;
const MAX_PROSE = 64 * 1024;
const MAX_URL = 4 * 1024;
const MAX_ARRAY = 100_000;
const SOURCE_ORDER: Record<CatalogOfferItemSource, number> = {
  direct: 0,
  subitem: 1,
  linked: 2,
};
const OFFER_TYPE_ORDER = new Map([
  ["BASE_GAME", 0],
  ["DLC", 1],
  ["ADD_ON", 2],
  ["EDITION", 3],
  ["BUNDLE", 4],
  ["CONSUMABLE", 5],
]);

export class CatalogProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogProjectionError";
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const slice = (value: string, maximum: number): string =>
  Array.from(value).slice(0, maximum).join("");
const text = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" ? slice(value, maximum) : undefined;
const id = (value: unknown): string | undefined => {
  const result = text(value, MAX_ID);
  return result && result.length > 0 ? result : undefined;
};
const requiredId = (value: unknown, name: string): string => {
  const result = id(value);
  if (!result) throw new CatalogProjectionError(`${name} is invalid`);
  return result;
};
const title = (value: unknown, name: string): string => {
  const result = text(value, MAX_TITLE);
  if (!result) throw new CatalogProjectionError(`${name} is invalid`);
  return result;
};
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const date = (value: unknown): string | undefined => {
  const source = object(value) && "$date" in value ? value["$date"] : value;
  if (
    !(
      source instanceof Date ||
      typeof source === "string" ||
      typeof source === "number"
    )
  )
    return undefined;
  const result = source instanceof Date ? source : new Date(source);
  return Number.isNaN(result.valueOf()) ? undefined : result.toISOString();
};
const array = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_ARRAY)
    throw new CatalogProjectionError(`${name} is oversized`);
  return value;
};
const strings = (value: unknown, maximum: number, name: string): string[] =>
  [
    ...new Set(
      array(value, name).flatMap((entry) => {
        const result = text(entry, maximum);
        return result === undefined ? [] : [result];
      }),
    ),
  ].sort();
const images = (value: unknown, name: string): CatalogImage[] =>
  array(value, name)
    .flatMap((entry): CatalogImage[] => {
      if (!object(entry)) return [];
      const type = text(entry["type"], MAX_TITLE);
      const url = text(entry["url"], MAX_URL);
      if (!type || !url) return [];
      const md5 = id(entry["md5"]);
      return [{ type, url, ...(md5 ? { md5 } : {}) }];
    })
    .sort((left, right) =>
      `${left.type}\0${left.url}`.localeCompare(`${right.type}\0${right.url}`),
    );
const tags = (value: unknown, name: string): CatalogTag[] =>
  array(value, name)
    .flatMap((entry): CatalogTag[] => {
      if (!object(entry)) return [];
      const tagId = id(entry["id"]);
      if (!tagId) return [];
      const tagName = text(entry["name"], MAX_TITLE);
      return [{ id: tagId, ...(tagName ? { name: tagName } : {}) }];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
const attributes = (value: unknown, name: string): CatalogCustomAttribute[] =>
  array(value, name)
    .flatMap((entry): CatalogCustomAttribute[] => {
      if (!object(entry)) return [];
      const key = id(entry["key"]);
      const attributeValue = text(entry["value"], MAX_PROSE);
      if (!key || attributeValue === undefined) return [];
      const type = id(entry["type"]);
      return [{ key, value: attributeValue, ...(type ? { type } : {}) }];
    })
    .sort((left, right) =>
      `${left.key}\0${left.value}`.localeCompare(
        `${right.key}\0${right.value}`,
      ),
    );
const categories = (value: unknown, name: string): string[] =>
  [
    ...new Set(
      array(value, name).flatMap((entry): string[] => {
        if (typeof entry === "string") return [slice(entry, MAX_TITLE)];
        if (!object(entry)) return [];
        const path = text(entry["path"], MAX_TITLE);
        return path ? [path] : [];
      }),
    ),
  ].sort();

export type ProjectedOffer = {
  record: CatalogOfferRecord;
  directItems: Array<{ namespace?: string; id: string }>;
};
export type ProjectedItem = {
  record: CatalogItemRecord;
  linkedOfferIds: string[];
  releaseApps: Array<{
    appId: string;
    platforms: string[];
    releaseId?: string;
  }>;
};

export const projectOffer = (value: unknown): ProjectedOffer => {
  if (!object(value)) throw new CatalogProjectionError("Offer is invalid");
  const namespace = requiredId(value["namespace"], "offer.namespace");
  const offerId = requiredId(value["id"], "offer.id");
  const description = text(value["description"], MAX_PROSE);
  const longDescription = text(value["longDescription"], MAX_PROSE);
  const sellerValue = value["seller"];
  let seller: CatalogOfferRecord["seller"];
  if (object(sellerValue)) {
    const sellerId = id(sellerValue["id"]);
    const sellerName = text(sellerValue["name"], MAX_TITLE);
    if (sellerId && sellerName) seller = { id: sellerId, name: sellerName };
  }
  const optional = <K extends string>(
    key: K,
    value: string | undefined,
  ): Record<K, string> | object =>
    value === undefined ? {} : ({ [key]: value } as Record<K, string>);
  const offerMappings = array(
    value["offerMappings"],
    "offer.offerMappings",
  ).flatMap((entry) => {
    if (!object(entry)) return [];
    const pageSlug = text(entry["pageSlug"], MAX_URL);
    const pageType = id(entry["pageType"]);
    return pageSlug && pageType ? [{ pageSlug, pageType }] : [];
  });
  const directItems = array(value["items"], "offer.items").flatMap((entry) => {
    if (!object(entry)) return [];
    const itemId = id(entry["id"]);
    if (!itemId) return [];
    const itemNamespace = id(entry["namespace"]);
    return [
      { id: itemId, ...(itemNamespace ? { namespace: itemNamespace } : {}) },
    ];
  });
  const record: CatalogOfferRecord = {
    type: "offer",
    namespace,
    id: offerId,
    title: title(value["title"], "offer.title"),
    ...optional("description", description),
    ...optional("longDescription", longDescription),
    ...optional("offerType", id(value["offerType"])),
    ...(seller ? { seller } : {}),
    ...optional(
      "developerDisplayName",
      text(value["developerDisplayName"], MAX_TITLE),
    ),
    ...optional(
      "publisherDisplayName",
      text(value["publisherDisplayName"], MAX_TITLE),
    ),
    ...optional("productSlug", text(value["productSlug"], MAX_URL)),
    ...optional("urlSlug", text(value["urlSlug"], MAX_URL)),
    ...optional("url", text(value["url"], MAX_URL)),
    keyImages: images(value["keyImages"], "offer.keyImages"),
    tags: tags(value["tags"], "offer.tags"),
    categories: strings(value["categories"], MAX_TITLE, "offer.categories"),
    customAttributes: attributes(
      value["customAttributes"],
      "offer.customAttributes",
    ),
    ...optional("effectiveDate", date(value["effectiveDate"])),
    ...optional("creationDate", date(value["creationDate"])),
    ...optional("lastModifiedDate", date(value["lastModifiedDate"])),
    ...optional("releaseDate", date(value["releaseDate"])),
    ...optional("pcReleaseDate", date(value["pcReleaseDate"])),
    ...optional("viewableDate", date(value["viewableDate"])),
    ...(bool(value["prePurchase"]) === undefined
      ? {}
      : { prePurchase: bool(value["prePurchase"]) }),
    ...(bool(value["isCodeRedemptionOnly"]) === undefined
      ? {}
      : { isCodeRedemptionOnly: bool(value["isCodeRedemptionOnly"]) }),
    countriesBlacklist: strings(
      value["countriesBlacklist"],
      MAX_ID,
      "offer.countriesBlacklist",
    ),
    countriesWhitelist: strings(
      value["countriesWhitelist"],
      MAX_ID,
      "offer.countriesWhitelist",
    ),
    ...optional("refundType", id(value["refundType"])),
    offerMappings,
  };
  return { record, directItems };
};

export const projectItem = (value: unknown): ProjectedItem => {
  if (!object(value)) throw new CatalogProjectionError("Item is invalid");
  const namespace = requiredId(value["namespace"], "item.namespace");
  const itemId = requiredId(value["id"], "item.id");
  const optional = <K extends string>(
    key: K,
    entry: string | undefined,
  ): Record<K, string> | object =>
    entry === undefined ? {} : ({ [key]: entry } as Record<K, string>);
  const releaseApps = array(value["releaseInfo"], "item.releaseInfo").flatMap(
    (entry) => {
      if (!object(entry)) return [];
      const appId = id(entry["appId"]);
      if (!appId) return [];
      const releaseId = id(entry["id"]);
      const platforms = strings(
        entry["platform"],
        MAX_ID,
        "item.releaseInfo.platform",
      );
      return [
        {
          appId,
          platforms: platforms.length > 0 ? platforms : ["Unknown"],
          ...(releaseId ? { releaseId } : {}),
        },
      ];
    },
  );
  const flag = (key: string): object =>
    bool(value[key]) === undefined ? {} : { [key]: bool(value[key]) };
  const count = number(value["useCount"]);
  return {
    record: {
      type: "item",
      namespace,
      id: itemId,
      title: title(value["title"], "item.title"),
      ...optional("description", text(value["description"], MAX_PROSE)),
      ...optional("longDescription", text(value["longDescription"], MAX_PROSE)),
      ...optional(
        "technicalDetails",
        text(value["technicalDetails"], MAX_PROSE),
      ),
      ...optional("status", id(value["status"])),
      ...optional("entitlementName", id(value["entitlementName"])),
      ...optional("entitlementType", id(value["entitlementType"])),
      ...optional("itemType", id(value["itemType"])),
      keyImages: images(value["keyImages"], "item.keyImages"),
      categories: categories(value["categories"], "item.categories"),
      customAttributes: attributes(
        value["customAttributes"],
        "item.customAttributes",
      ),
      ...optional("creationDate", date(value["creationDate"])),
      ...optional("lastModifiedDate", date(value["lastModifiedDate"])),
      ...optional("developer", text(value["developer"], MAX_TITLE)),
      ...optional("developerId", id(value["developerId"])),
      eulaIds: strings(value["eulaIds"], MAX_ID, "item.eulaIds"),
      installModes: strings(value["installModes"], MAX_ID, "item.installModes"),
      ...flag("endOfSupport"),
      ...flag("selfRefundable"),
      ...optional("applicationId", id(value["applicationId"])),
      ...flag("unsearchable"),
      ...flag("requiresSecureAccount"),
      ...optional("entitlementStartDate", date(value["entitlementStartDate"])),
      ...optional("entitlementEndDate", date(value["entitlementEndDate"])),
      ...(count === undefined ? {} : { useCount: count }),
    },
    linkedOfferIds: strings(value["linkedOffers"], MAX_ID, "item.linkedOffers"),
    releaseApps,
  };
};

export const projectAsset = (value: unknown): CatalogAssetRecord => {
  if (!object(value)) throw new CatalogProjectionError("Asset is invalid");
  const downloadSizeBytes = number(value["downloadSizeBytes"]);
  const installedSizeBytes = number(value["installedSizeBytes"]);
  const namespace = requiredId(value["namespace"], "asset.namespace");
  return {
    type: "asset",
    namespace,
    artifactId: requiredId(value["artifactId"], "asset.artifactId"),
    platform: requiredId(value["platform"], "asset.platform"),
    itemNamespace: namespace,
    itemId: requiredId(value["itemId"], "asset.itemId"),
    ...(downloadSizeBytes === undefined ? {} : { downloadSizeBytes }),
    ...(installedSizeBytes === undefined ? {} : { installedSizeBytes }),
  };
};

const composite = (namespace: string, value: string): string =>
  `${namespace}\0${value}`;
const edgeKey = (
  offerNamespace: string,
  offerId: string,
  itemNamespace: string,
  itemId: string,
): string => [offerNamespace, offerId, itemNamespace, itemId].join("\0");

export const projectCatalogGraph = (sources: {
  offers: readonly unknown[];
  items: readonly unknown[];
  assets: readonly unknown[];
  subItems: readonly unknown[];
}): CatalogRecord[] => {
  const offers = sources.offers.map(projectOffer);
  const items = sources.items.map(projectItem);
  const assets = sources.assets.map(projectAsset);
  const offersByKey = new Map(
    offers.map((entry) => [
      composite(entry.record.namespace, entry.record.id),
      entry,
    ]),
  );
  const itemsByKey = new Map(
    items.map((entry) => [
      composite(entry.record.namespace, entry.record.id),
      entry,
    ]),
  );
  const offerKeysById = new Map<string, string[]>();
  const itemKeysById = new Map<string, string[]>();
  for (const [key, entry] of offersByKey)
    offerKeysById.set(entry.record.id, [
      ...(offerKeysById.get(entry.record.id) ?? []),
      key,
    ]);
  for (const [key, entry] of itemsByKey)
    itemKeysById.set(entry.record.id, [
      ...(itemKeysById.get(entry.record.id) ?? []),
      key,
    ]);
  const resolve = <T>(
    map: Map<string, T>,
    byId: Map<string, string[]>,
    value: string,
    namespace?: string,
  ): string | undefined => {
    if (namespace && map.has(composite(namespace, value)))
      return composite(namespace, value);
    const matches = byId.get(value) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const observed = new Map<string, Set<CatalogOfferItemSource>>();
  const add = (
    offerKey: string | undefined,
    itemKey: string | undefined,
    source: CatalogOfferItemSource,
  ): void => {
    const offer = offerKey ? offersByKey.get(offerKey) : undefined;
    const item = itemKey ? itemsByKey.get(itemKey) : undefined;
    if (!offer || !item) return;
    const key = edgeKey(
      offer.record.namespace,
      offer.record.id,
      item.record.namespace,
      item.record.id,
    );
    const values = observed.get(key) ?? new Set<CatalogOfferItemSource>();
    values.add(source);
    observed.set(key, values);
  };
  for (const offer of offers) {
    const offerKey = composite(offer.record.namespace, offer.record.id);
    for (const reference of offer.directItems)
      add(
        offerKey,
        resolve(
          itemsByKey,
          itemKeysById,
          reference.id,
          reference.namespace ?? offer.record.namespace,
        ),
        "direct",
      );
  }
  for (const raw of sources.subItems) {
    if (!object(raw)) continue;
    const offerId = id(raw["offerId"]) ?? id(raw["_id"]);
    if (!offerId) continue;
    const offerNamespace = id(raw["offerNamespace"]) ?? id(raw["namespace"]);
    const offerKey = resolve(
      offersByKey,
      offerKeysById,
      offerId,
      offerNamespace,
    );
    const offer = offerKey ? offersByKey.get(offerKey) : undefined;
    for (const entry of array(raw["subItems"], "offersubitems.subItems")) {
      if (!object(entry)) continue;
      const itemId = id(entry["id"]);
      if (itemId)
        add(
          offerKey,
          resolve(
            itemsByKey,
            itemKeysById,
            itemId,
            id(entry["namespace"]) ?? offer?.record.namespace,
          ),
          "subitem",
        );
    }
  }
  for (const item of items) {
    const itemKey = composite(item.record.namespace, item.record.id);
    for (const offerId of item.linkedOfferIds)
      add(
        resolve(offersByKey, offerKeysById, offerId, item.record.namespace),
        itemKey,
        "linked",
      );
  }
  const edges: CatalogOfferItemRecord[] = [...observed].map(([key, values]) => {
    const [offerNamespace = "", offerId = "", itemNamespace = "", itemId = ""] =
      key.split("\0");
    return {
      type: "offer-item",
      offerNamespace,
      offerId,
      itemNamespace,
      itemId,
      sources: [...values].sort((a, b) => SOURCE_ORDER[a] - SOURCE_ORDER[b]),
      isPrimary: false,
    };
  });
  const byItem = new Map<string, CatalogOfferItemRecord[]>();
  for (const edge of edges)
    byItem.set(composite(edge.itemNamespace, edge.itemId), [
      ...(byItem.get(composite(edge.itemNamespace, edge.itemId)) ?? []),
      edge,
    ]);
  const primary = new Map<string, { namespace: string; id: string }>();
  for (const [itemKey, itemEdges] of byItem) {
    itemEdges.sort((left, right) => {
      const a = offersByKey.get(
        composite(left.offerNamespace, left.offerId),
      )?.record;
      const b = offersByKey.get(
        composite(right.offerNamespace, right.offerId),
      )?.record;
      if (!a || !b) return left.offerId.localeCompare(right.offerId);
      return (
        Number(a.prePurchase === true) - Number(b.prePurchase === true) ||
        SOURCE_ORDER[left.sources[0] ?? "linked"] -
          SOURCE_ORDER[right.sources[0] ?? "linked"] ||
        (OFFER_TYPE_ORDER.get((a.offerType ?? "").toUpperCase()) ?? 99) -
          (OFFER_TYPE_ORDER.get((b.offerType ?? "").toUpperCase()) ?? 99) ||
        (b.lastModifiedDate ?? "").localeCompare(a.lastModifiedDate ?? "") ||
        composite(left.offerNamespace, left.offerId).localeCompare(
          composite(right.offerNamespace, right.offerId),
        )
      );
    });
    const winner = itemEdges[0];
    if (winner) {
      winner.isPrimary = true;
      primary.set(itemKey, {
        namespace: winner.offerNamespace,
        id: winner.offerId,
      });
    }
  }
  const withPrimary = <
    T extends CatalogItemRecord | CatalogAssetRecord | CatalogReleaseAppRecord,
  >(
    record: T,
    key: string,
  ): T => {
    const winner = primary.get(key);
    return winner
      ? {
          ...record,
          primaryOfferNamespace: winner.namespace,
          primaryOfferId: winner.id,
        }
      : record;
  };
  const itemRecords = items.map(({ record }) =>
    withPrimary(record, composite(record.namespace, record.id)),
  );
  const assetRecords = assets.map((record) =>
    withPrimary(record, composite(record.itemNamespace, record.itemId)),
  );
  const apps = new Map<string, CatalogReleaseAppRecord>();
  for (const item of items)
    for (const release of item.releaseApps)
      for (const platform of release.platforms) {
        const record = withPrimary<CatalogReleaseAppRecord>(
          {
            type: "release-app",
            namespace: item.record.namespace,
            appId: release.appId,
            platform,
            itemNamespace: item.record.namespace,
            itemId: item.record.id,
            ...(release.releaseId ? { releaseId: release.releaseId } : {}),
          },
          composite(item.record.namespace, item.record.id),
        );
        apps.set(
          [record.namespace, record.appId, record.platform, record.itemId].join(
            "\0",
          ),
          record,
        );
      }
  return [
    ...offers.map(({ record }) => record),
    ...itemRecords,
    ...assetRecords,
    ...apps.values(),
    ...edges,
  ];
};
