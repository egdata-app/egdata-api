import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  AchievementSet,
  Asset,
  Build,
  Item,
  Namespace,
  Offer,
  PriceEngine,
  Sandbox,
} from "../../models/index.js";
import { type BuildDocument, buildSummary } from "../../utils/builds.js";
import { resolveChangelogContextSafely } from "../../utils/changelog-context.js";
import {
  localizeOffer,
  localizeOffers,
} from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { notFound, ProblemError, problemResponse } from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  parseCsv,
  parseStrictQuery,
  querySchema,
  regionalParams,
  requireIdParam,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import {
  isoOrNull,
  localizationMeta,
  serializeItem,
  serializeOffer,
  serializeValue,
} from "../serialization.js";

type AnyRecord = Record<string, any>;
/** MongoDB query document; field conditions are assembled per operation. */
type MongoFilter = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const LIST_TTL_SECONDS = 60;
const DETAIL_TTL_SECONDS = 300;
const ASSET_TTL_SECONDS = 300;
const CHANGELOG_CONTEXT_TTL_SECONDS = 300;
const CHANGELOG_CONTEXT_LIMIT = 100;

// Sandboxes, items, assets, changelogs, and builds are global catalog data, so
// their cursors bind no region or locale. The empty values still participate in
// the signed cursor binding for consistency with the other v1 operations.
const GLOBAL_CURSOR_SCOPE = { country: "", locale: "" };

const SANDBOX_LIST_SORT: MongoSortField[] = [
  { field: "_id", direction: 1, nulls: "last" },
];
const SANDBOX_ITEM_SORT: MongoSortField[] = [
  { field: "lastModifiedDate", direction: -1, nulls: "last" },
  { field: "id", direction: 1, nulls: "last" },
];
const SANDBOX_OFFER_SORT: MongoSortField[] = [
  { field: "lastModifiedDate", direction: -1, nulls: "last" },
  { field: "id", direction: 1, nulls: "last" },
];
const SANDBOX_CHANGELOG_SORT: MongoSortField[] = [
  { field: "timestamp", direction: -1, nulls: "last" },
  { field: "_id", direction: -1, nulls: "last" },
];
const SANDBOX_BUILD_SORT: MongoSortField[] = [
  { field: "updatedAt", direction: -1, nulls: "last" },
  { field: "_id", direction: -1, nulls: "last" },
];

const SANDBOX_LIST_ORDERING = "_id:asc";
const SANDBOX_ITEM_ORDERING = "lastModifiedDate:desc,id:asc";
const SANDBOX_OFFER_ORDERING = "lastModifiedDate:desc,id:asc";
const SANDBOX_ASSET_ORDERING = "updatedAt:desc,artifactId:asc,platform:asc";
const SANDBOX_CHANGELOG_ORDERING = "timestamp:desc,_id:desc";
const SANDBOX_BUILD_ORDERING = "updatedAt:desc,_id:desc";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const uniqueStrings = (values: unknown[]): string[] => [
  ...new Set(values.filter(isString)),
];

/**
 * `mongoKeysetFilter` accepts MongoDB scalars such as `Date` and `ObjectId`
 * even though its tuple type is declared for JSON cursor values.
 */
const keysetFilter = (sort: MongoSortField[], tuple: unknown[]): MongoFilter =>
  mongoKeysetFilter(sort, tuple as Array<string | number | null>);

const cursorDate = (value: string | number | null): Date | null => {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const cursorObjectId = (
  value: string | number | null,
): ObjectId | string | number | null => {
  if (typeof value !== "string") return value;
  return ObjectId.isValid(value) ? new ObjectId(value) : value;
};

async function findSandboxDocument(sandboxId: string): Promise<{
  document: unknown;
  source: "sandbox" | "namespace";
} | null> {
  const sandbox = await Sandbox.findOne({ _id: { $eq: sandboxId } }).lean();
  if (sandbox) {
    return { document: serializeValue(sandbox), source: "sandbox" };
  }
  const namespace = await Namespace.findOne({ _id: { $eq: sandboxId } }).lean();
  if (!namespace) return null;
  return { document: serializeValue(namespace), source: "namespace" };
}

async function requireSandbox(sandboxId: string): Promise<void> {
  const sandbox = await Sandbox.findOne(
    { _id: { $eq: sandboxId } },
    { _id: 1 },
  ).lean();
  if (sandbox) return;
  const namespace = await Namespace.findOne(
    { _id: { $eq: sandboxId } },
    { _id: 1 },
  ).lean();
  if (!namespace) {
    throw notFound("SANDBOX_NOT_FOUND", `No sandbox matches '${sandboxId}'.`);
  }
}

/** Merged asset row sort tuple, ordered by `updatedAt` descending. */
type AssetTuple = [string | null, string | null, string | null];

const assetTuple = (asset: AnyRecord): AssetTuple => [
  isoOrNull(asset.updatedAt),
  typeof asset.artifactId === "string" ? asset.artifactId : null,
  typeof asset.platform === "string" ? asset.platform : null,
];

const compareStrings = (left: string, right: string): number => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const compareTupleValue = (
  left: string | null,
  right: string | null,
  direction: 1 | -1,
): number => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === 1
    ? compareStrings(left, right)
    : -compareStrings(left, right);
};

const compareAssetTuples = (left: AssetTuple, right: AssetTuple): number =>
  compareTupleValue(left[0], right[0], -1) ||
  compareTupleValue(left[1], right[1], 1) ||
  compareTupleValue(left[2], right[2], 1);

const assetCursorTuple = (last: Array<string | number | null>): AssetTuple => [
  typeof last[0] === "string" ? last[0] : null,
  typeof last[1] === "string" ? last[1] : null,
  typeof last[2] === "string" ? last[2] : null,
];

async function mergedSandboxAssets(
  sandboxId: string,
  platforms: string[] | undefined,
): Promise<AnyRecord[]> {
  const [items, realAssets] = await Promise.all([
    Item.find(
      { namespace: { $eq: sandboxId } },
      { id: 1, namespace: 1, releaseInfo: 1, title: 1 },
    ).lean(),
    Asset.find({ namespace: { $eq: sandboxId } }).lean(),
  ]);

  const storedArtifacts = new Set(
    realAssets
      .map((asset) => asset.artifactId)
      .filter((artifactId): artifactId is string => isString(artifactId)),
  );

  const merged: AnyRecord[] = [...realAssets];
  for (const item of items) {
    const releases = Array.isArray(item.releaseInfo) ? item.releaseInfo : [];
    for (const release of releases) {
      const appId = isString(release?.appId) ? release.appId : null;
      if (!appId || storedArtifacts.has(appId)) continue;
      const releasePlatforms = Array.isArray(release.platform)
        ? release.platform
        : [];
      for (const platform of releasePlatforms) {
        if (!isString(platform)) continue;
        merged.push({
          artifactId: appId,
          downloadSizeBytes: 0,
          installedSizeBytes: 0,
          itemId: item.id ?? null,
          namespace: item.namespace ?? sandboxId,
          platform,
          // The legacy route generated a random ObjectId per request, which
          // cannot survive cursor pagination. A deterministic identifier keeps
          // synthetic assets stable across pages and cache entries.
          _id: `virtual:${String(item.id)}:${appId}:${platform}`,
          title: item.title ?? null,
          updatedAt: new Date(0),
        });
      }
    }
  }

  const serialized = merged.map((asset) => serializeValue(asset) as AnyRecord);
  const filtered = platforms
    ? serialized.filter((asset) => platforms.includes(String(asset.platform)))
    : serialized;

  return filtered.sort((left, right) =>
    compareAssetTuples(assetTuple(left), assetTuple(right)),
  );
}

async function changelogContextIds(sandboxId: string): Promise<string[]> {
  const offers = await db.db
    .collection("offers")
    .find({ namespace: sandboxId }, { projection: { id: 1, items: 1 } })
    .sort({ lastModifiedDate: -1 })
    .limit(CHANGELOG_CONTEXT_LIMIT)
    .toArray();

  const offerItemIds = offers.flatMap((offer) =>
    Array.isArray(offer.items)
      ? offer.items
          .map((entry: AnyRecord) => entry?.id)
          .filter((id: unknown): id is string => isString(id))
      : [],
  );

  const items = await Item.find(
    {
      $or: [{ id: { $in: offerItemIds } }, { namespace: { $eq: sandboxId } }],
    },
    { id: 1, namespace: 1, releaseInfo: 1 },
    {
      sort: { lastModifiedDate: -1 },
      limit: CHANGELOG_CONTEXT_LIMIT,
    },
  ).lean();

  const itemIds = items
    .map((item) => item.id)
    .filter((id): id is string => isString(id));
  const assets =
    itemIds.length === 0
      ? []
      : await Asset.find(
          { itemId: { $in: itemIds } },
          { artifactId: 1 },
        ).lean();

  const appIds = uniqueStrings(
    items.flatMap((item) =>
      Array.isArray(item.releaseInfo)
        ? item.releaseInfo.map((release: AnyRecord) => release?.appId)
        : [],
    ),
  );
  const builds =
    appIds.length === 0
      ? []
      : await db.db
          .collection("builds")
          .find({ appName: { $in: appIds } }, { projection: { _id: 1 } })
          .toArray();

  return uniqueStrings([
    sandboxId,
    ...offers.map((offer) => offer.id),
    ...itemIds,
    ...assets.map((asset) => asset.artifactId),
    ...builds.map((build) => String(build._id)),
  ]);
}

app.get("/sandboxes", async (c) => {
  const query = parseStrictQuery(c, querySchema.pagination);
  const { limit, cursor } = parsePagination(query);
  const cursorBinding = {
    operation: "sandboxes.list",
    filters: {},
    ordering: SANDBOX_LIST_ORDERING,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("sandboxes.list", { limit, cursor }),
    LIST_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const filter = last
        ? keysetFilter(SANDBOX_LIST_SORT, [last[0] ?? null])
        : {};
      const rows = await Namespace.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(SANDBOX_LIST_SORT),
      }).lean();

      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items.at(-1);
      return {
        data: items.map((row) => serializeValue(row)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(cursorBinding, [String(lastRow._id)])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    pagination: result.pagination,
  });
});

app.get("/sandboxes/:sandboxId", async (c) => {
  parseStrictQuery(c, {});
  const sandboxId = requireIdParam(c, "sandboxId");

  const result = await cached<{
    document: unknown;
    source: "sandbox" | "namespace";
  } | null>(
    v1CacheKey("sandboxes.detail", { sandboxId }),
    DETAIL_TTL_SECONDS,
    async () => findSandboxDocument(sandboxId),
  );

  if (!result) {
    throw notFound("SANDBOX_NOT_FOUND", `No sandbox matches '${sandboxId}'.`);
  }

  return jsonSuccess(c, result.document, { source: result.source });
});

app.get("/sandboxes/:sandboxId/items", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    entitlementType: z.string().max(500).optional(),
    status: z.string().max(500).optional(),
    platforms: z.string().max(500).optional(),
    title: z.string().max(200).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const entitlementType = parseCsv(query.entitlementType);
  const status = parseCsv(query.status);
  const platforms = parseCsv(query.platforms);
  const title = query.title?.trim() || null;
  const cursorBinding = {
    operation: "sandboxes.items",
    filters: {
      sandboxId,
      entitlementType: entitlementType ?? null,
      status: status ?? null,
      platforms: platforms ?? null,
      title,
    },
    ordering: SANDBOX_ITEM_ORDERING,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  await requireSandbox(sandboxId);

  const result = await cached(
    v1CacheKey("sandboxes.items", {
      sandboxId,
      entitlementType,
      status,
      platforms,
      title,
      limit,
      cursor,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const filter: MongoFilter = { namespace: sandboxId };
      if (entitlementType) filter.entitlementType = { $in: entitlementType };
      if (status) filter.status = { $in: status };
      if (platforms) {
        filter.releaseInfo = {
          $elemMatch: { platform: { $in: platforms } },
        };
      }
      if (title) {
        filter.title = { $regex: escapeRegex(title), $options: "i" };
      }
      const conditions: MongoFilter[] = [filter];
      if (last) {
        conditions.push(
          keysetFilter(SANDBOX_ITEM_SORT, [
            cursorDate(last[0] ?? null),
            last[1] ?? null,
          ]),
        );
      }
      const rows = await Item.find(
        conditions.length === 1 ? filter : { $and: conditions },
        undefined,
        {
          limit: limit + 1,
          sort: mongoSortSpec(SANDBOX_ITEM_SORT),
        },
      ).lean();

      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items.at(-1);
      return {
        data: items.map((item) => serializeItem(item)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(cursorBinding, [
                isoOrNull(lastRow.lastModifiedDate),
                isString(lastRow.id) ? lastRow.id : null,
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    pagination: result.pagination,
  });
});

app.get("/sandboxes/:sandboxId/offers", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    ...querySchema.regional,
    offerType: z.string().max(500).optional(),
    title: z.string().max(200).optional(),
  });
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query);
  const offerType = parseCsv(query.offerType);
  const title = query.title?.trim() || null;
  const cursorBinding = {
    operation: "sandboxes.offers",
    filters: {
      sandboxId,
      offerType: offerType ?? null,
      title,
    },
    ordering: SANDBOX_OFFER_ORDERING,
    country,
    locale,
    limit,
  };

  await requireSandbox(sandboxId);

  const result = await cached(
    v1CacheKey("sandboxes.offers", {
      sandboxId,
      offerType,
      title,
      region,
      locale,
      limit,
      cursor,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const filter: MongoFilter = { namespace: sandboxId };
      if (offerType) filter.offerType = { $in: offerType };
      if (title) {
        filter.title = { $regex: escapeRegex(title), $options: "i" };
      }
      const conditions: MongoFilter[] = [filter];
      if (last) {
        conditions.push(
          keysetFilter(SANDBOX_OFFER_SORT, [
            cursorDate(last[0] ?? null),
            last[1] ?? null,
          ]),
        );
      }
      const offers = await Offer.find(
        conditions.length === 1 ? filter : { $and: conditions },
        undefined,
        {
          limit: limit + 1,
          sort: mongoSortSpec(SANDBOX_OFFER_SORT),
        },
      ).lean();

      const { items, hasMore } = trimPage(offers, limit);
      const offerIds = items
        .map((offer) => offer.id)
        .filter((id): id is string => isString(id));
      const prices =
        offerIds.length === 0
          ? []
          : await PriceEngine.find({
              offerId: { $in: offerIds },
              region,
            }).lean();
      const priceByOfferId = new Map(
        prices.map((price) => [price.offerId, price]),
      );
      const localized = await localizeOffers(
        items.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      );
      const lastOffer = items.at(-1);

      return {
        offers: localized.map((offer) =>
          serializeOffer(offer, { price: offer.price }),
        ),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastOffer
            ? encodeCursor(cursorBinding, [
                isoOrNull(lastOffer.lastModifiedDate),
                isString(lastOffer.id) ? lastOffer.id : null,
              ])
            : null,
        ),
        localization: localizationMeta(localized[0]),
      };
    },
  );

  return jsonSuccess(c, result.offers, {
    count: result.offers.length,
    country,
    region,
    locale: result.localization.locale ?? locale,
    ...result.localization,
    pagination: result.pagination,
  });
});

app.get("/sandboxes/:sandboxId/assets", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    platform: z.string().max(500).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const platforms = parseCsv(query.platform);
  const cursorBinding = {
    operation: "sandboxes.assets",
    filters: { sandboxId, platforms: platforms ?? null },
    ordering: SANDBOX_ASSET_ORDERING,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  await requireSandbox(sandboxId);

  const assets = await cached(
    v1CacheKey("sandboxes.assets", { sandboxId, platforms }),
    ASSET_TTL_SECONDS,
    async () => mergedSandboxAssets(sandboxId, platforms),
  );

  const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
  const cursorTuple = last ? assetCursorTuple(last) : null;
  const rows = cursorTuple
    ? assets.filter(
        (asset) => compareAssetTuples(assetTuple(asset), cursorTuple) > 0,
      )
    : assets;
  const { items, hasMore } = trimPage(rows, limit);
  const lastAsset = items.at(-1);

  return jsonSuccess(c, items, {
    count: items.length,
    pagination: pageMeta(
      limit,
      hasMore,
      hasMore && lastAsset
        ? encodeCursor(cursorBinding, [...assetTuple(lastAsset)])
        : null,
    ),
  });
});

type BaseGameResult =
  | {
      kind: "offer";
      data: unknown;
      localization: Record<string, unknown>;
    }
  | {
      kind: "item";
      data: unknown;
      localization: Record<string, unknown>;
    }
  | { kind: "missing" };

app.get("/sandboxes/:sandboxId/base-game", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  const query = parseStrictQuery(c, querySchema.regional);
  const { country, region, locale } = regionalParams(query);

  await requireSandbox(sandboxId);

  const result = await cached<BaseGameResult>(
    v1CacheKey("sandboxes.base-game", { sandboxId, region, locale }),
    LIST_TTL_SECONDS,
    async (): Promise<BaseGameResult> => {
      const baseGame =
        (await Offer.findOne(
          {
            namespace: { $eq: sandboxId },
            offerType: "BASE_GAME",
            prePurchase: { $ne: true },
            isCodeRedemptionOnly: false,
          },
          undefined,
          { sort: { creationDate: 1, id: 1 } },
        ).lean()) ??
        (await Offer.findOne(
          {
            namespace: { $eq: sandboxId },
            offerType: "BASE_GAME",
            prePurchase: true,
          },
          undefined,
          { sort: { creationDate: 1, id: 1 } },
        ).lean());

      if (baseGame) {
        const price = await PriceEngine.findOne(
          { offerId: { $eq: baseGame.id }, region },
          undefined,
          { sort: { updatedAt: -1 } },
        ).lean();
        const localized = await localizeOffer(
          orderOffersObject(baseGame),
          locale,
        );
        return {
          kind: "offer",
          data: serializeOffer(localized, { price }),
          localization: localizationMeta(localized),
        };
      }

      const executableItem = await Item.findOne(
        {
          namespace: { $eq: sandboxId },
          entitlementType: "EXECUTABLE",
          "releaseInfo.0": { $exists: true },
        },
        undefined,
        { sort: { creationDate: 1, id: 1 } },
      ).lean();
      if (!executableItem) return { kind: "missing" };

      return {
        kind: "item",
        data: { ...serializeItem(executableItem), isItem: true },
        localization: {},
      };
    },
  );

  if (result.kind === "missing") {
    throw notFound(
      "BASE_GAME_NOT_FOUND",
      `No base game is available for sandbox '${sandboxId}'.`,
    );
  }

  return jsonSuccess(c, result.data, {
    country,
    region,
    locale,
    isItem: result.kind === "item",
    ...result.localization,
  });
});

app.get("/sandboxes/:sandboxId/achievements", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  parseStrictQuery(c, {});

  await requireSandbox(sandboxId);

  const achievements = await cached(
    v1CacheKey("sandboxes.achievements", { sandboxId }),
    DETAIL_TTL_SECONDS,
    async () => {
      const rows = await AchievementSet.find({
        sandboxId: { $eq: sandboxId },
      }).lean();
      return rows.map((row) => serializeValue(row));
    },
  );

  return jsonSuccess(c, achievements, { count: achievements.length });
});

app.get("/sandboxes/:sandboxId/changelog", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  const query = parseStrictQuery(c, querySchema.pagination);
  const { limit, cursor } = parsePagination(query);
  const cursorBinding = {
    operation: "sandboxes.changelog",
    filters: { sandboxId },
    ordering: SANDBOX_CHANGELOG_ORDERING,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  await requireSandbox(sandboxId);

  const result = await cached(
    v1CacheKey("sandboxes.changelog", { sandboxId, limit, cursor }),
    LIST_TTL_SECONDS,
    async () => {
      const contextIds = await cached(
        v1CacheKey("sandboxes.changelog.context", { sandboxId }),
        CHANGELOG_CONTEXT_TTL_SECONDS,
        async () => changelogContextIds(sandboxId),
      );
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const baseMatch = { "metadata.contextId": { $in: contextIds } };
      const match = last
        ? {
            $and: [
              baseMatch,
              keysetFilter(SANDBOX_CHANGELOG_SORT, [
                cursorDate(last[0] ?? null),
                cursorObjectId(last[1] ?? null),
              ]),
            ],
          }
        : baseMatch;

      const rows = await db.db
        .collection("changelogs_v2")
        .aggregate([
          { $match: match },
          { $sort: mongoSortSpec(SANDBOX_CHANGELOG_SORT) },
          { $limit: limit + 1 },
          { $project: { _id: 1, metadata: 1, timestamp: 1 } },
        ])
        .toArray();

      const { items, hasMore } = trimPage(rows, limit);
      const hits = await Promise.all(
        items.map(async (row) => {
          const plain = serializeValue(row) as AnyRecord;
          const context = await resolveChangelogContextSafely(
            plain.metadata?.contextType,
            plain.metadata?.contextId,
          );
          return {
            ...plain,
            metadata: {
              ...(plain.metadata ?? {}),
              context: serializeValue(context),
            },
          };
        }),
      );
      const lastRow = items.at(-1);

      return {
        hits,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(cursorBinding, [
                isoOrNull(lastRow.timestamp),
                lastRow._id ? String(lastRow._id) : null,
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(
    c,
    { hits: result.hits },
    {
      count: result.hits.length,
      pagination: result.pagination,
    },
  );
});

app.get("/sandboxes/:sandboxId/builds", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    platform: z.string().max(500).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const platforms = parseCsv(query.platform);
  const cursorBinding = {
    operation: "sandboxes.builds",
    filters: { sandboxId, platforms: platforms ?? null },
    ordering: SANDBOX_BUILD_ORDERING,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  await requireSandbox(sandboxId);

  const result = await cached(
    v1CacheKey("sandboxes.builds", { sandboxId, platforms, limit, cursor }),
    LIST_TTL_SECONDS,
    async () => {
      const itemFilter: MongoFilter = { namespace: sandboxId };
      if (platforms) {
        itemFilter.releaseInfo = {
          $elemMatch: { platform: { $in: platforms } },
        };
      }
      const items = await Item.find(itemFilter, { releaseInfo: 1 }).lean();
      const appIds = uniqueStrings(
        items.flatMap((item) =>
          Array.isArray(item.releaseInfo)
            ? item.releaseInfo.map((release: AnyRecord) => release?.appId)
            : [],
        ),
      );
      const filter: MongoFilter = { appName: { $in: appIds } };
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const conditions: MongoFilter[] = [filter];
      if (last) {
        conditions.push(
          keysetFilter(SANDBOX_BUILD_SORT, [
            cursorDate(last[0] ?? null),
            cursorObjectId(last[1] ?? null),
          ]),
        );
      }
      const builds = await db.db
        .collection<BuildDocument>("builds")
        .find(conditions.length === 1 ? filter : { $and: conditions })
        .sort(mongoSortSpec(SANDBOX_BUILD_SORT))
        .limit(limit + 1)
        .toArray();

      const { items: pageItems, hasMore } = trimPage(builds, limit);
      const lastBuild = pageItems.at(-1);
      return {
        data: pageItems.map((build) => serializeValue(buildSummary(build))),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastBuild
            ? encodeCursor(cursorBinding, [
                isoOrNull(lastBuild.updatedAt),
                String(lastBuild._id),
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    pagination: result.pagination,
  });
});

app.get("/sandboxes/:sandboxId/stats", async (c) => {
  const sandboxId = requireIdParam(c, "sandboxId");
  parseStrictQuery(c, {});

  await requireSandbox(sandboxId);

  const stats = await cached(
    v1CacheKey("sandboxes.stats", { sandboxId }),
    DETAIL_TTL_SECONDS,
    async () => {
      const [offers, items, achievementSets, assets] = await Promise.all([
        Offer.countDocuments({ namespace: { $eq: sandboxId } }),
        Item.find({ namespace: { $eq: sandboxId } }, { releaseInfo: 1 }).lean(),
        AchievementSet.find({ sandboxId: { $eq: sandboxId } }).lean(),
        Asset.find({ namespace: { $eq: sandboxId } }, { artifactId: 1 }).lean(),
      ]);

      const storedArtifacts = new Set(
        assets
          .map((asset) => asset.artifactId)
          .filter((artifactId): artifactId is string => isString(artifactId)),
      );
      const appIds: string[] = [];
      let virtualAssets = 0;
      for (const item of items) {
        const releases = Array.isArray(item.releaseInfo)
          ? item.releaseInfo
          : [];
        for (const release of releases) {
          const appId = isString(release?.appId) ? release.appId : null;
          if (!appId) continue;
          appIds.push(appId);
          if (storedArtifacts.has(appId)) continue;
          virtualAssets += Array.isArray(release.platform)
            ? release.platform.length
            : 0;
        }
      }

      const builds = await Build.countDocuments({
        appName: { $in: uniqueStrings(appIds) },
      });

      return {
        offers,
        items: items.length,
        assets: assets.length + virtualAssets,
        builds,
        achievements: achievementSets.flatMap((set) =>
          Array.isArray(set.achievements) ? set.achievements : [],
        ).length,
      };
    },
  );

  return jsonSuccess(c, stats);
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
