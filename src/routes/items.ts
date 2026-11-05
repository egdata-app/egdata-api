import { Hono } from "hono";
import { submitJobApiBatch, submitJobApiRequest } from "../clients/job-api.js";
import client from "../clients/response-cache.js";
import { db } from "../db/index.js";
import { Asset, Item, Offer } from "../models/index.js";
import { attributesToObject } from "../utils/attributes-to-object.js";
import { wantsExpandedOffers } from "../utils/offer-card.js";
import {
  type BuildDocument,
  buildSummary,
  effectiveBuildPlatform,
} from "../utils/builds.js";
import {
  getLocaleOrErrorResponse,
  getLocalizedCacheTtlSeconds,
  localeCacheSegment,
  localizeOffer,
  localizeOffers,
} from "../utils/offer-localization.js";

const app = new Hono();

const ITEMS_LIST_MAX_LIMIT = 50;
const ITEMS_LIST_DEFAULT_LIMIT = 10;

const BUILDS_MAX_LIMIT = 100;
const BUILDS_DEFAULT_LIMIT = 50;

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=300",
  "CDN-Cache-Control": "public, max-age=300",
} as const;

/**
 * Only the fields used by item cards. Long descriptions, custom attributes,
 * media lists and other bulk fields stay in the detail endpoint.
 */
const ITEMS_LIST_PROJECTION = {
  _id: 0,
  id: 1,
  namespace: 1,
  title: 1,
  description: 1,
  keyImages: 1,
  categories: 1,
  status: 1,
  entitlementType: 1,
  developer: 1,
  releaseInfo: 1,
  lastModifiedDate: 1,
} as const;

const parseBoundedLimit = (
  value: string | undefined,
  fallback: number,
  maximum: number,
) => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
};

const parsePage = (value: string | undefined) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
};

app.get("/", async (c) => {
  const limit = parseBoundedLimit(
    c.req.query("limit"),
    ITEMS_LIST_DEFAULT_LIMIT,
    ITEMS_LIST_MAX_LIMIT,
  );
  const page = parsePage(c.req.query("page"));
  const projection = wantsExpandedOffers(c)
    ? undefined
    : ITEMS_LIST_PROJECTION;

  const [items, total] = await Promise.all([
    Item.find({}, projection, {
      limit,
      skip: (page - 1) * limit,
      sort: {
        lastModifiedDate: -1,
      },
    }),
    Item.countDocuments(),
  ]);

  return c.json(
    {
      elements: items,
      page,
      limit,
      total,
    },
    200,
    CACHE_HEADERS,
  );
});

app.get("/sitemap.xml", async (c) => {
  const cacheTimeInSec = 3600 * 24; // 1 day
  const cacheStaleTimeInSec = cacheTimeInSec * 7; // 7 days
  const { page } = c.req.query();
  const limit = 1000;

  if (!page) {
    // Show the sitemap index, which contains the other sitemaps for all pages
    const count = await Item.countDocuments();
    const siteMapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${Array.from(
    { length: Math.ceil(count / limit) },
    (_, i) =>
      `<sitemap><loc>https://api.egdata.app/items/sitemap.xml?page=${i + 1}</loc></sitemap>`,
  ).join("")}
</sitemapindex>`;

    return c.text(siteMapIndex, 200, {
      "Content-Type": "application/xml",
      "Cache-Control": `public, max-age=${cacheTimeInSec}, stale-while-revalidate=${cacheStaleTimeInSec}`,
    });
  }

  // Generate individual sitemap page
  const sections = [] as const;

  const items = await Item.find(
    {},
    { id: 1, lastModifiedDate: 1 },
    {
      limit,
      skip: (Number.parseInt(page, 10) - 1) * limit,
      sort: { lastModifiedDate: -1 },
    },
  );

  const siteMap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${items
    .map((item) => {
      const url = `https://egdata.app/items/${item.id}`;
      return `<url>
        <loc>${url}</loc>
        <lastmod>${(item.lastModifiedDate as Date).toISOString()}</lastmod>
      </url>
      ${sections
        .map(
          (section) => `
      <url>
        <loc>${url}/${section}</loc>
        <lastmod>${(item.lastModifiedDate as Date).toISOString()}</lastmod>
      </url>
      `,
        )
        .join("\n")}
      `;
    })
    .join("\n")}
</urlset>`;

  return c.text(siteMap, 200, {
    "Content-Type": "application/xml",
    "Cache-Control": `public, max-age=${cacheTimeInSec}, stale-while-revalidate=${cacheStaleTimeInSec}`,
  });
});

type BulkBody = { items: string[] };

app.post("/bulk", async (c) => {
  const batch = (await c.req.json().catch((e) => {
    console.error(e);
    return {
      items: [],
    };
  })) as BulkBody;

  // Select only the items in the array that are a string, no objects, nulls, booleans, etc...
  const ids = batch.items.filter((id) => typeof id === "string").slice(0, 100);

  const items = await Item.find({
    id: { $in: ids },
  });

  return c.json(
    items.map((item) => {
      return {
        ...item.toObject(),
        customAttributes: item.customAttributes
          ? attributesToObject(item.customAttributes as any)
          : {},
      };
    }),
  );
});

app.post("/bulk/offers", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;

  const batch = (await c.req.json().catch((e) => {
    console.error(e);
    return {
      items: [],
    };
  })) as BulkBody;

  const ids = batch.items
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim())
    .slice(0, 100);

  if (ids.length === 0) {
    return c.json({});
  }

  const directOffers = await Offer.find({
    "items.id": { $in: ids },
  });

  const subItems = await db.db
    .collection<{ _id: string; subItems: Array<{ id: string }> }>(
      "offersubitems",
    )
    .find(
      {
        "subItems.id": { $in: ids },
      },
      {
        projection: {
          _id: 1,
          subItems: 1,
        },
      },
    )
    .toArray();

  const subItemOfferIds = subItems.map((s) => s._id);
  const subItemOffers =
    subItemOfferIds.length === 0
      ? []
      : await Offer.find({
          id: { $in: subItemOfferIds },
        });

  const subItemOffersById = new Map(
    subItemOffers.map((offer) => [offer.id, offer]),
  );

  const candidatesByItem = new Map<string, Array<Record<string, any>>>();
  const addCandidate = (itemId: string, offer: Record<string, any>) => {
    const candidates = candidatesByItem.get(itemId) ?? [];
    candidates.push(offer);
    candidatesByItem.set(itemId, candidates);
  };

  for (const offer of directOffers) {
    for (const item of offer.items ?? []) {
      if (ids.includes(item.id)) {
        addCandidate(item.id, offer);
      }
    }
  }

  for (const subItem of subItems) {
    const offer = subItemOffersById.get(subItem._id);
    if (!offer) continue;
    for (const item of subItem.subItems) {
      if (ids.includes(item.id)) {
        addCandidate(item.id, offer);
      }
    }
  }

  const offerTypeRank: Record<string, number> = {
    BASE_GAME: 0,
    DLC: 1,
    ADD_ON: 2,
    ADDON: 2,
    EDITION: 3,
    BUNDLE: 4,
    CONSUMABLE: 5,
  };

  const rankOffer = (offer: Record<string, any>) => {
    const type = `${offer.offerType ?? ""}`.toUpperCase();
    const typeRank = offerTypeRank[type] ?? 99;
    const prePurchaseRank = offer.prePurchase === true ? 1 : 0;
    return prePurchaseRank * 100 + typeRank;
  };

  const resultEntries = ids.map((id) => {
    const candidates = candidatesByItem.get(id) ?? [];
    candidates.sort((a, b) => rankOffer(a) - rankOffer(b));
    return [id, candidates[0] ?? null] as const;
  });
  const selectedOffers = resultEntries
    .map(([, offer]) => offer)
    .filter((offer): offer is Record<string, any> => Boolean(offer));
  const localizedOffers = await localizeOffers(selectedOffers, locale);
  const localizedOffersById = new Map(
    localizedOffers.map((offer) => [offer.id, offer]),
  );
  const result = Object.fromEntries(
    resultEntries.map(([itemId, offer]) => [
      itemId,
      offer ? (localizedOffersById.get(offer.id) ?? offer) : null,
    ]),
  );

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/:id", async (c) => {
  const { id } = c.req.param();
  const item = await Item.findOne({
    $or: [{ _id: { $eq: id } }, { id: { $eq: id } }],
  });

  if (!item) {
    c.status(404);
    return c.json({
      message: "Item not found",
    });
  }

  return c.json({
    ...item.toObject(),
    customAttributes: item.customAttributes
      ? attributesToObject(item.customAttributes as any)
      : {},
  });
});

app.get("/:id/assets", async (c) => {
  const { id } = c.req.param();

  const item = await Asset.find({
    itemId: id,
  });

  return c.json(item);
});

app.get("/:id/builds", async (c) => {
  const { id } = c.req.param();
  const limit = parseBoundedLimit(
    c.req.query("limit"),
    BUILDS_DEFAULT_LIMIT,
    BUILDS_MAX_LIMIT,
  );
  const page = parsePage(c.req.query("page"));
  const skip = (page - 1) * limit;

  const item = await Item.findOne({
    id: { $eq: id },
  });

  if (!item) {
    return c.json({ error: "Item not found" }, 404);
  }

  const releaseInfo: Array<{ appId?: unknown }> = Array.isArray(
    item.releaseInfo,
  )
    ? item.releaseInfo
    : [];
  const appNames = [
    ...new Set(
      releaseInfo
        .map((release) => release.appId)
        .filter(
          (appId): appId is string =>
            typeof appId === "string" && appId.length > 0,
        ),
    ),
  ];

  if (appNames.length === 0) {
    return c.json([], 200, {
      ...CACHE_HEADERS,
      "X-Total-Count": "0",
    });
  }

  const buildsCollection = db.db.collection<BuildDocument>("builds");
  const filter = { appName: { $in: appNames } };

  const [builds, total] = await Promise.all([
    buildsCollection
      .find(filter)
      .sort({ firstSeenAt: -1, createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    buildsCollection.countDocuments(filter),
  ]);

  // One lookup for the whole page instead of one per build.
  const assets =
    builds.length === 0
      ? []
      : await Asset.find(
          {
            artifactId: { $in: builds.map((build) => build.appName) },
          },
          {
            artifactId: 1,
            platform: 1,
            downloadSizeBytes: 1,
            installedSizeBytes: 1,
          },
        );
  const assetByBuild = new Map(
    assets.map((asset) => [`${asset.artifactId}:${asset.platform}`, asset]),
  );

  const summaries = builds.map((build) =>
    buildSummary(
      build,
      assetByBuild.get(`${build.appName}:${effectiveBuildPlatform(build)}`),
    ),
  );

  return c.json(summaries, 200, {
    ...CACHE_HEADERS,
    "X-Total-Count": String(total),
  });
});

app.get("/:id/changelog", async (c) => {
  const { id } = c.req.param();

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;

  const cacheKey = `changelog:${id}:${page}:${limit}`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  // First get the item to ensure it exists
  const item = await Item.findOne({ id: { $eq: id } });
  if (!item) {
    c.status(404);
    return c.json({
      message: "Item not found",
    });
  }

  // Get assets for this item
  const assets = await Asset.find({ itemId: id });
  const assetIds = assets.map((a) => a.artifactId);

  // Get builds for these assets
  const builds = await db.db
    .collection("builds")
    .find({
      appName: { $in: assetIds },
    })
    .toArray();
  const buildIds = builds.map((b) => b._id.toString());

  const allIds = [id, ...assetIds, ...buildIds];

  // Use aggregation pipeline for better performance
  const changelog = await db.db
    .collection("changelogs_v2")
    .aggregate([
      {
        $match: {
          "metadata.contextId": { $in: allIds },
        },
      },
      {
        $sort: { timestamp: -1 },
      },
      {
        $skip: skip,
      },
      {
        $limit: limit,
      },
      {
        $lookup: {
          from: "items",
          let: { contextId: "$metadata.contextId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$id", "$$contextId"] } } },
            {
              $project: {
                _id: 1,
                id: 1,
                title: 1,
                namespace: 1,
              },
            },
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
            {
              $project: {
                _id: 1,
                artifactId: 1,
                itemId: 1,
                platform: 1,
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
            {
              $project: {
                _id: 1,
                appName: 1,
                buildVersion: 1,
                labelName: 1,
                platform: 1,
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

  // Cache the results
  await client.set(cacheKey, JSON.stringify(changelog), "EX", 3600);

  return c.json(changelog, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/:id/offer", async (c) => {
  const { id } = c.req.param();
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;

  const cacheKey = `offer:item:${id}:${localeCacheSegment(locale)}`;
  const cached = await client.get(cacheKey);

  // Cache for 1 hour
  const CACHE_TTL = 60 * 60;

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    });
  }

  const subItems = await db.db
    .collection<{ _id: string }>("offersubitems")
    .find(
      {
        "subItems.id": id,
      },
      {
        projection: {
          _id: 1,
        },
      },
    )
    .toArray();

  const offers = await Offer.find({
    id: { $in: subItems.map((s) => s._id) },
    offerType: "BASE_GAME",
  });

  if (offers.length === 0) {
    return c.json({ error: "No offer found" }, 404);
  }

  if (offers.length === 1) {
    const result = await localizeOffer(offers[0].toObject(), locale);
    // Cache the result
    await client.set(
      cacheKey,
      JSON.stringify(result),
      "EX",
      getLocalizedCacheTtlSeconds(result, 3600),
    );

    return c.json(result, 200, {
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    });
  }

  if (offers.length > 1) {
    // Return the first one that is not `prePurchase = true`
    const offer = offers.find((o) => !o.prePurchase);
    if (offer) {
      const result = await localizeOffer(offer.toObject(), locale);
      // Cache the result
      await client.set(
        cacheKey,
        JSON.stringify(result),
        "EX",
        getLocalizedCacheTtlSeconds(result, 3600),
      );

      return c.json(result, 200, {
        "Cache-Control": `public, max-age=${CACHE_TTL}`,
      });
    }
  }

  return c.json({ error: "No offer found" }, 404);
});

app.put("/regen/:id", async (c) => {
  const { id } = c.req.param();

  await submitJobApiRequest("item-regen", { id });

  return c.json({ message: "Item regen requested" }, 200);
});

app.post("/bulk-regen", async (c) => {
  const { items } = await c.req.json<{ items: string[] }>();

  await submitJobApiBatch(
    "item-regen",
    items.map((id) => ({ id })),
  );

  return c.json({ message: "Item regen requested" }, 200);
});

export default app;
