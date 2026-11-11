import { Hono } from "hono";
import { db } from "../../db/index.js";
import {
  Asset,
  Changelog,
  FreeGames,
  Item,
  Offer,
  PriceEngine,
  Tags,
} from "../../models/index.js";
import { cached, v1CacheKey } from "../cache.js";
import { ProblemError, problemResponse } from "../errors.js";
import { countryAndRegion } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";

const app = new Hono<{ Variables: V1Variables }>();

const STATS_CACHE_TTL_SECONDS = 60 * 60;
const AGGREGATE_CACHE_TTL_SECONDS = 60 * 60 * 24;
const EGS_LAUNCH_DATE = new Date("2018-12-06");

type StatsCounts = {
  offers: number;
  items: number;
  tags: number;
  assets: number;
  priceEngine: number;
  changelog: number;
  sandboxes: number;
  products: number;
  offersYear: number;
  itemsYear: number;
};

type HomepageStats = {
  offers: number;
  trackedPriceChanges: number;
  activeDiscounts: number;
  giveaways: number;
};

const countOrZero = (result: PromiseSettledResult<number>): number =>
  result.status === "fulfilled" ? result.value : 0;

/**
 * Mirrors the legacy aggregation for release/creation charts. Dates are
 * bucketed in UTC, matching the MongoDB `$year`/`$month` defaults the legacy
 * endpoints relied on.
 */
function dateStatsPipeline(options: {
  dateField: "releaseDate" | "creationDate";
  countField: "releases" | "creations";
  monthly: boolean;
}): Record<string, unknown>[] {
  const groupId: Record<string, unknown> = {
    year: { $year: `$${options.dateField}` },
  };
  const project: Record<string, unknown> = {
    _id: 0,
    year: "$_id.year",
    [options.countField]: 1,
  };
  const sort: Record<string, 1> = { "_id.year": 1 };

  if (options.monthly) {
    groupId.month = { $month: `$${options.dateField}` };
    project.month = "$_id.month";
    sort["_id.month"] = 1;
  }

  return [
    {
      $match: {
        prePurchase: { $ne: true },
        isCodeRedemptionOnly: { $ne: true },
        [options.dateField]: {
          $ne: null,
          $lte: new Date(),
          $gte: EGS_LAUNCH_DATE,
        },
        offerType: { $eq: "BASE_GAME" },
      },
    },
    {
      $group: {
        _id: groupId,
        [options.countField]: { $sum: 1 },
      },
    },
    { $sort: sort },
    { $project: project },
  ];
}

async function countStats(): Promise<StatsCounts> {
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const nextYearStart = new Date(new Date().getFullYear() + 1, 0, 1);

  const [
    offersData,
    itemsData,
    tagsData,
    assetsData,
    priceEngineData,
    changelogData,
    sandboxesData,
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
      creationDate: { $gte: yearStart, $lt: nextYearStart },
    }),
    Item.countDocuments({
      creationDate: { $gte: yearStart, $lt: nextYearStart },
    }),
  ]);

  return {
    offers: countOrZero(offersData),
    items: countOrZero(itemsData),
    tags: countOrZero(tagsData),
    assets: countOrZero(assetsData),
    priceEngine: countOrZero(priceEngineData),
    changelog: countOrZero(changelogData),
    sandboxes: countOrZero(sandboxesData),
    products: countOrZero(productsData),
    offersYear: countOrZero(offersYearData),
    itemsYear: countOrZero(itemsYearData),
  };
}

async function homepageStats(region: string): Promise<HomepageStats> {
  const since = new Date(Date.now() - 72 * 60 * 60 * 1000);

  const [
    offersData,
    trackedPriceChangesData,
    activeDiscountsData,
    giveawaysData,
  ] = await Promise.allSettled([
    Offer.countDocuments(),
    PriceEngine.countDocuments({
      region,
      updatedAt: { $gte: since },
      appliedRules: { $ne: [] },
    }),
    PriceEngine.countDocuments({
      region,
      appliedRules: { $ne: [] },
    }),
    FreeGames.countDocuments(),
  ]);

  return {
    offers: countOrZero(offersData),
    trackedPriceChanges: countOrZero(trackedPriceChangesData),
    activeDiscounts: countOrZero(activeDiscountsData),
    giveaways: countOrZero(giveawaysData),
  };
}

app.get("/stats", async (c) => {
  const counts = await cached<StatsCounts>(
    v1CacheKey("stats.counts", {}),
    STATS_CACHE_TTL_SECONDS,
    countStats,
  );
  return jsonSuccess(c, counts);
});

app.get("/stats/releases/monthly", async (c) => {
  const rows = await cached<unknown[]>(
    v1CacheKey("stats.releases.monthly", {}),
    AGGREGATE_CACHE_TTL_SECONDS,
    async () =>
      await Offer.aggregate(
        dateStatsPipeline({
          dateField: "releaseDate",
          countField: "releases",
          monthly: true,
        }),
      ),
  );
  return jsonSuccess(c, rows);
});

app.get("/stats/releases/yearly", async (c) => {
  const rows = await cached<unknown[]>(
    v1CacheKey("stats.releases.yearly", {}),
    AGGREGATE_CACHE_TTL_SECONDS,
    async () =>
      await Offer.aggregate(
        dateStatsPipeline({
          dateField: "releaseDate",
          countField: "releases",
          monthly: false,
        }),
      ),
  );
  return jsonSuccess(c, rows);
});

app.get("/stats/creations/monthly", async (c) => {
  const rows = await cached<unknown[]>(
    v1CacheKey("stats.creations.monthly", {}),
    AGGREGATE_CACHE_TTL_SECONDS,
    async () =>
      await Offer.aggregate(
        dateStatsPipeline({
          dateField: "creationDate",
          countField: "creations",
          monthly: true,
        }),
      ),
  );
  return jsonSuccess(c, rows);
});

app.get("/stats/creations/yearly", async (c) => {
  const rows = await cached<unknown[]>(
    v1CacheKey("stats.creations.yearly", {}),
    AGGREGATE_CACHE_TTL_SECONDS,
    async () =>
      await Offer.aggregate(
        dateStatsPipeline({
          dateField: "creationDate",
          countField: "creations",
          monthly: false,
        }),
      ),
  );
  return jsonSuccess(c, rows);
});

app.get("/stats/homepage", async (c) => {
  const { region } = countryAndRegion(c.req.query("country"));

  const stats = await cached<HomepageStats>(
    v1CacheKey("stats.homepage", { region }),
    AGGREGATE_CACHE_TTL_SECONDS,
    () => homepageStats(region),
  );

  return jsonSuccess(c, stats);
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
