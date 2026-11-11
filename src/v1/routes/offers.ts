import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  AchievementSet,
  GamePosition,
  Offer,
  PriceEngine,
  type PriceEngineType,
  TagModel,
} from "../../models/index.js";
import { getImage } from "../../utils/get-image.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { badRequest, notFound } from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  parsePagination,
  trimPage,
} from "../pagination.js";
import { parseStrictQuery, readJsonBody, regionalParams } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import { serializeOffer, serializeValue } from "../serialization.js";
import { getOffer, listOffers } from "../services/offers.js";

const app = new Hono<{ Variables: V1Variables }>();

const listShape = {
  limit: z.string().optional(),
  cursor: z.string().optional(),
  country: z.string().optional(),
  locale: z.string().optional(),
};

app.get("/offers", async (c) => {
  const query = parseStrictQuery(c, listShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query);

  const result = await listOffers({
    country,
    region,
    locale,
    limit,
    cursor,
  });

  return jsonSuccess(c, result.offers, {
    country,
    region,
    locale: result.localization.locale ?? locale,
    ...result.localization,
    pagination: result.pagination,
  });
});

app.get("/offers/events", async (c) => {
  parseStrictQuery(c, {});
  const events = await TagModel.find({
    groupName: "event",
    status: "ACTIVE",
  }).lean();
  return jsonSuccess(
    c,
    events.map((event) => serializeValue(event)),
    {
      count: events.length,
    },
  );
});

app.get("/offers/events/:id", async (c) => {
  const id = c.req.param("id");
  const query = parseStrictQuery(c, listShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 50);
  const binding = {
    operation: "offers.event",
    filters: { event: id },
    ordering: "price.discount:desc,id:asc",
    country,
    locale,
    limit,
  };

  const event = await TagModel.findOne({ id, groupName: "event" }).lean();
  if (!event) {
    throw notFound("EVENT_NOT_FOUND", "No active event exists with this ID.");
  }

  const page = await cached(
    v1CacheKey("offers.event", { id, region, locale, limit, cursor }),
    60,
    async () => {
      const pipeline: Record<string, unknown>[] = [
        { $match: { tags: { $elemMatch: { id } } } },
        {
          $lookup: {
            from: "pricev2",
            let: { offerId: "$id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$offerId", "$$offerId"] },
                      { $eq: ["$region", region] },
                    ],
                  },
                },
              },
              { $sort: { updatedAt: -1 } },
              { $limit: 1 },
            ],
            as: "price",
          },
        },
        {
          $unwind: {
            path: "$price",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $addFields: {
            sortDiscount: { $ifNull: ["$price.price.discount", null] },
          },
        },
      ];

      if (cursor) {
        const last = decodeCursor(cursor, binding);
        const discount = last[0];
        const lastId = String(last[1] ?? "");
        pipeline.push({
          $match:
            discount === null
              ? { sortDiscount: null, id: { $gt: lastId } }
              : {
                  $or: [
                    { sortDiscount: { $lt: discount } },
                    { sortDiscount: discount, id: { $gt: lastId } },
                    { sortDiscount: null },
                  ],
                },
        });
      }

      pipeline.push(
        { $sort: { sortDiscount: -1, id: 1 } },
        { $limit: limit + 1 },
      );

      const rows = (await Offer.aggregate(pipeline).exec()) as Array<
        Record<string, any>
      >;
      const { items, hasMore } = trimPage(rows, limit);
      const localized = await localizeOffers(
        items.map((row) => ({
          ...orderOffersObject(row),
          price: row.price ?? null,
        })),
        locale,
      );
      const lastRow = items.at(-1);
      return {
        elements: localized.map((offer) =>
          serializeOffer(offer, { price: offer.price }),
        ),
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastRow
              ? encodeCursor(binding, [
                  lastRow.sortDiscount ?? null,
                  String(lastRow.id),
                ])
              : null,
        },
        title: String(event.name ?? ""),
      };
    },
  );

  return jsonSuccess(c, page.elements, {
    country,
    region,
    locale,
    title: page.title,
    pagination: page.pagination,
  });
});

app.get("/offers/upcoming", async (c) => {
  const query = parseStrictQuery(c, listShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 50);
  const sort: MongoSortField[] = [
    { field: "releaseDate", direction: 1, nulls: "last" },
    { field: "id", direction: 1, nulls: "last" },
  ];
  const binding = {
    operation: "offers.upcoming",
    filters: {},
    ordering: "releaseDate:asc,id:asc",
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("offers.upcoming", { region, locale, limit, cursor }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const filter: Record<string, unknown> = {
        releaseDate: {
          $gt: new Date(),
          $ne: null,
          $lt: new Date("2099-01-01"),
        },
        offerType: { $in: ["BASE_GAME", "DLC"] },
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
      const offers = await Offer.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(sort),
      }).lean();
      const { items, hasMore } = trimPage(offers, limit);
      const prices = await PriceEngine.find({
        region,
        offerId: { $in: items.map((offer) => offer.id) },
      }).lean();
      const priceByOfferId = new Map(
        (prices as PriceEngineType[]).map((price) => [price.offerId, price]),
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
        elements: localized.map((offer) =>
          serializeOffer(offer, { price: offer.price }),
        ),
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastOffer
              ? encodeCursor(binding, [
                  lastOffer.releaseDate
                    ? new Date(lastOffer.releaseDate).toISOString()
                    : null,
                  String(lastOffer.id),
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

app.get("/offers/genres", async (c) => {
  const query = parseStrictQuery(c, { locale: z.string().optional() });
  const { locale } = regionalParams({ locale: query.locale });
  const genres = await TagModel.find({
    groupName: "genre",
    status: "ACTIVE",
  }).lean();

  const result = await Promise.all(
    genres.map(async (genre) => {
      const offers = await Offer.find(
        {
          tags: { $elemMatch: { id: genre.id } },
          offerType: "BASE_GAME",
          releaseDate: { $lte: new Date() },
        },
        undefined,
        { limit: 3, sort: { releaseDate: -1 } },
      ).lean();
      const localized = await localizeOffers(
        offers.map((offer) => ({
          id: offer.id,
          namespace: offer.namespace,
          title: offer.title,
          image: getImage(offer.keyImages ?? [], [
            "OfferImageTall",
            "Thumbnail",
            "DieselGameBoxTall",
            "DieselStoreFrontTall",
          ]),
        })),
        locale,
      );
      return {
        genre: serializeValue(genre),
        offers: localized.map(({ namespace: _namespace, ...offer }) =>
          serializeValue(offer),
        ),
      };
    }),
  );

  return jsonSuccess(c, result, { locale, count: result.length });
});

const topCollection = (collectionId: "top-wishlisted" | "top-sellers") => {
  const sort: MongoSortField[] = [
    { field: "position", direction: 1, nulls: "last" },
    { field: "offerId", direction: 1, nulls: "last" },
  ];

  return async (c: Context<{ Variables: V1Variables }>) => {
    const query = parseStrictQuery(c, {
      locale: z.string().optional(),
      limit: z.string().optional(),
      cursor: z.string().optional(),
    });
    const { locale } = regionalParams({ locale: query.locale });
    const { limit, cursor } = parsePagination(query, 10);
    const binding = {
      operation: `offers.${collectionId}`,
      filters: { collectionId },
      ordering: "position:asc,offerId:asc",
      country: "US",
      locale,
      limit,
    };

    const page = await cached(
      v1CacheKey(`offers.${collectionId}`, { locale, limit, cursor }),
      300,
      async () => {
        const last = cursor ? decodeCursor(cursor, binding) : null;
        const filter: Record<string, unknown> = {
          collectionId,
          position: { $gt: 0 },
        };
        if (last) {
          Object.assign(filter, mongoKeysetFilter(sort, last));
        }
        const positions = await GamePosition.find(filter, undefined, {
          limit: limit + 1,
          sort: mongoSortSpec(sort),
        }).lean();
        const { items, hasMore } = trimPage(positions, limit);
        const offers = await Offer.find({
          id: { $in: items.map((entry) => entry.offerId) },
        }).lean();
        const offerById = new Map(offers.map((offer) => [offer.id, offer]));
        const positionByOfferId = new Map(
          items.map((entry) => [String(entry.offerId), entry.position]),
        );
        const rows = items
          .map((entry) => offerById.get(entry.offerId))
          .filter((offer): offer is NonNullable<typeof offer> =>
            Boolean(offer),
          );
        const localized = await localizeOffers(
          rows.map((offer) => orderOffersObject(offer)),
          locale,
        );
        const lastPosition = items.at(-1);
        return {
          elements: localized.map((offer) => ({
            ...serializeOffer(offer),
            position: positionByOfferId.get(String(offer.id)) ?? null,
          })),
          pagination: {
            limit,
            hasMore,
            nextCursor:
              hasMore && lastPosition
                ? encodeCursor(binding, [
                    Number(lastPosition.position),
                    String(lastPosition.offerId),
                  ])
                : null,
          },
        };
      },
    );

    return jsonSuccess(c, page.elements, {
      locale,
      pagination: page.pagination,
    });
  };
};

app.get("/offers/top-wishlisted", topCollection("top-wishlisted"));
app.get("/offers/top-sellers", topCollection("top-sellers"));

app.get("/offers/featured-discounts", async (c) => {
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);

  const result = await cached(
    v1CacheKey("offers.featured-discounts", { region, locale }),
    60,
    async () => {
      const featuredOffers = await GamePosition.find(
        { position: { $gt: 0 } },
        undefined,
        { limit: 200, sort: { position: 1 } },
      ).lean();
      if (featuredOffers.length === 0) return [];
      const offerIds = featuredOffers.map((entry) => entry.offerId);
      const [offers, prices] = await Promise.all([
        Offer.find({
          id: { $in: offerIds },
          offerType: { $in: ["BASE_GAME", "DLC"] },
        }).lean(),
        PriceEngine.find({
          offerId: { $in: offerIds },
          region,
          "price.discount": { $gt: 0 },
        }).lean(),
      ]);
      const priceMap = new Map(
        (prices as PriceEngineType[]).map((price) => [price.offerId, price]),
      );
      const positionMap = new Map(
        featuredOffers.map((entry) => [String(entry.offerId), entry.position]),
      );
      const matching = offers
        .filter(
          (offer) =>
            priceMap.has(offer.id) && positionMap.has(String(offer.id)),
        )
        .sort(
          (a, b) =>
            (positionMap.get(String(a.id)) ?? 0) -
            (positionMap.get(String(b.id)) ?? 0),
        )
        .slice(0, 20);
      const localized = await localizeOffers(
        matching.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceMap.get(offer.id) ?? null,
        })),
        locale,
      );
      return localized.map((offer) => ({
        ...serializeOffer(offer, { price: offer.price }),
        position: positionMap.get(String(offer.id)) ?? null,
      }));
    },
  );

  return jsonSuccess(c, result, {
    country,
    region,
    locale,
    count: result.length,
  });
});

app.get("/offers/latest-achievements", async (c) => {
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);

  const result = await cached(
    v1CacheKey("offers.latest-achievements", { region, locale }),
    60,
    async () => {
      const pageSize = 15;
      let skip = 0;
      let iterations = 0;
      const collected: Array<{
        offer: Record<string, any>;
        achievements: unknown;
        price: PriceEngineType | null;
      }> = [];

      while (collected.length < 20 && iterations < 10) {
        iterations++;
        const offers = await Offer.find(
          {
            offerType: { $in: ["BASE_GAME"] },
            "tags.id": "19847",
            effectiveDate: { $lte: new Date() },
          },
          undefined,
          { sort: { effectiveDate: -1 }, skip, limit: pageSize },
        ).lean();
        const [achievementsData, pricesData] = await Promise.allSettled([
          AchievementSet.find({
            sandboxId: { $in: offers.map((offer) => offer.namespace) },
            isBase: true,
          }).lean(),
          PriceEngine.find({
            offerId: { $in: offers.map((offer) => offer.id) },
            region,
          }).lean(),
        ]);
        const achievements =
          achievementsData.status === "fulfilled" ? achievementsData.value : [];
        const prices =
          pricesData.status === "fulfilled" ? pricesData.value : [];
        const priceByOfferId = new Map(
          (prices as PriceEngineType[]).map((price) => [price.offerId, price]),
        );
        for (const offer of offers) {
          const achievement = achievements.find(
            (entry) => entry.sandboxId === offer.namespace,
          );
          if (!achievement) continue;
          collected.push({
            offer,
            achievements: achievement,
            price: priceByOfferId.get(offer.id) ?? null,
          });
          if (collected.length >= 20) break;
        }
        skip += pageSize;
        if (offers.length < pageSize) break;
      }

      const selected = collected.slice(0, 20);
      const localized = await localizeOffers(
        selected.map((entry) => ({
          ...orderOffersObject(entry.offer),
          price: entry.price,
        })),
        locale,
      );
      return localized.map((offer, index) => ({
        ...serializeOffer(offer, { price: offer.price }),
        achievements: serializeValue(selected[index]?.achievements ?? null),
      }));
    },
  );

  return jsonSuccess(c, result, {
    country,
    region,
    locale,
    count: result.length,
  });
});

app.get("/offers/latest-released", async (c) => {
  const query = parseStrictQuery(c, listShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 50);
  const sort: MongoSortField[] = [
    { field: "releaseDate", direction: -1, nulls: "last" },
    { field: "id", direction: 1, nulls: "last" },
  ];
  const binding = {
    operation: "offers.latest-released",
    filters: {},
    ordering: "releaseDate:desc,id:asc",
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("offers.latest-released", { region, locale, limit, cursor }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const filter: Record<string, unknown> = {
        effectiveDate: { $lte: new Date() },
        offerType: { $in: ["BASE_GAME", "DLC"] },
        releaseDate: { $ne: null, $lte: new Date() },
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
      const offers = await Offer.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(sort),
      }).lean();
      const { items, hasMore } = trimPage(offers, limit);
      const prices = await PriceEngine.find({
        region,
        offerId: { $in: items.map((offer) => offer.id) },
      }).lean();
      const priceByOfferId = new Map(
        (prices as PriceEngineType[]).map((price) => [price.offerId, price]),
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
        elements: localized.map((offer) =>
          serializeOffer(offer, { price: offer.price }),
        ),
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastOffer
              ? encodeCursor(binding, [
                  lastOffer.releaseDate
                    ? new Date(lastOffer.releaseDate).toISOString()
                    : null,
                  String(lastOffer.id),
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

const slugsSchema = z
  .object({
    slugs: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
  })
  .strict();

app.post("/offers/slugs", async (c) => {
  const body = await readJsonBody(c);
  const parsed = slugsSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(
      "INVALID_BODY",
      "Provide `slugs` as an array of 1-100 non-empty strings.",
    );
  }
  const { slugs } = parsed.data;
  const expandedSlugs = slugs.flatMap((slug) => [slug, `${slug}/home`]);
  const offers = await Offer.find(
    {
      $and: [
        {
          $or: [
            { productSlug: { $in: expandedSlugs } },
            { urlSlug: { $in: expandedSlugs } },
            { "offerMappings.pageSlug": { $in: expandedSlugs } },
            {
              customAttributes: {
                $elemMatch: {
                  key: "com.epicgames.app.productSlug",
                  value: { $in: expandedSlugs },
                },
              },
            },
            {
              customAttributes: {
                $elemMatch: { key: "slug", value: { $in: expandedSlugs } },
              },
            },
          ],
        },
        { prePurchase: { $ne: true } },
      ],
    },
    {
      id: 1,
      productSlug: 1,
      urlSlug: 1,
      offerMappings: 1,
      customAttributes: 1,
      prePurchase: 1,
      namespace: 1,
    },
  ).lean();

  const result = slugs.map((originalSlug) => {
    const offer = offers.find((candidate) => {
      const checkSlug = (value: string | undefined) =>
        value === originalSlug || value === `${originalSlug}/home`;
      if (checkSlug(candidate.productSlug)) return true;
      if (checkSlug(candidate.urlSlug)) return true;
      if (
        candidate.offerMappings?.some((mapping: { pageSlug?: string }) =>
          checkSlug(mapping.pageSlug),
        )
      )
        return true;
      if (
        candidate.customAttributes?.some(
          (attribute: { key: string; value: string }) =>
            (attribute.key === "com.epicgames.app.productSlug" ||
              attribute.key === "slug") &&
            checkSlug(attribute.value),
        )
      )
        return true;
      return false;
    });
    return {
      slug: originalSlug,
      id: offer ? String(offer.id) : null,
      namespace: offer?.namespace ?? null,
    };
  });

  return jsonSuccess(c, result, {
    found: result.filter((entry) => entry.id !== null).length,
    requested: slugs.length,
  });
});

const existsSchema = z
  .object({
    offers: z.array(z.string().trim().min(1).max(100)).max(200),
  })
  .strict();

app.post("/offers/exists", async (c) => {
  const body = await readJsonBody(c);
  const parsed = existsSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(
      "INVALID_BODY",
      "Provide `offers` as an array of up to 200 non-empty strings.",
    );
  }
  const ids = Array.from(new Set(parsed.data.offers));
  const existing = await Offer.find(
    { id: { $in: ids } },
    { id: 1, _id: 0 },
  ).lean();
  const existingSet = new Set(existing.map((offer) => String(offer.id)));
  return jsonSuccess(
    c,
    {
      existingOffers: ids.filter((id) => existingSet.has(id)),
      nonExistingOffers: ids.filter((id) => !existingSet.has(id)),
    },
    { requested: ids.length, existing: existingSet.size },
  );
});

app.get("/offers/:id", async (c) => {
  const id = c.req.param("id");
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);

  const result = await getOffer({ id, country, region, locale });
  if (!result) {
    throw notFound("OFFER_NOT_FOUND", "No offer exists with this ID.");
  }

  return jsonSuccess(c, result.offer, {
    country,
    region,
    ...result.localization,
  });
});

export default app;
