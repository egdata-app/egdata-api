import { Hono, type Context } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  Changelog,
  Item,
  Offer,
  PriceEngine,
  type PriceEngineType,
  TagModel,
} from "../../models/index.js";
import { resolveChangelogContextSafely } from "../../utils/changelog-context.js";
import { countries, regions } from "../../utils/countries.js";
import { getFeaturedGames } from "../../utils/get-featured-games.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { notFound } from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  countryAndRegion,
  parseStrictQuery,
  regionalParams,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import {
  localizationMeta,
  serializeItem,
  serializeOffer,
  serializeValue,
} from "../serialization.js";

const app = new Hono<{ Variables: V1Variables }>();

const paginationShape = {
  limit: z.string().optional(),
  cursor: z.string().optional(),
};

app.get("/countries", (c) => {
  parseStrictQuery(c, {});
  return jsonSuccess(c, countries, { count: countries.length });
});

app.get("/regions", (c) => {
  parseStrictQuery(c, {});
  return jsonSuccess(c, regions, { count: Object.keys(regions).length });
});

app.get("/region", (c) => {
  const query = parseStrictQuery(c, { country: z.string().optional() });
  const { country } = regionalParams(query);
  const region = countryAndRegion(country).region;
  return jsonSuccess(c, { region: { code: region, ...regions[region] } });
});

app.get("/latest-games", async (c) => {
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);

  const result = await cached(
    v1CacheKey("catalog.latest-games", { region, locale }),
    60,
    async () => {
      const offers = await Offer.find(
        { offerType: { $in: ["BASE_GAME", "DLC", "ADDON"] } },
        undefined,
        { limit: 25, sort: { creationDate: -1 } },
      ).lean();
      const prices = await PriceEngine.find({
        region,
        offerId: { $in: offers.map((offer) => offer.id) },
      }).lean();
      const priceByOfferId = new Map(
        (prices as PriceEngineType[]).map((price) => [price.offerId, price]),
      );
      const localized = await localizeOffers(
        offers.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      );
      return localized.map((offer) =>
        serializeOffer(offer, { price: offer.price }),
      );
    },
  );

  return jsonSuccess(c, result, {
    country,
    region,
    locale,
    count: result.length,
  });
});

app.get("/featured", async (c) => {
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);

  const result = await cached(
    v1CacheKey("catalog.featured", { region, locale }),
    300,
    async () => {
      const featured = await getFeaturedGames();
      if (featured.length === 0) return [];
      const offers = await Offer.find(
        { id: { $in: featured.map((entry) => entry.id) } },
        undefined,
        { sort: { lastModifiedDate: -1 } },
      ).lean();
      const prices = await PriceEngine.find({
        region,
        offerId: { $in: offers.map((offer) => offer.id) },
      }).lean();
      const priceByOfferId = new Map(
        (prices as PriceEngineType[]).map((price) => [price.offerId, price]),
      );
      const localized = await localizeOffers(
        offers.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      );
      return localized.map((offer) =>
        serializeOffer(offer, { price: offer.price }),
      );
    },
  );

  return jsonSuccess(c, result, {
    country,
    region,
    locale,
    count: result.length,
  });
});

app.get("/autocomplete", async (c) => {
  const query = parseStrictQuery(c, {
    query: z.string().min(1).max(200),
    limit: z.string().optional(),
    locale: z.string().optional(),
  });
  const limit = Math.min(Number.parseInt(query.limit || "10", 10) || 10, 10);
  const locale = regionalParams({ locale: query.locale }).locale;
  const search = query.query
    .split(" ")
    .map((part) => `"${part.trim()}"`)
    .join(" | ");

  const result = await cached(
    v1CacheKey("catalog.autocomplete", {
      query: query.query,
      limit,
      locale,
    }),
    60,
    async () => {
      const offers = await Offer.find(
        { $text: { $search: search, $language: "en" } },
        undefined,
        {
          limit,
          collation: { locale: "en", strength: 1 },
          sort: {
            score: { $meta: "textScore" },
            offerType: -1,
            lastModifiedDate: -1,
          },
        },
      ).lean();
      const localized = await localizeOffers(
        offers.map((offer) => orderOffersObject(offer)),
        locale,
      );
      const total = await Offer.countDocuments(
        { $text: { $search: search, $language: "en" } },
        { collation: { locale: "en", strength: 1 } },
      );
      return {
        elements: localized.map((offer) => serializeOffer(offer)),
        total,
      };
    },
  );

  return jsonSuccess(c, result.elements, {
    query: query.query,
    total: result.total,
    locale,
  });
});

const SALES_SORT: MongoSortField[] = [
  { field: "appliedRules.endDate", direction: 1, nulls: "last" },
  { field: "offerId", direction: 1, nulls: "last" },
];

app.get("/sales", async (c) => {
  const query = parseStrictQuery(c, {
    ...paginationShape,
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 30);
  const binding = {
    operation: "catalog.sales",
    filters: {},
    ordering: "appliedRules.endDate:asc,offerId:asc",
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("catalog.sales", { region, locale, limit, cursor }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const filter: Record<string, unknown> = {
        region,
        "price.discount": { $gt: 0 },
        "appliedRules.endDate": { $ne: null },
      };
      if (last) {
        Object.assign(
          filter,
          mongoKeysetFilter(
            SALES_SORT,
            last.map((value, index) =>
              index === 0 && typeof value === "string"
                ? new Date(value)
                : value,
            ) as Array<string | number | null>,
          ),
        );
      }
      const prices = await PriceEngine.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(SALES_SORT),
      }).lean();
      const { items, hasMore } = trimPage(prices as PriceEngineType[], limit);
      const offers = await Offer.find({
        id: { $in: items.map((price) => price.offerId) },
      }).lean();
      const offerById = new Map(offers.map((offer) => [offer.id, offer]));
      const priceByOfferId = new Map(
        items.map((price) => [price.offerId, price]),
      );
      const rows = items
        .map((price) => offerById.get(price.offerId))
        .filter((offer): offer is NonNullable<typeof offer> => Boolean(offer));
      const localized = await localizeOffers(
        rows.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      );
      const lastPrice = items.at(-1);
      return {
        offers: localized.map((offer) =>
          serializeOffer(offer, { price: offer.price }),
        ),
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastPrice
              ? encodeCursor(binding, [
                  lastPrice.appliedRules?.endDate
                    ? new Date(lastPrice.appliedRules.endDate).toISOString()
                    : null,
                  String(lastPrice.offerId),
                ])
              : null,
        },
        localeMeta: localizationMeta(localized[0]),
      };
    },
  );

  return jsonSuccess(c, page.offers, {
    country,
    region,
    locale,
    ...page.localeMeta,
    pagination: page.pagination,
  });
});

app.get("/active-sales", async (c) => {
  const query = parseStrictQuery(c, {
    ...paginationShape,
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 50);
  const sort: MongoSortField[] = [
    { field: "updated", direction: -1, nulls: "last" },
    { field: "id", direction: 1, nulls: "last" },
  ];
  const binding = {
    operation: "catalog.active-sales",
    filters: { group: "active-sales" },
    ordering: "updated:desc,id:asc",
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("catalog.active-sales", { region, locale, limit, cursor }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const filter: Record<string, unknown> = {
        name: { $regex: "(Sale|Savings|Promotion|Deals)", $options: "i" },
        referenceCount: { $gt: 0 },
        id: { $nin: [33639] },
      };
      if (last) {
        Object.assign(
          filter,
          mongoKeysetFilter(
            sort,
            last.map((value, index) =>
              index === 0 && typeof value === "string"
                ? new Date(value)
                : value,
            ) as Array<string | number | null>,
          ),
        );
      }
      const tags = await TagModel.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(sort),
      }).lean();
      const { items: pageTags, hasMore } = trimPage(tags, limit);

      const elements = await Promise.all(
        pageTags.map(async (tag) => {
          const offers = await Offer.find(
            { tags: { $elemMatch: { id: tag.id } } },
            undefined,
            { limit: 200, sort: { lastModifiedDate: -1 } },
          ).lean();
          const prices = await PriceEngine.find({
            region,
            offerId: { $in: offers.map((offer) => offer.id) },
          }).lean();
          const priceByOfferId = new Map(
            (prices as PriceEngineType[]).map((price) => [
              price.offerId,
              price,
            ]),
          );
          const active =
            String(tag.id) === "29899" ||
            (prices.length > 0 &&
              prices.every(
                (price) =>
                  price.price?.discount > 0 || price.price?.originalPrice === 0,
              ));
          const topOffers = offers.slice(0, 3);
          const localized = await localizeOffers(
            topOffers.map((offer) => ({
              ...orderOffersObject(offer),
              price: priceByOfferId.get(offer.id) ?? null,
            })),
            locale,
          );
          return {
            id: String(tag.id),
            name: tag.name ?? null,
            active,
            offers: localized.map((offer) =>
              serializeOffer(offer, { price: offer.price }),
            ),
          };
        }),
      );

      const lastTag = pageTags.at(-1);
      return {
        elements,
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastTag
              ? encodeCursor(binding, [
                  lastTag.updated
                    ? new Date(lastTag.updated).toISOString()
                    : null,
                  typeof lastTag.id === "number"
                    ? lastTag.id
                    : String(lastTag.id),
                ])
              : null,
        },
      };
    },
  );

  return jsonSuccess(c, page.elements, {
    country,
    region,
    locale,
    pagination: page.pagination,
  });
});

app.get("/base-game/:namespace", async (c) => {
  const namespace = c.req.param("namespace");
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);

  const internalNamespaces = [
    "epic",
    "SeaQA",
    "d5241c76f178492ea1540fce45616757",
  ];
  if (internalNamespaces.includes(namespace)) {
    throw notFound(
      "BASE_GAME_NOT_FOUND",
      "No public base game exists for this namespace.",
    );
  }

  const result = await cached(
    v1CacheKey("catalog.base-game", { namespace, region, locale }),
    300,
    async () => {
      let offer = await Offer.findOne({
        namespace: { $eq: namespace },
        offerType: "BASE_GAME",
        prePurchase: { $ne: true },
      }).lean();
      if (!offer) {
        offer = await Offer.findOne({
          namespace: { $eq: namespace },
          offerType: "BASE_GAME",
          prePurchase: true,
        }).lean();
      }
      if (!offer) return null;
      const price = await PriceEngine.findOne(
        { offerId: offer.id, region },
        undefined,
        { sort: { updatedAt: -1 } },
      ).lean();
      const [localized] = await localizeOffers(
        [{ ...orderOffersObject(offer), price }],
        locale,
      );
      return serializeOffer(localized, { price });
    },
  );

  if (!result) {
    throw notFound(
      "BASE_GAME_NOT_FOUND",
      "No base game was found for this namespace.",
    );
  }

  return jsonSuccess(c, result, {
    country,
    region,
    locale: result.locale ?? locale,
  });
});

app.get("/offer-by-slug/:slug", async (c) => {
  const slug = c.req.param("slug");
  const offer = await Offer.findOne(
    { "offerMappings.pageSlug": { $eq: slug } },
    { id: 1, namespace: 1 },
  ).lean();
  if (!offer) {
    throw notFound("OFFER_NOT_FOUND", "No offer uses this page slug.");
  }
  return jsonSuccess(c, {
    id: String(offer.id),
    namespace: offer.namespace ?? null,
  });
});

app.get("/items-from-offer/:id", async (c) => {
  const id = c.req.param("id");
  const items = await cached(
    v1CacheKey("catalog.items-from-offer", { id }),
    300,
    async () => {
      const offer = await Offer.findOne({ id }).lean();
      if (!offer) return [];
      const directItemIds = (offer.items ?? []).map(
        (item: { id: string }) => item.id,
      );
      const subItemDoc = await db.db
        .collection<{ _id: string; subItems: Array<{ id: string }> }>(
          "offersubitems",
        )
        .findOne({ _id: id });
      const subItemIds = (subItemDoc?.subItems ?? []).map((item) => item.id);
      const rows = await Item.find({
        $or: [
          { id: { $in: [...directItemIds, ...subItemIds] } },
          { linkedOffers: id },
        ],
      }).lean();
      const seen = new Set<string>();
      return rows
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
        .map((item) => serializeItem(item));
    },
  );
  return jsonSuccess(c, items, { count: items.length });
});

app.get("/tags", async (c) => {
  const query = parseStrictQuery(c, { group: z.string().optional() });
  const tags = await TagModel.find(
    query.group ? { groupName: query.group } : {},
  ).lean();
  return jsonSuccess(
    c,
    tags.map((tag) => serializeValue(tag)),
    {
      count: tags.length,
      ...(query.group ? { group: query.group } : {}),
    },
  );
});

const CHANGELOG_SORT: MongoSortField[] = [
  { field: "timestamp", direction: -1, nulls: "last" },
  { field: "_id", direction: 1, nulls: "last" },
];

const listChangelog = async (
  c: Context<{ Variables: V1Variables }>,
) => {
  const query = parseStrictQuery(c, paginationShape);
  const { limit, cursor } = parsePagination(query, 50);
  const binding = {
    operation: "catalog.changelog",
    filters: {},
    ordering: "timestamp:desc,_id:asc",
    country: "US",
    locale: "en-US",
    limit,
  };

  const page = await cached(
    v1CacheKey("catalog.changelog", { limit, cursor }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const filter: Record<string, unknown> = {
        "metadata.contextType": { $nin: ["file", "achievements"] },
      };
      if (last) {
        const tuple: Array<string | number | null | Date | ObjectId> = [
          ...last,
        ];
        if (typeof tuple[0] === "string") tuple[0] = new Date(tuple[0]);
        if (typeof tuple[1] === "string" && ObjectId.isValid(tuple[1])) {
          tuple[1] = new ObjectId(tuple[1]);
        }
        Object.assign(
          filter,
          mongoKeysetFilter(
            CHANGELOG_SORT,
            tuple as Array<string | number | null>,
          ),
        );
      }
      const rows = await Changelog.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(CHANGELOG_SORT),
      }).lean();
      const { items, hasMore } = trimPage(rows, limit);
      const elements = await Promise.all(
        items.map(async (change) => {
          const plain = serializeValue(change) as Record<string, any>;
          const context = await resolveChangelogContextSafely(
            change.metadata?.contextType,
            change.metadata?.contextId,
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
      const lastRow = items.at(-1) as Record<string, any> | undefined;
      return {
        elements,
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastRow
              ? encodeCursor(binding, [
                  lastRow.timestamp
                    ? new Date(lastRow.timestamp).toISOString()
                    : null,
                  String(lastRow._id),
                ])
              : null,
        },
      };
    },
  );

  return jsonSuccess(c, page.elements, { pagination: page.pagination });
};

app.get("/changelog", listChangelog);
app.get("/changelist", listChangelog);

app.get("/changelist/:id", async (c) => {
  const id = c.req.param("id");
  const change = await Changelog.findById(id);
  if (!change) {
    throw notFound(
      "CHANGELOG_NOT_FOUND",
      "No catalog change exists with this ID.",
    );
  }
  const plain = serializeValue(change.toObject()) as Record<string, any>;
  const context = await resolveChangelogContextSafely(
    plain.metadata?.contextType,
    plain.metadata?.contextId,
  );
  return jsonSuccess(c, {
    ...plain,
    metadata: { ...(plain.metadata ?? {}), context: serializeValue(context) },
  });
});

export default app;

