import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { db } from "../../db/index.js";
import { Asset, Item, Offer, PriceEngine } from "../../models/index.js";
import {
  type BuildDocument,
  buildSummary,
  effectiveBuildPlatform,
} from "../../utils/builds.js";
import {
  localizeOffer,
  localizeOffers,
} from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import {
  badRequest,
  notFound,
  ProblemError,
  problemResponse,
} from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  parseStrictQuery,
  querySchema,
  readJsonBody,
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
import { currentPrice, offerCountryEligible } from "../services/offers.js";

type AnyRecord = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const ITEM_LIST_ORDERING = "lastModifiedDate:desc,id:asc";
const ITEM_LIST_SORT: MongoSortField[] = [
  { field: "lastModifiedDate", direction: -1, nulls: "last" },
  { field: "id", direction: 1, nulls: "last" },
];

const CHANGELOG_ORDERING = "timestamp:desc,_id:desc";
const CHANGELOG_SORT: MongoSortField[] = [
  { field: "timestamp", direction: -1, nulls: "last" },
  { field: "_id", direction: -1, nulls: "last" },
];

// Items are global catalog documents, so their cursors bind no region or
// locale. The values are still part of the signed binding for consistency with
// the other v1 paginated operations.
const ITEM_CURSOR_SCOPE = { country: "", locale: "" };

const BULK_MAX_ITEMS = 100;
const BULK_MAX_ID_LENGTH = 200;

const OFFER_TYPE_RANK: Record<string, number> = {
  BASE_GAME: 0,
  DLC: 1,
  ADD_ON: 2,
  ADDON: 2,
  EDITION: 3,
  BUNDLE: 4,
  CONSUMABLE: 5,
};

const rankOffer = (offer: AnyRecord): number => {
  const type = `${offer.offerType ?? ""}`.toUpperCase();
  const typeRank = OFFER_TYPE_RANK[type] ?? 99;
  const prePurchaseRank = offer.prePurchase === true ? 1 : 0;
  return prePurchaseRank * 100 + typeRank;
};

const itemCursorTuple = (item: AnyRecord): Array<string | number | null> => [
  isoOrNull(item.lastModifiedDate),
  typeof item.id === "string" ? item.id : null,
];

const itemKeysetFilter = (
  last: Array<string | number | null>,
): Record<string, any> => {
  const tuple: any[] = last.map((value, index) =>
    index === 0 && typeof value === "string" ? new Date(value) : value,
  );
  return mongoKeysetFilter(ITEM_LIST_SORT, tuple);
};

const changelogKeysetFilter = (
  last: Array<string | number | null>,
): Record<string, any> => {
  const [timestamp, objectId] = last;
  const timestampValue =
    typeof timestamp === "string" ? new Date(timestamp) : (timestamp ?? null);
  const objectIdValue =
    typeof objectId === "string" && ObjectId.isValid(objectId)
      ? new ObjectId(objectId)
      : objectId;
  const tuple: any[] = [timestampValue, objectIdValue];
  return mongoKeysetFilter(CHANGELOG_SORT, tuple);
};

function parseBulkBody(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(
      "INVALID_BODY",
      "The request body must be a JSON object with an `items` array of strings.",
      [
        {
          pointer: "",
          code: "INVALID",
          message: "Expected an object.",
        },
      ],
    );
  }

  const record = body as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => key !== "items");
  if (unexpected.length > 0) {
    throw badRequest(
      "INVALID_BODY",
      `The request body contains unsupported field(s): ${unexpected.join(", ")}.`,
      unexpected.map((key) => ({
        pointer: `/${key}`,
        code: "UNKNOWN_FIELD",
        message: `The \`${key}\` field is not supported.`,
      })),
    );
  }

  const rawItems = record.items;
  if (!Array.isArray(rawItems)) {
    throw badRequest(
      "INVALID_BODY",
      "The `items` field must be an array of item identifiers.",
      [
        {
          pointer: "/items",
          code: "INVALID",
          message: "Expected an array of strings.",
        },
      ],
    );
  }

  if (rawItems.length > BULK_MAX_ITEMS) {
    throw badRequest(
      "BULK_LIMIT_EXCEEDED",
      `At most ${BULK_MAX_ITEMS} item identifiers can be resolved per request.`,
      [
        {
          pointer: "/items",
          code: "TOO_MANY_ITEMS",
          message: `The array contains ${rawItems.length} entries; the maximum is ${BULK_MAX_ITEMS}.`,
        },
      ],
    );
  }

  const ids: string[] = [];
  for (const [index, value] of rawItems.entries()) {
    if (typeof value !== "string") {
      throw badRequest(
        "INVALID_BODY",
        "Every entry in `items` must be a string.",
        [
          {
            pointer: `/items/${index}`,
            code: "INVALID",
            message: "Expected a string.",
          },
        ],
      );
    }
    const id = value.trim();
    if (id.length === 0 || id.length > BULK_MAX_ID_LENGTH) {
      throw badRequest(
        "INVALID_BODY",
        `Item identifiers must contain between 1 and ${BULK_MAX_ID_LENGTH} characters.`,
        [
          {
            pointer: `/items/${index}`,
            code: "INVALID",
            message:
              "Expected a non-empty identifier of at most 200 characters.",
          },
        ],
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }

  return ids;
}

app.get("/items", async (c) => {
  const query = parseStrictQuery(c, querySchema.pagination);
  const { limit, cursor } = parsePagination(query);
  const cursorBinding = {
    operation: "items.list",
    filters: {},
    ordering: ITEM_LIST_ORDERING,
    ...ITEM_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("items.list", { limit, cursor }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const filter = last ? itemKeysetFilter(last) : {};
      const rows = await Item.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(ITEM_LIST_SORT),
      }).lean();

      const { items, hasMore } = trimPage(rows, limit);
      const data = items.map((item) => serializeItem(item));
      const lastItem = items.at(-1);

      return {
        data,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastItem
            ? encodeCursor(cursorBinding, itemCursorTuple(lastItem))
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

app.get("/items/:id", async (c) => {
  parseStrictQuery(c, {});
  const id = requireIdParam(c);

  const item = await cached(v1CacheKey("items.get", { id }), 300, async () => {
    const doc = await Item.findOne({
      $or: [{ _id: { $eq: id } }, { id: { $eq: id } }],
    }).lean();
    return doc ? serializeItem(doc) : null;
  });

  if (!item) {
    throw notFound("ITEM_NOT_FOUND", `No item matches '${id}'.`);
  }

  return jsonSuccess(c, item);
});

app.get("/items/:id/assets", async (c) => {
  parseStrictQuery(c, {});
  const id = requireIdParam(c);

  const assets = await cached(
    v1CacheKey("items.assets", { id }),
    300,
    async () => {
      const rows = await Asset.find({ itemId: id }).lean();
      return rows.map((asset) => serializeValue(asset));
    },
  );

  return jsonSuccess(c, assets, { count: assets.length });
});

app.get("/items/:id/builds", async (c) => {
  parseStrictQuery(c, {});
  const id = requireIdParam(c);

  const builds = await cached(
    v1CacheKey("items.builds", { id }),
    120,
    async () => {
      const item = await Item.findOne({ id: { $eq: id } }).lean();
      if (!item) return null;

      const appNames = Array.isArray(item.releaseInfo)
        ? item.releaseInfo
            .map((release: { appId?: unknown }) => release?.appId)
            .filter(
              (appId: unknown): appId is string => typeof appId === "string",
            )
        : [];
      if (appNames.length === 0) return [];

      const rows = await db.db
        .collection<BuildDocument>("builds")
        .find({ appName: { $in: appNames } })
        .toArray();

      const summaries = await Promise.all(
        rows.map(async (build) => {
          const asset = await Asset.findOne({
            artifactId: { $eq: build.appName },
            platform: { $eq: effectiveBuildPlatform(build) },
          }).lean();
          return serializeValue(buildSummary(build, asset));
        }),
      );

      return summaries;
    },
  );

  if (builds === null) {
    throw notFound("ITEM_NOT_FOUND", `No item matches '${id}'.`);
  }

  return jsonSuccess(c, builds, { count: builds.length });
});

app.get("/items/:id/changelog", async (c) => {
  const query = parseStrictQuery(c, querySchema.pagination);
  const { limit, cursor } = parsePagination(query);
  const id = requireIdParam(c);
  const cursorBinding = {
    operation: "items.changelog",
    filters: { id },
    ordering: CHANGELOG_ORDERING,
    ...ITEM_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("items.changelog", { id, limit, cursor }),
    60,
    async () => {
      const item = await Item.findOne({ id: { $eq: id } }).lean();
      if (!item) return null;

      const assets = await Asset.find({ itemId: id }).lean();
      const assetIds = assets
        .map((asset) => asset.artifactId)
        .filter(
          (artifactId: unknown): artifactId is string =>
            typeof artifactId === "string",
        );

      const builds =
        assetIds.length === 0
          ? []
          : await db.db
              .collection("builds")
              .find({ appName: { $in: assetIds } })
              .toArray();

      const buildIds = builds.map((build) => build._id.toString());
      const contextIds = [id, ...assetIds, ...buildIds];

      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const baseMatch = { "metadata.contextId": { $in: contextIds } };
      const match = last
        ? { $and: [baseMatch, changelogKeysetFilter(last)] }
        : baseMatch;

      const rows = await db.db
        .collection("changelogs_v2")
        .aggregate([
          { $match: match },
          { $sort: mongoSortSpec(CHANGELOG_SORT) },
          { $limit: limit + 1 },
          {
            $lookup: {
              from: "items",
              let: { contextId: "$metadata.contextId" },
              pipeline: [
                { $match: { $expr: { $eq: ["$id", "$$contextId"] } } },
              ],
              as: "itemDoc",
            },
          },
          {
            $lookup: {
              from: "assets",
              let: { contextId: "$metadata.contextId" },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ["$artifactId", "$$contextId"] },
                  },
                },
              ],
              as: "assetDoc",
            },
          },
          {
            $lookup: {
              from: "builds",
              let: { contextId: "$metadata.contextId" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: [{ $toString: "$_id" }, "$$contextId"],
                    },
                  },
                },
              ],
              as: "buildDoc",
            },
          },
          {
            $addFields: {
              document: {
                $switch: {
                  branches: [
                    {
                      case: {
                        $eq: ["$metadata.contextType", "item"],
                      },
                      // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch branches use a then field.
                      then: { $arrayElemAt: ["$itemDoc", 0] },
                    },
                    {
                      case: {
                        $eq: ["$metadata.contextType", "asset"],
                      },
                      // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch branches use a then field.
                      then: { $arrayElemAt: ["$assetDoc", 0] },
                    },
                    {
                      case: {
                        $eq: ["$metadata.contextType", "build"],
                      },
                      // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch branches use a then field.
                      then: { $arrayElemAt: ["$buildDoc", 0] },
                    },
                  ],
                  default: null,
                },
              },
            },
          },
          {
            $project: {
              _id: 1,
              metadata: 1,
              timestamp: 1,
              document: 1,
            },
          },
        ])
        .toArray();

      const { items, hasMore } = trimPage(rows, limit);
      const data = items.map((row) => serializeValue(row));
      const lastItem = items.at(-1);

      return {
        data,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastItem
            ? encodeCursor(cursorBinding, [
                isoOrNull(lastItem.timestamp),
                lastItem._id ? String(lastItem._id) : null,
              ])
            : null,
        ),
      };
    },
  );

  if (result === null) {
    throw notFound("ITEM_NOT_FOUND", `No item matches '${id}'.`);
  }

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    pagination: result.pagination,
  });
});

app.get("/items/:id/offer", async (c) => {
  const query = parseStrictQuery(c, querySchema.regional);
  const { country, region, locale } = regionalParams(query);
  const id = requireIdParam(c);

  const result = await cached(
    v1CacheKey("items.offer", { id, region, locale }),
    60,
    async () => {
      const item = await Item.findOne({ id: { $eq: id } }).lean();
      if (!item) return { status: "item_not_found" as const };

      const subItems = await db.db
        .collection<{ _id: string }>("offersubitems")
        .find({ "subItems.id": id }, { projection: { _id: 1 } })
        .toArray();

      const offers = await Offer.find({
        id: { $in: subItems.map((subItem) => subItem._id) },
        offerType: "BASE_GAME",
      }).lean();

      const eligible = offers.filter((offer) =>
        offerCountryEligible(offer, country),
      );
      const selected =
        eligible.length === 1
          ? eligible[0]
          : (eligible.find((offer) => offer.prePurchase !== true) ?? null);

      if (!selected) return { status: "offer_not_found" as const };

      const price = await currentPrice(selected.id, region);
      const localized = await localizeOffer(
        orderOffersObject(selected),
        locale,
      );

      return {
        status: "ok" as const,
        offer: serializeOffer(localized, { price }),
        localization: localizationMeta(localized),
      };
    },
  );

  if (result.status === "item_not_found") {
    throw notFound("ITEM_NOT_FOUND", `No item matches '${id}'.`);
  }
  if (result.status === "offer_not_found") {
    throw notFound(
      "ITEM_OFFER_NOT_FOUND",
      `No base-game offer is available for item '${id}' in ${country}.`,
    );
  }

  return jsonSuccess(c, result.offer, {
    country,
    region,
    locale,
    ...result.localization,
  });
});

app.post("/items/bulk", async (c) => {
  parseStrictQuery(c, {});
  const body = await readJsonBody(c);
  const ids = parseBulkBody(body);

  const result = await cached(
    v1CacheKey("items.bulk", { ids }),
    60,
    async () => {
      const docs =
        ids.length === 0 ? [] : await Item.find({ id: { $in: ids } }).lean();
      const byId = new Map<string, AnyRecord>();
      for (const doc of docs) {
        if (typeof doc.id === "string") byId.set(doc.id, serializeItem(doc));
      }
      const data = ids
        .map((id) => byId.get(id))
        .filter((item): item is AnyRecord => Boolean(item));
      const missing = ids.filter((id) => !byId.has(id));
      return { data, missing };
    },
  );

  return jsonSuccess(c, result.data, {
    requested: ids.length,
    found: result.data.length,
    missing: result.missing,
  });
});

app.post("/items/bulk/offers", async (c) => {
  const query = parseStrictQuery(c, querySchema.regional);
  const { country, region, locale } = regionalParams(query);
  const body = await readJsonBody(c);
  const ids = parseBulkBody(body);

  const result = await cached(
    v1CacheKey("items.bulkOffers", { ids, country, region, locale }),
    60,
    async () => {
      if (ids.length === 0) {
        return { data: {} as Record<string, AnyRecord | null>, found: 0 };
      }

      const directOffers = await Offer.find({
        "items.id": { $in: ids },
      }).lean();

      const subItems = await db.db
        .collection<{ _id: string; subItems: Array<{ id: string }> }>(
          "offersubitems",
        )
        .find(
          { "subItems.id": { $in: ids } },
          { projection: { _id: 1, subItems: 1 } },
        )
        .toArray();

      const subItemOfferIds = subItems.map((subItem) => subItem._id);
      const subItemOffers =
        subItemOfferIds.length === 0
          ? []
          : await Offer.find({ id: { $in: subItemOfferIds } }).lean();
      const subItemOffersById = new Map(
        subItemOffers.map((offer) => [offer.id, offer]),
      );

      const candidatesByItem = new Map<string, AnyRecord[]>();
      const addCandidate = (itemId: string, offer: AnyRecord) => {
        const candidates = candidatesByItem.get(itemId) ?? [];
        candidates.push(offer);
        candidatesByItem.set(itemId, candidates);
      };

      for (const offer of directOffers) {
        for (const item of offer.items ?? []) {
          if (typeof item?.id === "string" && ids.includes(item.id)) {
            addCandidate(item.id, offer);
          }
        }
      }

      for (const subItem of subItems) {
        const offer = subItemOffersById.get(subItem._id);
        if (!offer) continue;
        for (const item of subItem.subItems ?? []) {
          if (typeof item?.id === "string" && ids.includes(item.id)) {
            addCandidate(item.id, offer);
          }
        }
      }

      const entries = ids.map((id) => {
        const candidates = (candidatesByItem.get(id) ?? []).filter((offer) =>
          offerCountryEligible(offer, country),
        );
        candidates.sort((a, b) => rankOffer(a) - rankOffer(b));
        return [id, candidates[0] ?? null] as const;
      });

      const selected = entries
        .map(([, offer]) => offer)
        .filter((offer): offer is AnyRecord => Boolean(offer));

      const prices =
        selected.length === 0
          ? []
          : await PriceEngine.find({
              offerId: { $in: selected.map((offer) => offer.id) },
              region,
            }).lean();
      const priceByOfferId = new Map(
        prices.map((price) => [price.offerId, price]),
      );

      const localized = await localizeOffers(
        selected.map((offer) => orderOffersObject(offer)),
        locale,
      );
      const localizedById = new Map(
        localized.map((offer) => [offer.id, offer]),
      );

      const data: Record<string, AnyRecord | null> = {};
      for (const [itemId, offer] of entries) {
        if (!offer) {
          data[itemId] = null;
          continue;
        }
        const localizedOffer = localizedById.get(offer.id) ?? offer;
        data[itemId] = serializeOffer(localizedOffer, {
          price: priceByOfferId.get(offer.id) ?? null,
        });
      }

      return { data, found: selected.length };
    },
  );

  return jsonSuccess(c, result.data, {
    requested: ids.length,
    found: result.found,
    country,
    region,
    locale,
  });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
