import { Hono } from "hono";
import client from "../clients/redis.js";
import { Offer } from "@egdata/core.schemas.offers";
import { Item } from "@egdata/core.schemas.items";
import { Tags } from "@egdata/core.schemas.tags";
import { Asset } from "@egdata/core.schemas.assets";
import { PriceEngine } from "@egdata/core.schemas.price";
import { Changelog } from "@egdata/core.schemas.changelog";
import { db } from "../db/index.js";
import { regions } from "../utils/countries.js";
import { getCookie } from "hono/cookie";
import { FreeGames } from "@egdata/core.schemas.free-games";

const app = new Hono();

app.get("/", async (c) => {
  const cacheKey = "stats:v0.3";

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=3600",
    });
  }

  const [
    offersData,
    itemsData,
    tagsData,
    assetsData,
    priceEngineData,
    changelogData,
    sandboxData,
    productsData,
    offersYearData,
    itemsYearData,
  ] = await Promise.allSettled([
    Offer.countDocuments(),
    Item.countDocuments(),
    Tags.countDocuments(),
    Asset.countDocuments(),
    PriceEngine.countDocuments(),
    Changelog.countDocuments(),
    db.db.collection("sandboxes").countDocuments(),
    db.db.collection("products").countDocuments(),
    Offer.countDocuments({
      creationDate: {
        $gte: new Date(new Date().getFullYear(), 0, 1),
        $lt: new Date(new Date().getFullYear() + 1, 0, 1),
      },
    }),
    Item.countDocuments({
      creationDate: {
        $gte: new Date(new Date().getFullYear(), 0, 1),
        $lt: new Date(new Date().getFullYear() + 1, 0, 1),
      },
    }),
  ]);

  const offers = offersData.status === "fulfilled" ? offersData.value : 0;
  const items = itemsData.status === "fulfilled" ? itemsData.value : 0;
  const tags = tagsData.status === "fulfilled" ? tagsData.value : 0;
  const assets = assetsData.status === "fulfilled" ? assetsData.value : 0;
  const priceEngine =
    priceEngineData.status === "fulfilled" ? priceEngineData.value : 0;
  const changelog =
    changelogData.status === "fulfilled" ? changelogData.value : 0;
  const sandboxes = sandboxData.status === "fulfilled" ? sandboxData.value : 0;
  // @ts-ignore-next-line
  const products = productsData.status === "fulfilled" ? sandboxData.value : 0;
  const offersYear =
    offersYearData.status === "fulfilled" ? offersYearData.value : 0;
  const itemsYear =
    itemsYearData.status === "fulfilled" ? itemsYearData.value : 0;

  const res = {
    offers,
    items,
    tags,
    assets,
    priceEngine,
    changelog,
    sandboxes,
    products,
    offersYear,
    itemsYear,
  };

  await client.set(cacheKey, JSON.stringify(res), "EX", 3600);

  return c.json(res, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/releases/monthly", async (c) => {
  const cacheKey = "stats:releases:monthly";

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=3600",
    });
  }

  const result = await Offer.aggregate([
    {
      $match: {
        prePurchase: { $ne: true }, // keep null/false/missing
        isCodeRedemptionOnly: { $ne: true }, // keep null/false/missing
        releaseDate: {
          $ne: null,
          $lte: new Date(),
          $gte: new Date("2018-12-06"),
        },
        offerType: { $eq: "BASE_GAME" },
      },
    },

    {
      $group: {
        _id: {
          year: { $year: "$releaseDate" },
          month: { $month: "$releaseDate" },
        },
        releases: { $sum: 1 },
      },
    },

    { $sort: { "_id.year": 1, "_id.month": 1 } },

    {
      $project: {
        _id: 0,
        year: "$_id.year",
        month: "$_id.month",
        releases: 1,
      },
    },
  ]);

  // Cache for 1 day
  await client.set(cacheKey, JSON.stringify(result), "EX", 86400);

  return c.json(result, 200);
});

app.get("/creations/monthly", async (c) => {
  const cacheKey = "stats:creations:monthly";

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=3600",
    });
  }

  const result = await Offer.aggregate([
    {
      $match: {
        prePurchase: { $ne: true }, // keep null/false/missing
        isCodeRedemptionOnly: { $ne: true }, // keep null/false/missing
        creationDate: {
          $ne: null,
          $lte: new Date(),
          $gte: new Date("2018-12-06"),
        },
        offerType: { $eq: "BASE_GAME" },
      },
    },

    {
      $group: {
        _id: {
          year: { $year: "$creationDate" },
          month: { $month: "$creationDate" },
        },
        creations: { $sum: 1 },
      },
    },

    { $sort: { "_id.year": 1, "_id.month": 1 } },

    {
      $project: {
        _id: 0,
        year: "$_id.year",
        month: "$_id.month",
        creations: 1,
      },
    },
  ]);

  // Cache for 1 day
  await client.set(cacheKey, JSON.stringify(result), "EX", 86400);

  return c.json(result, 200);
});

app.get("/creations/yearly", async (c) => {
  const cacheKey = "stats:creations:yearly";

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=3600",
    });
  }

  const result = await Offer.aggregate([
    {
      $match: {
        prePurchase: { $ne: true }, // keep null/false/missing
        isCodeRedemptionOnly: { $ne: true }, // keep null/false/missing
        creationDate: {
          $ne: null,
          $lte: new Date(),
          $gte: new Date("2018-12-06"),
        },
        offerType: { $eq: "BASE_GAME" },
      },
    },

    {
      $group: {
        _id: {
          year: { $year: "$creationDate" },
        },
        creations: { $sum: 1 },
      },
    },

    { $sort: { "_id.year": 1 } },

    {
      $project: {
        _id: 0,
        year: "$_id.year",
        creations: 1,
      },
    },
  ]);

  // Cache for 1 day
  await client.set(cacheKey, JSON.stringify(result), "EX", 86400);

  return c.json(result, 200);
});

app.get("/releases/yearly", async (c) => {
  const cacheKey = "stats:releases:yearly";

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=3600",
    });
  }

  const result = await Offer.aggregate([
    {
      $match: {
        prePurchase: { $ne: true }, // keep null/false/missing
        isCodeRedemptionOnly: { $ne: true }, // keep null/false/missing
        releaseDate: {
          $ne: null,
          $lte: new Date(),
          $gte: new Date("2018-12-06"),
        },
        offerType: { $eq: "BASE_GAME" },
      },
    },

    {
      $group: {
        _id: {
          year: { $year: "$releaseDate" },
        },
        releases: { $sum: 1 },
      },
    },

    { $sort: { "_id.year": 1 } },

    {
      $project: {
        _id: 0,
        year: "$_id.year",
        releases: 1,
      },
    },
  ]);

  // Cache for 1 day
  await client.set(cacheKey, JSON.stringify(result), "EX", 86400);

  return c.json(result, 200);
});

/**
 * Returns the following stats
 * - Number of offers in the DB
 * - Number of tracked price changes in the last 72 hours
 * - Number of active discounts
 * - Number of giveaways
 */
app.get("/homepage", async (c) => {
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  // Get the region for the selected country
  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry)
  );

  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }

  const cacheKey = `stats:homepage:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=3600",
    });
  }

  const [offersData, trackedPriceChangesData, activeDiscountsData, giveawaysData] =
    await Promise.allSettled([
      Offer.countDocuments(),
      PriceEngine.countDocuments({
        region,
        updatedAt: {
          $gte: new Date(Date.now() - 72 * 60 * 60 * 1000),
        },
        // If the appliedRules array is not empty, it means that the price engine has been updated
        appliedRules: {
          $ne: [],
        },
      }),
      PriceEngine.countDocuments({
        region,
        appliedRules: {
          $ne: [],
        },
      }),
      FreeGames.countDocuments(),
    ]);

  const result = {
    offers: offersData.status === "fulfilled" ? offersData.value : 0,
    trackedPriceChanges:
      trackedPriceChangesData.status === "fulfilled"
        ? trackedPriceChangesData.value
        : 0,
    activeDiscounts:
      activeDiscountsData.status === "fulfilled"
        ? activeDiscountsData.value
        : 0,
    giveaways: giveawaysData.status === "fulfilled" ? giveawaysData.value : 0,
  };

  // Cache for 1 day
  await client.set(cacheKey, JSON.stringify(result), "EX", 86400);

  return c.json(result, 200);
});

export default app;
