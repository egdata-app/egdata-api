import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  AchievementSet,
  Franchise,
  Igdb,
  Offer,
  PriceEngine,
} from "../models/index.js";
import client from "../clients/redis.js";
import { regions } from "../utils/countries.js";
import { orderOffersObject } from "../utils/order-offers-object.js";

const app = new Hono();

app.get("/:slug", async (c) => {
  const { slug } = c.req.param();
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

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "20"), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1"), 1);
  const skip = (page - 1) * limit;

  const start = new Date();
  const cacheKey = `franchises:${slug}:${region}:${page}:${limit}:v0.1`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const franchise = await Franchise.findById(slug);

  if (!franchise) {
    c.status(404);
    return c.json({
      message: "Franchise not found",
    });
  }

  // Get the offers in the franchise
  const offerIds = franchise.offers || [];

  if (offerIds.length === 0) {
    return c.json({
      id: franchise._id,
      name: franchise.name,
      lastUpdated: franchise.lastUpdated,
      elements: [],
      stats: {
        totalTimeHastily: 0,
        totalTimeNormally: 0,
        totalTimeCompletely: 0,
        totalAchievements: 0,
        totalXp: 0,
        gamesCount: 0,
      },
      page,
      limit,
      total: 0,
    });
  }

  // Fetch offers for the current page
  const offers = await Offer.find(
    { id: { $in: offerIds } },
    undefined,
    {
      limit,
      skip,
      sort: { releaseDate: -1 },
    }
  );

  // Also get the namespaces of all offers to fetch achievements
  // To get stats, we should fetch all offers basic info (namespaces)
  const allOffersBasic = await Offer.find(
    { id: { $in: offerIds } },
    { id: 1, namespace: 1 }
  );
  const allNamespaces = Array.from(new Set(allOffersBasic.map(o => o.namespace).filter(Boolean)));

  // Fetch prices for the paginated offers
  const prices = await PriceEngine.find({
    offerId: { $in: offers.map((o) => o.id) },
    region,
  });

  // Map offers with prices
  const elements = offers.map((o) => {
    const price = prices.find((p) => p.offerId === o.id);
    return {
      ...orderOffersObject(o),
      price: price ?? null,
    };
  });

  // Calculate stats for all offers in the franchise
  // 1. Achievements
  const achievements = await AchievementSet.find({
    sandboxId: { $in: allNamespaces },
    isBase: true,
  });

  const totalAchievements = achievements.reduce(
    (acc, set) => acc + (set.achievements?.length || 0),
    0
  );
  const totalXp = achievements.reduce(
    (acc, set) => acc + (set.achievements?.reduce((sum: number, a: any) => sum + (a.xp || 0), 0) || 0),
    0
  );

  // 2. IGDB Time to beat
  const igdbs = await Igdb.find({
    offerId: { $in: offerIds },
  });

  let totalTimeHastily = 0;
  let totalTimeNormally = 0;
  let totalTimeCompletely = 0;

  // Track unique IGDB IDs to avoid counting duplicate games that appear multiple times in offers
  const uniqueIgdbIds = new Set();

  igdbs.forEach((igdb) => {
    if (igdb.igdbId && !uniqueIgdbIds.has(igdb.igdbId) && igdb.timeToBeat) {
      uniqueIgdbIds.add(igdb.igdbId);
      totalTimeHastily += igdb.timeToBeat.hastily || 0;
      totalTimeNormally += igdb.timeToBeat.normally || 0;
      totalTimeCompletely += igdb.timeToBeat.completely || 0;
    }
  });

  const result = {
    id: franchise._id,
    name: franchise.name,
    lastUpdated: franchise.lastUpdated,
    elements,
    stats: {
      totalTimeHastily,
      totalTimeNormally,
      totalTimeCompletely,
      totalAchievements,
      totalXp,
      gamesCount: uniqueIgdbIds.size || allNamespaces.length, // Fallback to namespaces count if no IGDB
    },
    page,
    limit,
    total: offerIds.length,
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
    "Server-Timing": `db;dur=${new Date().getTime() - start.getTime()}`,
  });
});

export default app;