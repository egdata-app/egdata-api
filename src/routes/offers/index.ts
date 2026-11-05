import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  submitJobApiBatch,
  submitJobApiRequest,
} from "../../clients/job-api.js";
import client from "../../clients/response-cache.js";
import { offersListRateLimit } from "../../middlewares/rate-limit.js";
import {
  AchievementSet,
  GamePosition,
  Offer,
  type OfferType,
  PriceEngine,
  type PriceEngineType,
  Tags,
} from "../../models/index.js";
import { attributesToObject } from "../../utils/attributes-to-object.js";
import { regions } from "../../utils/countries.js";
import { getImage } from "../../utils/get-image.js";
import { toOfferCards, wantsExpandedOffers } from "../../utils/offer-card.js";
import {
  getLocaleOrErrorResponse,
  getLocalizedCacheTtlSeconds,
  localeCacheSegment,
  localizeOffer,
  localizeOffers,
} from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import OfferDataRoute from "./data.js";
import OfferOgRoute from "./og.js";
import OfferPriceRoute from "./price.js";
import OfferRequirementsRoute from "./requirements.js";
import OfferReviewsRoute from "./reviews.js";

const app = new Hono();

// Applied on the handler itself, not via a path prefix, so encoded variants
// such as `/%6Fffers` cannot reach the list while skipping the counter.
app.get("/", offersListRateLimit, async (c) => {
  const start = new Date();
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );

  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }

  const MAX_LIMIT = 50;
  const limit = Math.min(
    Number.parseInt(c.req.query("limit") || "10", 10),
    MAX_LIMIT,
  );
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);

  const expand = wantsExpandedOffers(c);
  const cacheKey = `offers:${region}:${page}:${limit}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offers = await Offer.find({}, undefined, {
    limit,
    skip: (page - 1) * limit,
    sort: {
      lastModifiedDate: -1,
    },
  });

  const prices = await PriceEngine.find({
    offerId: { $in: offers.map((o) => o.id) },
    region,
  });

  const priceByOfferId = new Map(prices.map((price) => [price.offerId, price]));
  const elements = expand
    ? await localizeOffers(
        offers.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      )
    : await toOfferCards(offers, locale, priceByOfferId);

  const result = {
    elements,
    page,
    limit,
    total: await Offer.countDocuments(),
  };

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 60),
  );

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
  });
});

app.get("/events", async (c) => {
  const events = await Tags.find({
    groupName: "event",
    status: "ACTIVE",
  });

  return c.json(events, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/events/:id", async (c) => {
  const { id } = c.req.param();
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );

  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;

  const start = new Date();

  const expand = wantsExpandedOffers(c);
  const cacheKey = `event:${id}:${region}:${page}:${limit}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const event = await Tags.findOne({
    id,
    groupName: "event",
  });

  if (!event) {
    c.status(404);
    return c.json({
      message: "Event not found",
    });
  }

  const offers = await Offer.aggregate([
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
          {
            $sort: { updatedAt: -1 },
          },
          {
            $limit: 1,
          },
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
      $sort: { "price.price.discount": -1 },
    },
    {
      $skip: skip,
    },
    {
      $limit: limit,
    },
    {
      $project: {
        _id: 0,
        id: 1,
        namespace: 1,
        title: 1,
        seller: 1,
        developerDisplayName: 1,
        publisherDisplayName: 1,
        keyImages: 1,
        price: 1,
        offerType: 1,
        productSlug: 1,
        urlSlug: 1,
        releaseDate: 1,
        effectiveDate: 1,
        lastModifiedDate: 1,
        prePurchase: 1,
      },
    },
  ]);

  const priceByOfferId = new Map(
    offers
      .filter((offer) => offer.price)
      .map((offer) => [offer.id, offer.price]),
  );
  const elements = expand
    ? await localizeOffers(offers, locale)
    : await toOfferCards(offers, locale, priceByOfferId);

  const result = {
    elements,
    title: event.name ?? "",
    limit,
    start: skip,
    page,
    count: await Offer.countDocuments({
      tags: { $elemMatch: { id } },
    }),
  };

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 3600),
  );

  return c.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/upcoming", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );

  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "15", 10), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;

  const start = new Date();

  const expand = wantsExpandedOffers(c);
  const cacheKey = `upcoming:${region}:${page}:${limit}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }:v0.2`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offers = await Offer.aggregate([
    {
      $match: {
        releaseDate: {
          $gt: new Date(),
          $ne: null,
          $lt: new Date("2099-01-01"),
        },
        offerType: {
          $in: ["BASE_GAME", "DLC"],
        },
      },
    },
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
          {
            $limit: 1,
          },
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
      $sort: { releaseDate: 1 },
    },
    {
      $skip: skip,
    },
    {
      $limit: limit,
    },
  ]);

  const priceByOfferId = new Map(
    offers
      .filter((offer) => offer.price)
      .map((offer) => [offer.id, offer.price]),
  );
  const elements = expand
    ? await localizeOffers(
        offers.map((offer) => ({
          ...orderOffersObject(offer),
          price: offer.price ?? null,
        })),
        locale,
      )
    : await toOfferCards(offers, locale, priceByOfferId);

  const result = {
    elements,
    limit,
    start: skip,
    page,
    count: await Offer.countDocuments({
      effectiveDate: { $gt: new Date() },
    }),
  };

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 360),
  );

  return c.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/genres", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const genres = await Tags.find({
    groupName: "genre",
    status: "ACTIVE",
  });

  const result = await Promise.all(
    genres.map(async (genre) => {
      const offers = await Offer.find(
        {
          tags: { $elemMatch: { id: genre.id } },
          offerType: "BASE_GAME",
          releaseDate: { $lte: new Date() },
        },
        undefined,
        {
          limit: 3,
          sort: {
            releaseDate: -1,
          },
        },
      );

      const localizedOffers = await localizeOffers(
        offers.map((o) => ({
          id: o.id,
          namespace: o.namespace,
          title: o.title,
          image: getImage(o.keyImages, [
            "OfferImageTall",
            "Thumbnail",
            "DieselGameBoxTall",
            "DieselStoreFrontTall",
          ]),
        })),
        locale,
      );

      return {
        genre,
        offers: localizedOffers.map(({ namespace: _namespace, ...o }) => o),
      };
    }),
  );

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/top-wishlisted", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 10);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;
  const start = new Date();
  const expand = wantsExpandedOffers(c);
  const cacheKey = `top-wishlisted:${page}:${limit}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }:v0.2`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const result = await GamePosition.find({
    collectionId: "top-wishlisted",
    position: { $gt: 0 },
  })
    .sort({ position: 1 })
    .limit(limit)
    .skip(skip);

  const offers = await Offer.find({
    id: { $in: result.map((o) => o.offerId) },
  });

  const positionByOfferId = new Map(
    result.map((position) => [position.offerId, position.position]),
  );
  offers.sort(
    (a, b) =>
      (positionByOfferId.get(a.id) ?? 0) - (positionByOfferId.get(b.id) ?? 0),
  );

  if (result.length > 0) {
    const elements = expand
      ? await localizeOffers(
          offers.map((offer: OfferType) => ({
            ...orderOffersObject(offer),
            position: positionByOfferId.get(offer.id),
          })),
          locale,
        )
      : (await toOfferCards(offers, locale)).map((card) => ({
          ...card,
          position: card.id ? positionByOfferId.get(card.id) : undefined,
        }));
    const response = {
      elements,
      page,
      limit,
      total: await GamePosition.countDocuments({
        position: { $gt: 0 },
      }),
    };
    await client.set(
      cacheKey,
      JSON.stringify(response),
      "EX",
      getLocalizedCacheTtlSeconds(response, 3600),
    );
    return c.json(response, 200, {
      "Cache-Control": "public, max-age=60",
      "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
    });
  }

  return c.json({ elements: [], page, limit, total: 0 }, 200, {
    "Cache-Control": "public, max-age=60",
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
  });
});

app.get("/top-sellers", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 10);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;
  const start = new Date();
  const expand = wantsExpandedOffers(c);
  const cacheKey = `top-sellers:${page}:${limit}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }:v0.2`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const result = await GamePosition.find({
    collectionId: "top-sellers",
    position: { $gt: 0 },
  })
    .sort({ position: 1 })
    .limit(limit)
    .skip(skip);

  const offers = await Offer.find({
    id: { $in: result.map((o) => o.offerId) },
  });

  const positionByOfferId = new Map(
    result.map((position) => [position.offerId, position.position]),
  );
  offers.sort(
    (a, b) =>
      (positionByOfferId.get(a.id) ?? 0) - (positionByOfferId.get(b.id) ?? 0),
  );

  if (result.length > 0) {
    const elements = expand
      ? await localizeOffers(
          offers.map((offer: OfferType) => ({
            ...orderOffersObject(offer),
            position: positionByOfferId.get(offer.id),
          })),
          locale,
        )
      : (await toOfferCards(offers, locale)).map((card) => ({
          ...card,
          position: card.id ? positionByOfferId.get(card.id) : undefined,
        }));
    const response = {
      elements,
      page,
      limit,
      total: await GamePosition.countDocuments({
        collectionId: "top-sellers",
        position: { $gt: 0 },
      }),
    };
    await client.set(
      cacheKey,
      JSON.stringify(response),
      "EX",
      getLocalizedCacheTtlSeconds(response, 3600),
    );
    return c.json(response, 200, {
      "Cache-Control": "public, max-age=60",
      "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
    });
  }

  return c.json({ elements: [], page, limit, total: 0 }, 200, {
    "Cache-Control": "public, max-age=60",
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
  });
});

app.get("/featured-discounts", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");
  const selectedCountry = country ?? cookieCountry ?? "US";
  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );
  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }

  const expand = wantsExpandedOffers(c);
  const cacheKey = `featured-discounts:${region}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }:v0.4`;
  const cached = await client.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const featuredOffers = await GamePosition.find({
    position: { $gt: 0 },
  })
    .sort({ position: 1 })
    .limit(200)
    .lean();

  if (!featuredOffers.length) {
    return c.json([], 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offerIds = featuredOffers.map((o) => o.offerId);

  const [offers, prices] = await Promise.all([
    Offer.find({
      id: { $in: offerIds },
      offerType: { $in: ["BASE_GAME", "DLC"] },
    }).lean(),
    PriceEngine.find({
      offerId: { $in: offerIds },
      region,
      "price.discount": { $gt: 0 },
    })
      .sort({ updatedAt: -1 })
      .lean(),
  ]);

  const priceMap = new Map(prices.map((p) => [p.offerId, p]));

  const positionMap = new Map(
    featuredOffers.map((p) => [p.offerId, p.position]),
  );

  const matchingOffers = offers
    .map((offer) => {
      const price = priceMap.get(offer.id);
      const position = positionMap.get(offer.id);

      if (!price || position === undefined) return null;

      return { offer, price, position };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null)
    .sort((a, b) => a.position - b.position)
    .slice(0, 20);

  const result = expand
    ? await localizeOffers(
        matchingOffers.map(({ offer, price, position }) => ({
          ...offer,
          price,
          position,
        })),
        locale,
      )
    : (
        await toOfferCards(
          matchingOffers.map(({ offer }) => offer),
          locale,
          priceMap,
        )
      ).map((card) => ({
        ...card,
        position: card.id ? positionMap.get(card.id) : undefined,
      }));

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 3600),
  );

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/latest-achievements", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");
  const selectedCountry = country ?? cookieCountry ?? "US";
  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );
  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }
  const expand = wantsExpandedOffers(c);
  const cacheKey = `latest-achievements:${region}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }:v0.2`;
  const cached = await client.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }
  const limit = 15;
  let skip = 0;
  let collected: Array<{
    offer: OfferType;
    achievements: unknown;
    price: PriceEngineType | null;
  }> = [];
  while (collected.length < 20) {
    const offers = await Offer.find({
      offerType: { $in: ["BASE_GAME"] },
      "tags.id": "19847",
      effectiveDate: { $lte: new Date() },
    })
      .sort({ effectiveDate: -1 })
      .skip(skip)
      .limit(limit);
    const [achievementsData, pricesData] = await Promise.allSettled([
      AchievementSet.find({
        sandboxId: { $in: offers.map((o) => o.namespace) },
        isBase: true,
      }),
      PriceEngine.find({
        offerId: { $in: offers.map((o) => o.id) },
        region,
      }),
    ]);
    const achievements =
      achievementsData.status === "fulfilled" ? achievementsData.value : [];
    const prices = pricesData.status === "fulfilled" ? pricesData.value : [];
    const priceByOfferId = new Map(
      prices.map((price) => [price.offerId, price]),
    );
    const pageResults = offers
      .map((offer) => {
        const achievement = achievements.find(
          (a) => a.sandboxId === offer.namespace,
        );
        if (!achievement) return null;
        return {
          offer,
          achievements: achievement,
          price: priceByOfferId.get(offer.id) ?? null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    collected = collected.concat(pageResults);
    skip += limit;
    if (offers.length < limit) {
      break;
    }
  }
  const selected = collected.slice(0, 20);
  const result = expand
    ? await localizeOffers(
        selected.map(({ offer, achievements, price }) => ({
          ...orderOffersObject(offer),
          achievements,
          price,
        })),
        locale,
      )
    : (
        await toOfferCards(
          selected.map(({ offer }) => offer),
          locale,
          new Map(selected.map(({ offer, price }) => [offer.id, price])),
        )
      ).map((card, index) => ({
        ...card,
        achievements: selected[index].achievements,
      }));
  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 3600),
  );
  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/latest-released", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");
  const selectedCountry = country ?? cookieCountry ?? "US";
  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );
  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;
  const expand = wantsExpandedOffers(c);
  const cacheKey = `latest-released:${region}:${page}:${limit}:${localeCacheSegment(locale)}:${
    expand ? "full" : "card"
  }:v0.2`;
  const cached = await client.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }
  const offers = await Offer.find(
    {
      effectiveDate: {
        $lte: new Date(),
      },
      offerType: {
        $in: ["BASE_GAME", "DLC"],
      },
      releaseDate: {
        $ne: null,
        $lte: new Date(),
      },
    },
    undefined,
    {
      sort: {
        releaseDate: -1,
      },
      limit,
      skip,
    },
  );
  const prices = await PriceEngine.find({
    offerId: { $in: offers.map((o) => o.id) },
    region,
  });
  const priceByOfferId = new Map(prices.map((price) => [price.offerId, price]));
  const elements = expand
    ? await localizeOffers(
        offers.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      )
    : await toOfferCards(offers, locale, priceByOfferId);
  const result = {
    elements,
    limit,
    start: skip,
    page,
    count: await Offer.countDocuments({
      releaseDate: { $ne: null },
      offerType: { $in: ["BASE_GAME"] },
    }),
  };
  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 60),
  );
  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.put("/regen/:slug", async (c) => {
  const { slug } = c.req.param();

  await submitJobApiRequest("offer-regen", { slug });

  return c.json({ message: "Offer regen requested" }, 200);
});

app.put("/regen-by-id/:id", async (c) => {
  const { id } = c.req.param();

  await submitJobApiRequest("offer-regen", { id });

  return c.json({ message: "Offer regen requested" }, 200);
});

app.post("/bulk-regen", async (c) => {
  const { offers } = await c.req.json<{ offers: string[] }>();

  await submitJobApiBatch(
    "offer-regen",
    offers.map((id) => ({ id })),
  );

  return c.json({ message: "Offer regen requested" }, 200);
});

app.post("/slugs", async (c) => {
  const { slugs } = await c.req.json<{ slugs: string[] }>();

  if (!slugs || !Array.isArray(slugs) || slugs.length === 0) {
    c.status(400);
    return c.json({
      message:
        "Missing or invalid slugs parameter. Expecting an array of strings.",
    });
  }

  const expandedSlugs = slugs.flatMap((slug) => [slug, `${slug}/home`]);

  const offers = await Offer.find({
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
  }).select(
    "id productSlug urlSlug offerMappings customAttributes prePurchase namespace",
  );

  const result = slugs.map((originalSlug) => {
    const offer = offers.find((o) => {
      const checkSlug = (s: string | undefined) =>
        s === originalSlug || s === `${originalSlug}/home`;

      if (checkSlug(o.productSlug)) return true;
      if (checkSlug(o.urlSlug)) return true;
      if (o.offerMappings?.some((m: any) => checkSlug(m.pageSlug))) return true;
      if (
        o.customAttributes?.some(
          (attr: any) =>
            attr.key === "com.epicgames.app.productSlug" &&
            checkSlug(attr.value),
        )
      )
        return true;
      if (
        o.customAttributes?.some(
          (attr: any) => attr.key === "slug" && checkSlug(attr.value),
        )
      )
        return true;
      return false;
    });
    return {
      slug: originalSlug,
      id: offer ? offer.id : null,
      namespace: offer ? offer.namespace : null,
    };
  });

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.post("/exists", async (c) => {
  const { offers } = await c.req.json<{ offers: string[] }>();
  const existingOffers = await Offer.find(
    { id: { $in: offers } },
    { id: 1, _id: 0 },
  );
  const existingIds = existingOffers.map((o) => o.id);
  const nonExistingOffers = offers.filter(
    (offer) => !existingIds.includes(offer),
  );
  return c.json({ existingOffers: existingIds, nonExistingOffers }, 200);
});

app.get("/:id", async (c) => {
  const { id } = c.req.param();
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;

  if (!id) {
    c.status(400);
    return c.json({
      message: "Missing id parameter",
    });
  }

  const start = new Date();

  const cacheKey = `offer:${id}:${localeCacheSegment(locale)}:v0.1`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offerQuery = Offer.findOne({ id }).lean();

  const [offer] = await Promise.all([offerQuery]);

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found or Price not found",
    });
  }

  const result = await localizeOffer(
    {
      ...offer,
      customAttributes: attributesToObject(offer.customAttributes as any),
    },
    locale,
  );

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 60),
  );

  return c.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
  });
});

app.route("/:id", OfferPriceRoute);
app.route("/:id", OfferRequirementsRoute);
app.route("/:id", OfferOgRoute);
app.route("/:id", OfferReviewsRoute);
app.route("/:id", OfferDataRoute);

export default app;
