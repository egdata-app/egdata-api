import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { inspectRoutes } from "hono/dev";
import { getCookie } from "hono/cookie";
import { etag } from "hono/etag";
import { swaggerUI } from "@hono/swagger-ui";
import { db } from "./db/index.js";
import { Offer, type OfferType } from "@egdata/core.schemas.offers";
import { Item } from "@egdata/core.schemas.items";
import { orderOffersObject } from "./utils/order-offers-object.js";
import { getFeaturedGames } from "./utils/get-featured-games.js";
import { countries, regions } from "./utils/countries.js";
import { TagModel, Tags } from "@egdata/core.schemas.tags";
import { attributesToObject } from "./utils/attributes-to-object.js";
import { Asset } from "@egdata/core.schemas.assets";
import {
  PriceEngine,
  type PriceEngineType as PriceType,
} from "@egdata/core.schemas.price";
import { Changelog } from "@egdata/core.schemas.changelog";
import client from "./clients/redis.js";
import SandboxRoute from "./routes/sandbox.js";
import SearchRoute from "./routes/search.js";
import OffersRoute from "./routes/offers.js";
import PromotionsRoute from "./routes/promotions.js";
import FreeGamesRoute from "./routes/free-games.js";
import MultisearchRoute from "./routes/multisearch.js";
import AuthRoute, { epic, type LauncherAuthTokens } from "./routes/auth.js";
import AccountsRoute from "./routes/accounts.js";
import UsersRoute from "./routes/users.js";
import CollectionsRoute from "./routes/collections.js";
import ProfilesRoute from "./routes/profiles.js";
import ItemsRoute from "./routes/items.js";
import SellersRoute from "./routes/sellers.js";
import AdminRoute from "./routes/admin.js";
import AssetsRoute from "./routes/assets.js";
import BuildsRoute from "./routes/builds.js";
import LauncherRoute from "./routes/launcher.js";
import UsersServiceRoute from "./routes/users-service.js";
import StatsRoute from "./routes/stats.js";
import { config } from "dotenv";
import { gaClient } from "./clients/ga.js";
import { Event } from "./db/schemas/events.js";
import { meiliSearchClient } from "./clients/meilisearch.js";
import { Seller } from "@egdata/core.schemas.sellers";
import chalk from "chalk";
import { rateLimiter } from "hono-rate-limiter";
import type { OpenAPIV3 } from "openapi-types";
import { consola } from "./utils/logger.js";
import { discord } from "./clients/discord.js";
import { Routes } from "discord-api-types/v10";
import { honoMiddleware } from './middlewares/apollo.js';
import { server } from "./graphql/index.js";

config();

const internalNamespaces = [
  "epic",
  "SeaQA",
  "d5241c76f178492ea1540fce45616757",
];

const ALLOWED_ORIGINS = [
  "https://egdata.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4000",
  "https://user-reviews-pr.egdata.app/",
  "https://egdata-370475041422.us-central1.run.app",
  "https://store.epicgames.com",
];

const app = new Hono();

await server.start().then(() => {
  consola.success("GraphQL server started");
}).catch((e) => {
  consola.error("GraphQL server failed to start", e);
});

app.use(
  "/*",
  cors({
    origin: (origin: string) => {
      if (ALLOWED_ORIGINS.includes(origin)) {
        return origin;
      }

      return origin.endsWith("egdata.app") ? origin : "https://egdata.app";
    },
    allowHeaders: [],
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    credentials: true,
  }),
);

app.use("/*", etag());

app.use('/graphql', honoMiddleware(server, {
  context: async () => ({
    db: db.db,
    logger: consola,
  }),
}));

app.use("/*", (c, next) => {
  const memoryUsage = process.memoryUsage();
  consola.debug(
    `[${c.req.method}] ${c.req.path} - Memory Usage: ${memoryUsage.heapUsed / 1024 / 1024
    }MB`,
  );
  return next();
});

app.use(
  rateLimiter({
    limit: 1000,
    windowMs: 30 * 1000,
    standardHeaders: "draft-6",
    keyGenerator: (c) => "egdata-api",
    skip(c) {
      // If the referer is 'egdata.app', skip rate limiting
      if (c.req.header("Referer") === "https://egdata.app/") {
        return true;
      }

      return c.req.header("CF-Connecting-IP") === process.env.SERVER_IP;
    },
  }),
);

app.get(
  "/ui",
  swaggerUI({
    url: "/doc",
  }),
);

app.get("/health", async (c) => {
  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), ms),
      ),
    ]);
  }

  const startRedis = Date.now();
  let redisStatus = "ok";
  let redisLatency = null;
  try {
    await withTimeout(client.ping(), 5_000);
    redisLatency = Date.now() - startRedis;
  } catch (e) {
    redisStatus = "error";
    redisLatency = null;
  }

  const startMongo = Date.now();
  let mongoStatus = "ok";
  let mongoLatency = null;
  try {
    await withTimeout(db.db.listCollections(), 5_000);
    mongoLatency = Date.now() - startMongo;
  } catch (e) {
    mongoStatus = "error";
    mongoLatency = null;
  }

  const allOk = redisStatus === "ok" && mongoStatus === "ok";

  return c.json(
    {
      status: allOk ? "ok" : "error",
      services: {
        redis: { status: redisStatus, latency: redisLatency },
        mongodb: { status: mongoStatus, latency: mongoLatency },
      },
    },
    allOk ? 200 : 500,
  );
});

app.get("/", (c) => {
  return c.json({
    app: "egdata",
    version: "0.0.1-alpha",
    endpoints: inspectRoutes(app)
      .filter(
        (x) => !x.isMiddleware && x.name === "[handler]" && x.path !== "/",
      )
      .sort((a, b) => {
        if (a.path !== b.path) {
          return a.path.localeCompare(b.path);
        }

        return a.method.localeCompare(b.method);
      })
      .map((x) => `${x.method} ${x.path}`),
  });
});

app.get("/open-api.json", async (c) => {
  const endpoints = inspectRoutes(app).filter(
    (x) => !x.isMiddleware && x.name === "[handler]",
  );

  const paths = endpoints.reduce(
    (acc, endpoint) => {
      if (!acc[endpoint.path]) {
        acc[endpoint.path] = {};
      }
      acc[endpoint.path][endpoint.method.toLowerCase()] = {
        summary: `Endpoint for ${endpoint.method} ${endpoint.path}`,
        responses: {
          "200": {
            description: "Successful response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                },
              },
            },
          },
        },
      };
      return acc;
    },
    {} as Record<string, any>,
  );

  const result: OpenAPIV3.Document = {
    openapi: "3.0.0",
    info: {
      title: "egdata.app API",
      version: "0.0.1-alpha",
    },
    servers: [
      {
        url: "https://api.egdata.app",
      },
      {
        url: "https://api-gcp.egdata.app",
      },
    ],
    paths,
  };

  return c.json(result);
});

app.get("/doc", async (c) => {
  const endpoints = inspectRoutes(app);

  // Format endpoints to match OpenAPI paths structure
  const paths = endpoints.reduce((acc, endpoint) => {
    if (endpoint.name === "[handler]" && !endpoint.isMiddleware) {
      // Initialize the path object if it doesn't exist
      if (!acc[endpoint.path]) {
        acc[endpoint.path] = {};
      }

      // Add the method to the path
      acc[endpoint.path][endpoint.method.toLowerCase()] = {
        summary: `Endpoint for ${endpoint.method} ${endpoint.path}`,
        responses: {
          "200": {
            description: "Successful response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: {
                      type: "string",
                      example: `Response for ${endpoint.method} ${endpoint.path}`,
                    },
                  },
                },
              },
            },
          },
        },
      };
    }
    return acc;
  }, {});

  return c.json({
    openapi: "3.0.0",
    info: {
      title: "Egdata API",
      version: "1.0.0",
    },
    paths: paths,
  });
});

app.get("/robots.txt", async (c) => {
  // Disallow all robots as this is an API (Besides the sitemap)
  const robots = `User-agent: *
Disallow: /
Allow: /sitemap.xml
Allow: /sitemap.xml?*
Allow: /promotions-sitemap.xml
Allow: /profiles/sitemap.xml
Allow: /sandboxes/sitemap.xml
Allow: /sandboxes/sitemap.xml?*
Allow: /items/sitemap.xml
Allow: /items/sitemap.xml?*
`;

  return c.text(robots, 200, {
    "Content-Type": "text/plain",
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/sitemap.xml", async (c) => {
  const cacheKey = "sitemap-index";
  const cacheTimeInSec = 3600 * 24; // 1 day
  const cacheStaleTimeInSec = cacheTimeInSec * 7; // 7 days
  const cached = false;
  const { page } = c.req.query();
  const limit = 1000;

  if (!page) {
    // Show the sitemap index, which contains the other sitemaps for all pages
    let siteMapIndex = "";

    if (cached) {
      siteMapIndex = cached;
    } else {
      const count = await Offer.countDocuments();
      siteMapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${Array.from(
        { length: Math.ceil(count / limit) },
        (_, i) =>
          `<sitemap><loc>https://api.egdata.app/sitemap.xml?page=${i + 1
          }</loc><lastmod>${new Date().toISOString()}</lastmod></sitemap>`,
      ).join("")}
</sitemapindex>`;

      await client.set(cacheKey, siteMapIndex, "EX", cacheTimeInSec);
    }

    return c.text(siteMapIndex, 200, {
      "Content-Type": "application/xml",
      "Cache-Control": `max-age=${cacheTimeInSec}, stale-while-revalidate=${cacheStaleTimeInSec}`,
    });
  }

  // Generate individual sitemap page
  const cacheKeyPage = `sitemap-page-${page}`;
  const cachedPage = await client.get(cacheKeyPage);
  let siteMap = "";

  if (cachedPage) {
    siteMap = cachedPage;
  } else {
    const sections = [
      "price",
      "items",
      "achievements",
      "related",
      "metadata",
      "changelog",
      "media",
    ];

    const offers = await Offer.find(
      {},
      { id: 1, lastModifiedDate: 1 },
      {
        limit,
        skip: (Number.parseInt(page, 10) - 1) * limit,
        sort: { lastModifiedDate: -1 },
      },
    );

    siteMap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${offers
        .map((offer) => {
          const url = `https://egdata.app/offers/${offer.id}`;
          return `<url>
        <loc>${url}</loc>
        <lastmod>${(offer.lastModifiedDate as Date).toISOString()}</lastmod>
      </url>
      ${sections
              .map(
                (section) => `
      <url>
        <loc>${url}/${section}</loc>
        <lastmod>${(offer.lastModifiedDate as Date).toISOString()}</lastmod>
      </url>
      `,
              )
              .join("\n")}
      `;
        })
        .join("\n")}
</urlset>`;

    await client.set(cacheKeyPage, siteMap, "EX", cacheTimeInSec);
  }

  return c.text(siteMap, 200, {
    "Content-Type": "application/xml",
    "Cache-Control": `max-age=${cacheTimeInSec}, stale-while-revalidate=${cacheStaleTimeInSec}`,
  });
});

app.get("/promotions-sitemap.xml", async (c) => {
  const cacheKey = "promotions-sitemap";
  const cacheTimeInSec = 3600 * 24; // 1 day
  const cacheStaleTimeInSec = cacheTimeInSec * 7; // 7 days
  const cached = await client.get(cacheKey);
  let siteMap = "";

  if (cached) {
    siteMap = cached;
  } else {
    siteMap = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    const pageSize = 1000;
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const tags = await TagModel.find(
        { groupName: "event", referenceCount: { $gt: 0 } },
        undefined,
        {
          limit: pageSize,
          skip: page * pageSize,
          sort: { updated: -1 },
        },
      );

      hasMore = tags.length === pageSize;

      if (0 < tags.length) {
        tags.forEach((tag) => {
          siteMap += `
        <url>
          <loc>https://egdata.app/promotions/${tag.id}</loc>
        </url>`;
        });

        page++;
      }
    }

    siteMap += "</urlset>";

    await client.set(cacheKey, siteMap, "EX", cacheTimeInSec);
  }

  return c.text(siteMap, 200, {
    "Content-Type": "application/xml",
    "Cache-Control": `max-age=${cacheTimeInSec}, stale-while-revalidate=${cacheStaleTimeInSec}`,
  });
});

app.get("/items-from-offer/:id", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `items-from-offer:${id}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    console.log(`[CACHE] ${cacheKey} found`);
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  console.log(`[CACHE] ${cacheKey} not found`);

  const result = await Offer.aggregate([
    {
      $match: { id: id },
    },
    {
      $unwind: {
        path: "$items",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "items",
        localField: "items.id",
        foreignField: "id",
        as: "itemDetails",
      },
    },
    {
      $unwind: {
        path: "$itemDetails",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "items",
        let: { offerId: "$id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $isArray: "$linkedOffers" },
                  { $in: ["$$offerId", "$linkedOffers"] },
                ],
              },
            },
          },
        ],
        as: "linkedItems",
      },
    },
    {
      $group: {
        _id: "$_id",
        offerItems: { $push: "$itemDetails" },
        linkedItems: { $first: "$linkedItems" },
      },
    },
    {
      $project: {
        _id: 0,
        items: {
          $filter: {
            input: { $concatArrays: ["$offerItems", "$linkedItems"] },
            as: "item",
            cond: { $ne: ["$$item", null] },
          },
        },
      },
    },
  ]).exec();

  const items = result.flatMap((r) => r.items);

  const seen = new Set();
  const resultItems = items.filter((i) => {
    const duplicate = seen.has(i.id);
    seen.add(i.id);
    return !duplicate;
  });

  const res = resultItems.map((i) => {
    return {
      ...i,
      customAttributes: attributesToObject(i.customAttributes as any),
    };
  });

  await client.set(cacheKey, JSON.stringify(res), "EX", 604800);

  return c.json(res, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/latest-games", async (c) => {
  const start = new Date();
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  // Get the region for the selected country
  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );

  if (!region) {
    c.status(404);
    return c.json({
      message: "Country not found",
    });
  }

  const cacheKey = `latest-games:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
      "X-Cache": "HIT",
    });
  }

  const items = await Offer.find(
    {
      offerType: { $in: ["BASE_GAME", "DLC", "ADDON"] },
    },
    undefined,
    {
      limit: 25,
      sort: {
        creationDate: -1,
      },
    },
  );

  const prices = await PriceEngine.find({
    region,
    offerId: { $in: items.map((i) => i.id) },
  });

  const end = new Date();

  const result = items.map((i) => {
    const price = prices.find((p) => p.offerId === i.id);
    return {
      ...orderOffersObject(i),
      price: price,
    };
  });

  await client.set(cacheKey, JSON.stringify(result), "EX", 60);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
    "Server-Timing": `db;dur=${end.getTime() - start.getTime()}`,
  });
});

app.get("/featured", async (c) => {
  const GET_FEATURED_GAMES_START = new Date();

  const cacheKey = `featured:v0.1`;
  const responseCacheKey = `featured-response:v0.1`;

  console.log(`[CACHE] ${cacheKey}`);

  const cachedResponse = await client.get(responseCacheKey);

  console.log(`[CACHE] ${responseCacheKey}`);

  if (cachedResponse) {
    console.log(`[CACHE] ${responseCacheKey} found`);
    return c.json(JSON.parse(cachedResponse), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  console.log(`[CACHE] ${responseCacheKey} not found`);

  const cached = await client.get(cacheKey);

  let featuredGames: { id: string; namespace: string }[] = [];

  if (cached) {
    console.log(`[CACHE] ${cacheKey} found`);
    featuredGames = JSON.parse(cached);
  } else {
    featuredGames = await getFeaturedGames();
    await client.set(cacheKey, JSON.stringify(featuredGames), "EX", 86400);
  }

  const GET_FEATURED_GAMES_END = new Date();

  // Convert the featured games to the offer object
  const offers = await Offer.find(
    {
      id: { $in: featuredGames.map((f) => f.id) },
    },
    undefined,
    {
      sort: {
        lastModifiedDate: -1,
      },
    },
  );

  const result = offers.map((o) => orderOffersObject(o));

  await client.set(responseCacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(
    offers.map((o) => orderOffersObject(o)),
    200,
    {
      "Cache-Control": "public, max-age=60",
      "Server-Timing": `db;dur=${GET_FEATURED_GAMES_END.getTime() - GET_FEATURED_GAMES_START.getTime()
        }`,
    },
  );
});

app.get("/autocomplete", async (c) => {
  const query = c.req.query("query");

  if (!query) {
    return c.json({
      elements: [],
      total: 0,
    });
  }

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10"), 10);

  const cacheKey = `autocomplete:${Buffer.from(query).toString(
    "base64",
  )}:${limit}:v0.1`;

  const cached = await client.get(cacheKey);

  if (cached) {
    console.log(`[CACHE] ${cacheKey} found`);
    return c.json(JSON.parse(cached));
  }

  if (!query) {
    c.status(400);
    return c.json({
      message: "Missing query parameter",
    });
  }

  const start = new Date();
  const offers = await Offer.find(
    {
      $text: {
        $search: query
          .split(" ")
          .map((q) => `"${q.trim()}"`)
          .join(" | "),
        $language: "en",
      },
    },
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
  );

  const response = {
    elements: offers.map((o) => orderOffersObject(o)),
    total: await Offer.countDocuments(
      {
        $text: {
          $search: query
            .split(" ")
            .map((q) => `"${q.trim()}"`)
            .join(" | "),
        },
      },
      {
        collation: { locale: "en", strength: 1 },
      },
    ),
  };

  if (response.elements.length > 0) {
    await client.set(cacheKey, JSON.stringify(response), "EX", 60);
  }

  return c.json(response, 200, {
    "Server-Timing": `db;dur=${new Date().getTime() - start.getTime()}`,
  });
});

app.get("/countries", async (c) => {
  return c.json(countries, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/sales", async (c) => {
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

  const page = Math.max(Number.parseInt(c.req.query("page") || "1"), 1);
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10"), 30);
  const skip = (page - 1) * limit;

  const cacheKey = `sales:${region}:${page}:${limit}:v1.3`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=0",
      "X-Cache": "HIT",
    });
  }

  const start = new Date();

  const result = await PriceEngine.aggregate<
    { offer: OfferType } & { price: PriceType }
  >([
    {
      $match: {
        region,
        "price.discount": { $gt: 0 },
        "appliedRules.endDate": { $ne: null },
      },
    },
    {
      // Save the data under "price" key
      $addFields: {
        price: "$$ROOT",
      },
    },
    {
      $lookup: {
        from: "offers",
        localField: "offerId",
        foreignField: "id",
        as: "offer",
      },
    },
    {
      $unwind: {
        path: "$offer",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $sort: {
        "appliedRules.endDate": 1,
      },
    },
    {
      $skip: skip,
    },
    {
      $limit: limit,
    },
  ]);

  const count = await PriceEngine.countDocuments({
    "price.discount": { $gt: 0 },
    region,
  });

  const res = {
    elements: result.map((r) => {
      return {
        ...r.offer,
        price: r.price,
      };
    }),
    page,
    limit,
    total: count,
  };

  await client.set(cacheKey, JSON.stringify(res), "EX", 60);

  return c.json(res, 200, {
    "Cache-Control": "public, max-age=0",
    "Server-Timing": `db;dur=${new Date().getTime() - start.getTime()}`,
  });
});

app.get("/base-game/:namespace", async (c) => {
  const { namespace } = c.req.param();

  if (internalNamespaces.includes(namespace)) {
    return c.json(
      {
        error: "Internal namespace",
      },
      404,
    );
  }

  const game = await Offer.findOne({
    namespace,
    offerType: "BASE_GAME",
    // Either null or false
    prePurchase: { $ne: true },
  });

  if (!game) {
    // Try again with prePurchase = true
    const gameWithPrePurchase = await Offer.findOne({
      namespace,
      offerType: "BASE_GAME",
      prePurchase: true,
    });

    if (gameWithPrePurchase) {
      return c.json(orderOffersObject(gameWithPrePurchase));
    }

    c.status(404);
    return c.json({
      message: "Game not found",
    });
  }

  return c.json(orderOffersObject(game));
});

app.get("/changelog", async (c) => {
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10"), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1"), 1);
  const skip = (page - 1) * limit;

  const changelist = await Changelog.find({}, undefined, {
    limit,
    skip,
    sort: {
      timestamp: -1,
    },
  });

  return c.json(changelist, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/region", async (c) => {
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

  return c.json(
    {
      region: { code: region, ...regions[region] },
    },
    200,
    {
      "Cache-Control": "public, max-age=60",
    },
  );
});

app.get("/regions", async (c) => {
  return c.json(regions, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/changelist", async (ctx) => {
  const start = Date.now();

  const limit = Math.min(Number.parseInt(ctx.req.query("limit") || "10"), 50);
  const page = Math.max(Number.parseInt(ctx.req.query("page") || "1"), 1);
  const skip = (page - 1) * limit;

  const cacheKey = `changelist:${page}:${limit}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return ctx.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const changelist = await Changelog.find(
    {
      "metadata.contextType": { $nin: ["file", "achievements"] },
    },
    undefined,
    {
      limit,
      skip,
      sort: {
        timestamp: -1,
      },
    },
  );

  /**
   * Returns the affected offer, item, asset for each changelog
   */
  const elements = await Promise.all(
    changelist.map(async (change) => {
      switch (change.metadata.contextType) {
        case "offer":
          return Offer.findOne(
            { id: change.metadata.contextId },
            {
              id: 1,
              title: 1,
              keyImages: 1,
              offerType: 1,
            },
          );
        case "item":
          return Item.findOne(
            { id: change.metadata.contextId },
            {
              id: 1,
              title: 1,
              keyImages: 1,
            },
          );
        case "asset":
          return Asset.findOne(
            { id: change.metadata.contextId },
            {
              id: 1,
              artifactId: 1,
            },
          );
        default:
          return null;
      }
    }),
  );

  const result = changelist.map((change) => {
    const element = elements.find(
      (e) => e?.toObject().id === change.metadata.contextId,
    );

    return {
      ...change.toObject(),
      metadata: {
        ...change.toObject().metadata,
        context: element?.toObject(),
      },
    };
  });

  await client.set(cacheKey, JSON.stringify(result), "EX", 60);

  return ctx.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start}`,
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/changelist/:id", async (ctx) => {
  const start = Date.now();
  const { id } = ctx.req.param();

  const cacheKey = `changelist:${id}`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return ctx.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const change = await Changelog.findById(id);

  if (!change) {
    return ctx.json({ message: "Change not found" }, 404);
  }

  let element = null;
  switch (change.metadata.contextType) {
    case "offer":
      element = await Offer.findOne(
        { id: change.metadata.contextId },
        {
          id: 1,
          title: 1,
          keyImages: 1,
          offerType: 1,
          namespace: 1,
        },
      );
      break;
    case "item":
      element = await Item.findOne(
        { id: change.metadata.contextId },
        {
          id: 1,
          title: 1,
          keyImages: 1,
          namespace: 1,
        },
      );
      break;
    case "asset":
      element = await Asset.findOne(
        { id: change.metadata.contextId },
        {
          id: 1,
          artifactId: 1,
          namespace: 1,
        },
      );
      break;
  }

  const result = {
    ...change.toObject(),
    metadata: {
      ...change.toObject().metadata,
      context: element?.toObject(),
    },
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return ctx.json(result, 200, {
    "Server-Timing": `db;dur=${Date.now() - start}`,
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/tags", async (c) => {
  const group = c.req.query("group");

  const tags = await Tags.find(group ? { groupName: group } : {});

  return c.json(tags);
});

app.post("/ping", async (c) => {
  try {
    const body = await c.req.json();

    if (body?.location?.startsWith("http://localhost:5173") || !body.location) {
      return c.json({ message: "pong" });
    }

    console.log(`Tracking event from ${body.userId} (${body.event})`);

    const event = new Event({
      event: body.event,
      location: body.location,
      params: body.params,
      userId: body.userId,
      session: body.session.id,
      timestamp: new Date(body.session.lastActiveAt),
    });

    await event.save();

    await gaClient.track(body);

    return c.json({ message: "pong" });
  } catch (e) {
    console.error(e);
    return c.json({ message: "error" }, 500);
  }
});

app.get("/ping", async (c) => {
  return c.json({ message: "pong" });
});

app.options("/ping", async (c) => {
  return c.json({ message: "pong" });
});

const offerTypeRanks: {
  [key: string]: number;
} = {
  BASE_GAME: 0,
  DLC: 1,
  ADD_ON: 2,
  EDITION: 3,
  BUNDLE: 4,
  Bundle: 5,
  IN_GAME_PURCHASE: 6,
  VIRTUAL_CURRENCY: 7,
  CONSUMABLE: 8,
  UNLOCKABLE: 9,
  DIGITAL_EXTRA: 10,
  EXPERIENCE: 11,
  DEMO: 12,
  WALLET: 13,
  OTHERS: 14,
  null: 15,
  undefined: 16,
};

const PAGE_SIZE = 500;

async function refreshChangelogIndex() {
  console.log("Refreshing MeiliSearch changelog index");
  const index = meiliSearchClient.index("changelog");

  let page = 0;
  let totallogs = 0;
  while (true) {
    const logs = await Changelog.find({}, undefined, {
      sort: {
        timestamp: -1,
      },
      skip: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });

    if (logs.length === 0) break;

    totallogs += logs.length;
    console.log(
      `Processing logs ${totallogs - logs.length + 1} to ${totallogs}`,
    );

    await index.addDocuments(
      logs.map((o) => o.toObject()),
      {
        primaryKey: "_id",
      },
    );

    page++;
  }

  console.log(`Total logs processed: ${totallogs}`);
}

async function refreshOffersIndex() {
  console.log("Refreshing MeiliSearch offers index");
  const index = meiliSearchClient.index("offers");

  let page = 0;
  let totalOffers = 0;
  while (true) {
    const offers = await Offer.find({}, undefined, {
      sort: {
        lastModifiedDate: -1,
      },
      skip: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });

    if (offers.length === 0) break;

    totalOffers += offers.length;
    console.log(
      `Processing offers ${totalOffers - offers.length + 1} to ${totalOffers}`,
    );

    await index.addDocuments(
      offers.map((o) => {
        return {
          ...o.toObject(),
          offerTypeRank: o.offerType ? offerTypeRanks[o.offerType] ?? 16 : 16,
        };
      }),
      {
        primaryKey: "_id",
      },
    );

    page++;
  }

  console.log(`Total offers processed: ${totalOffers}`);
}

async function refreshItemsIndex() {
  console.log("Refreshing MeiliSearch items index");
  const index = meiliSearchClient.index("items");

  let page = 0;
  let totalItems = 0;
  while (true) {
    const items = await Item.find({}, undefined, {
      sort: {
        lastModifiedDate: -1,
      },
      skip: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });

    if (items.length === 0) break;

    totalItems += items.length;
    console.log(
      `Processing items ${totalItems - items.length + 1} to ${totalItems}`,
    );

    await index.addDocuments(
      items.map((o) => o.toObject()),
      {
        primaryKey: "_id",
      },
    );

    page++;
  }

  console.log(`Total items processed: ${totalItems}`);
}

async function refreshSellersIndex() {
  console.log("Refreshing MeiliSearch sellers index");
  const index = meiliSearchClient.index("sellers");

  let page = 0;
  let totalSellers = 0;
  while (true) {
    const sellers = await Seller.find({}, undefined, {
      sort: {
        updatedAt: -1,
      },
      skip: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });

    if (sellers.length === 0) break;

    totalSellers += sellers.length;
    console.log(
      `Processing sellers ${totalSellers - sellers.length + 1
      } to ${totalSellers}`,
    );

    await index.addDocuments(
      sellers.map((o) => o.toObject()),
      {
        primaryKey: "_id",
      },
    );

    page++;
  }

  console.log(`Total sellers processed: ${totalSellers}`);
}

app.patch("/refresh-meilisearch", async (c) => {
  console.log("Refreshing MeiliSearch index");

  await Promise.allSettled([
    refreshChangelogIndex(),
    refreshOffersIndex(),
    refreshItemsIndex(),
    refreshSellersIndex(),
  ]);

  return c.json({ message: "ok" });
});

app.patch("/refresh/changelog", async (c) => {
  await refreshChangelogIndex();

  return c.json({ message: "ok" });
});

app.patch("/refresh/offers", async (c) => {
  await refreshOffersIndex();

  return c.json({ message: "ok" });
});

app.patch("/refresh/items", async (c) => {
  await refreshItemsIndex();

  return c.json({ message: "ok" });
});

app.patch("/refresh/sellers", async (c) => {
  await refreshSellersIndex();

  return c.json({ message: "ok" });
});

app.get("/offer-by-slug/:slug", async (c) => {
  const { slug } = c.req.param();

  const offer = await Offer.findOne({
    "offerMappings.pageSlug": slug,
  });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  return c.json({
    id: offer.id,
  });
});

app.get("/active-sales", async (c) => {
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

  const cacheKey = "active-sales";

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const tags = await TagModel.find(
    {
      // To contain "Sale", "Savings" or "Promotion" case-insensitive
      name: { $regex: "(Sale|Savings|Promotion|Deals)", $options: "i" },
      referenceCount: { $gt: 0 },
      id: { $nin: [33639] },
    },
    undefined,
    {
      sort: {
        updated: -1,
      },
    },
  );

  const result: {
    id: string;
    name: string;
    offers: OfferType[];
  }[] = [];

  await Promise.all(
    tags.map(async (t) => {
      const offers = await Offer.find(
        {
          tags: { $elemMatch: { id: t.id } },
        },
        undefined,
        {
          sort: {
            lastModifiedDate: -1,
          },
        },
      );

      const prices = await PriceEngine.find({
        region,
        offerId: { $in: offers.map((o) => o.id) },
      });

      const everyPriceIsOnSale =
        // if the sale is "29899", it's always active
        t.id === "29899" ||
        (prices.length > 0 &&
          prices.every(
            (p) => p.price.discount > 0 || p.price.originalPrice === 0,
          ));

      result.push({
        id: t.id,
        name: t.name,
        active: everyPriceIsOnSale,
        // @ts-expect-error
        offers: offers.slice(0, 3).map((o) => orderOffersObject(o)),
      });
    }),
  );

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.post("/donate/key/:code", epic, async (c) => {
  const session = c.var.session;

  if (!session) {
    return c.json({ error: "Missing session" }, 401);
  }

  const { code } = c.req.param();

  console.log("Received donation code", code);

  if (!code || code.length !== 20) {
    return c.json({ error: "Invalid code" }, 400);
  }

  console.log("Verifying code");

  const id = session.user?.email.split("@")[0] ?? c.var.epic?.account_id;

  // Check if the code is already in the DB
  const existingDonation = await db.db.collection("key-codes").findOne({
    code,
  });

  if (existingDonation) {
    return c.json({ error: "Code already used" }, 400);
  }

  const targetUser = await db.db
    .collection("launcher")
    .findOne<LauncherAuthTokens>({
      account_id: process.env.ADMIN_ACCOUNT_ID,
    });

  const url = new URL(
    "https://fulfillment-public-service-prod.ol.epicgames.com/fulfillment/api/public/accounts/:accountId/codes/:code"
      .replace(":accountId", process.env.ADMIN_ACCOUNT_ID as string)
      .replace(":code", code),
  );

  console.log("Fetching code details from Epic Games");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${targetUser?.access_token}`,
    },
  });

  if (!response.ok) {
    console.error("Failed to verify code", await response.json());
    return c.json({ error: "Failed to verify code" }, 400);
  }

  const parsedResponse = (await response.json()) as {
    offerId: string;
    accountId: string;
    identityId: string;
    details: {
      entitlementId: string;
      entitlementName: string;
      itemId: string;
      namespace: string;
      country: string;
    }[];
  };

  console.log("Code details", parsedResponse);

  await db.db.collection("key-codes").insertOne({
    code,
    accountId: id,
    offerId: parsedResponse.offerId,
    identityId: parsedResponse.identityId,
    details: parsedResponse.details,
  });

  const userData = await db.db.collection("epic").findOne({
    accountId: id,
  });

  if (userData?.discordId) {
    const roleId = "1379892703793512599";
    const guildId = "561598657879605269";

    await discord
      .put(Routes.guildMemberRole(guildId, userData.discordId, roleId))
      .catch((err) => {
        consola.error("Failed to add role to user", err);
      });
  }

  return c.json({ message: "ok", id: parsedResponse.offerId });
});

app.get("/donate/key/:code", async (c) => {
  // Return the information from the redeemed code
  const { code } = c.req.param();

  const codeInfo = await db.db.collection("key-codes").findOne({
    code,
  });

  if (!codeInfo) {
    return c.json({ error: "Code not found" }, 404);
  }

  return c.json(codeInfo.details);
});

app.route("/sandboxes", SandboxRoute);

app.route("/search", SearchRoute);

app.route("/offers", OffersRoute);

app.route("/promotions", PromotionsRoute);

app.route("/free-games", FreeGamesRoute);

app.route("/multisearch", MultisearchRoute);

app.route("/auth", AuthRoute);

app.route("/accounts", AccountsRoute);

app.route("/users", UsersRoute);

app.route("/collections", CollectionsRoute);

app.route("/profiles", ProfilesRoute);

app.route("/items", ItemsRoute);

app.route("/sellers", SellersRoute);

app.route("/admin", AdminRoute);

app.route("/assets", AssetsRoute);

app.route("/builds", BuildsRoute);

app.route("/launcher", LauncherRoute);

app.route("/users-service", UsersServiceRoute);

app.route("/stats", StatsRoute);

app.get("/items-sitemap.xml", async (c) => {
  const cacheKey = "items-sitemap-index";
  const cacheTimeInSec = 3600 * 24; // 1 day
  const cacheStaleTimeInSec = cacheTimeInSec * 7; // 7 days
  const cached = false;
  const { page } = c.req.query();
  const limit = 1000;

  if (!page) {
    // Show the sitemap index, which contains the other sitemaps for all pages
    let siteMapIndex = "";

    if (cached) {
      siteMapIndex = cached;
    } else {
      const count = await Item.countDocuments();
      siteMapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${Array.from(
        { length: Math.ceil(count / limit) },
        (_, i) =>
          `<sitemap><loc>https://api.egdata.app/items-sitemap.xml?page=${i + 1
          }</loc><lastmod>${new Date().toISOString()}</lastmod></sitemap>`,
      ).join("")}
</sitemapindex>`;

      await client.set(cacheKey, siteMapIndex, "EX", cacheTimeInSec);
    }

    return c.text(siteMapIndex, 200, {
      "Content-Type": "application/xml",
      "Cache-Control": `max-age=${cacheTimeInSec}, stale-while-revalidate=${cacheStaleTimeInSec}`,
    });
  }

  // Generate individual sitemap page
  const cacheKeyPage = `items-sitemap-page-${page}`;
  const cachedPage = await client.get(cacheKeyPage);
  let siteMap = "";

  if (cachedPage) {
    siteMap = cachedPage;
  } else {
    const sections = [
      "offers",
      "assets",
      "achievements",
      "related",
      "metadata",
      "changelog",
      "media",
    ];

    const items = await Item.find(
      {},
      { id: 1, lastModifiedDate: 1 },
      {
        limit,
        skip: (Number.parseInt(page, 10) - 1) * limit,
        sort: { lastModifiedDate: -1 },
      },
    );

    siteMap = `<?xml version="1.0" encoding="UTF-8"?>
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

    await client.set(cacheKeyPage, siteMap, "EX", cacheTimeInSec);
  }

  return c.text(siteMap, 200, {
    "Content-Type": "application/xml",
    "Cache-Control": `max-age=${cacheTimeInSec}, stale-while-revalidate=${cacheStaleTimeInSec}`,
  });
});

async function startServer() {
  try {
    await db.connect();

    const server = serve({
      fetch: app.fetch,
      port: 4000,
    });

    server.on("listening", () => {
      console.log(
        `${chalk.gray("Listening on")} ${chalk.green(
          "http://localhost:4000",
        )} (${chalk.gray("took")} ${chalk.magenta(
          `${(process.uptime() * 1000).toFixed(2)}ms`,
        )})`,
      );
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB", error);
    process.exit(1); // Exit the process if DB connection fails
  }
}

startServer();
