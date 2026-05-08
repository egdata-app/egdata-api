import { Queue } from "bullmq";
import consola from "consola";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import client, { ioredis } from "../../clients/redis.js";
import {
  AchievementSet,
  GamePosition,
  Offer,
  type OfferType,
  PriceEngine,
  Tags,
} from "../../models/index.js";
import { attributesToObject } from "../../utils/attributes-to-object.js";
import { regions } from "../../utils/countries.js";
import { getImage } from "../../utils/get-image.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import OfferDataRoute from "./data.js";
import OfferPriceRoute from "./price.js";
import OfferReviewsRoute from "./reviews.js";

type RegenOfferQueueType =
  | { slug: string }
  | { id: string; namespace?: string };

const regenOffersQueue = new Queue<RegenOfferQueueType>("regenOffersQueue", {
  connection: ioredis,
});

const app = new Hono();

app.use("*", async (c, next) => {
  const startMemory = process.memoryUsage();
  const start = new Date();

  await next();

  const endMemory = process.memoryUsage();
  const end = new Date();

  const memoryDiff = {
    rss: endMemory.rss - startMemory.rss,
    heapTotal: endMemory.heapTotal - startMemory.heapTotal,
    heapUsed: endMemory.heapUsed - startMemory.heapUsed,
    external: endMemory.external - startMemory.external,
    arrayBuffers: endMemory.arrayBuffers - startMemory.arrayBuffers,
    responseTime: end.getTime() - start.getTime(),
  };

  consola.info({
    request: `[${c.req.method}] ${c.req.path}`,
    memory: {
      rss: `${(memoryDiff.rss / 1024 / 1024).toFixed(2)}MB`,
      heapTotal: `${(memoryDiff.heapTotal / 1024 / 1024).toFixed(2)}MB`,
      heapUsed: `${(memoryDiff.heapUsed / 1024 / 1024).toFixed(2)}MB`,
      external: `${(memoryDiff.external / 1024 / 1024).toFixed(2)}MB`,
      arrayBuffers: `${(memoryDiff.arrayBuffers / 1024 / 1024).toFixed(2)}MB`,
    },
    performance: {
      responseTime: `${(memoryDiff.responseTime / 1000).toFixed(2)}s`,
    },
  });
});

app.get("/", async (c) => {
  const start = new Date();
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

  const cacheKey = `offers:${region}:${page}:${limit}`;

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

  const result = {
    elements: offers.map((o) => {
      const price = prices.find((p) => p.offerId === o.id);
      return {
        ...orderOffersObject(o),
        price: price ?? null,
      };
    }),
    page,
    limit,
    total: await Offer.countDocuments(),
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 60);

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

  const cacheKey = `event:${id}:${region}:${page}:${limit}`;

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
      },
    },
  ]);

  const result = {
    elements: offers,
    title: event.name ?? "",
    limit,
    start: skip,
    page,
    count: await Offer.countDocuments({
      tags: { $elemMatch: { id } },
    }),
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/upcoming", async (c) => {
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

  const cacheKey = `upcoming:${region}:${page}:${limit}:v0.1`;

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

  const result = {
    elements: offers.map((o) => {
      return {
        ...orderOffersObject(o),
        price: o.price ?? null,
      };
    }),
    limit,
    start: skip,
    page,
    count: await Offer.countDocuments({
      effectiveDate: { $gt: new Date() },
    }),
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 360);

  return c.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/genres", async (c) => {
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

      return {
        genre,
        offers: offers.map((o) => {
          return {
            id: o.id,
            title: o.title,
            image: getImage(o.keyImages, [
              "OfferImageTall",
              "Thumbnail",
              "DieselGameBoxTall",
              "DieselStoreFrontTall",
            ]),
          };
        }),
      };
    }),
  );

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/top-wishlisted", async (c) => {
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 10);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;
  const start = new Date();
  const cacheKey = `top-wishlisted:${page}:${limit}:v0.1`;
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

  if (result.length > 0) {
    const response = {
      elements: offers
        .map((o: OfferType) => {
          return {
            ...orderOffersObject(o),
            position: result.find((r) => r.offerId === o.id)?.position,
          };
        })
        .sort((a, b) => a.position - b.position),
      page,
      limit,
      total: await GamePosition.countDocuments({
        position: { $gt: 0 },
      }),
    };
    await client.set(cacheKey, JSON.stringify(response), "EX", 3600);
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
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 10);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;
  const start = new Date();
  const cacheKey = `top-sellers:${page}:${limit}:v0.1`;
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

  if (result.length > 0) {
    const response = {
      elements: offers
        .map((o: OfferType) => {
          return {
            ...orderOffersObject(o),
            position: result.find((r) => r.offerId === o.id)?.position,
          };
        })
        .sort((a, b) => a.position - b.position),
      page,
      limit,
      total: await GamePosition.countDocuments({
        collectionId: "top-sellers",
        position: { $gt: 0 },
      }),
    };
    await client.set(cacheKey, JSON.stringify(response), "EX", 3600);
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

  const cacheKey = `featured-discounts:${region}:v0.3`;
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

  const result = offers
    .map((offer) => {
      const price = priceMap.get(offer.id);
      const position = positionMap.get(offer.id);

      if (!price || position === undefined) return null;

      return {
        ...offer,
        price,
        position,
      };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .slice(0, 20);

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/latest-achievements", async (c) => {
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
  const cacheKey = `latest-achievements:${region}:v0.1`;
  const cached = await client.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }
  const limit = 15;
  let skip = 0;
  let result: any[] = [];
  while (result.length < 20) {
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
    const pageResults = offers
      .map((o) => {
        const price = prices.find((p) => p.offerId === o.id);
        const achievement = achievements.find(
          (a) => a.sandboxId === o.namespace,
        );
        return {
          ...orderOffersObject(o),
          achievements: achievement,
          price: price ?? null,
        };
      })
      .filter((o) => o.achievements);
    result = result.concat(pageResults);
    skip += limit;
    if (offers.length < limit) {
      break;
    }
  }
  result = result.slice(0, 20);
  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);
  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/latest-released", async (c) => {
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
  const cacheKey = `latest-released:${region}`;
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
  const result = {
    elements: offers.map((o) => {
      const price = prices.find((p) => p.offerId === o.id);
      return {
        ...orderOffersObject(o),
        price: price ?? null,
      };
    }),
    limit,
    start: skip,
    page,
    count: await Offer.countDocuments({
      releaseDate: { $ne: null },
      offerType: { $in: ["BASE_GAME"] },
    }),
  };
  await client.set(cacheKey, JSON.stringify(result), "EX", 60);
  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.put("/regen/:slug", async (c) => {
  const { slug } = c.req.param();

  await regenOffersQueue.add(`regenOffer-${slug}`, { slug });

  return c.json({ message: "Offer regen requested" }, 200);
});

app.put("/regen-by-id/:id", async (c) => {
  const { id } = c.req.param();

  await regenOffersQueue.add(`regenOffer-${id}`, { id });

  return c.json({ message: "Offer regen requested" }, 200);
});

app.post("/bulk-regen", async (c) => {
  const { offers } = await c.req.json<{ offers: string[] }>();

  await regenOffersQueue.addBulk(
    offers.map((o) => ({
      name: `regenOffer-${o}`,
      data: { id: o },
    })),
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

  if (!id) {
    c.status(400);
    return c.json({
      message: "Missing id parameter",
    });
  }

  const start = new Date();

  const cacheKey = `offer:${id}:v0.1`;
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

  const result = {
    ...offer,
    customAttributes: attributesToObject(offer.customAttributes as any),
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 60);

  return c.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
  });
});

app.route("/:id", OfferPriceRoute);
app.route("/:id", OfferReviewsRoute);
app.route("/:id", OfferDataRoute);

export default app;
