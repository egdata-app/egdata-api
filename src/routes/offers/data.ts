import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import React from "react";
import satori from "satori";
import client from "../../clients/redis.js";
import { db } from "../../db/index.js";
import {
  AchievementSet,
  Asset,
  Bundles,
  Changelog,
  Collection,
  Franchise,
  FreeGames,
  GamePosition,
  Hltb,
  Item,
  Mappings,
  Media,
  Offer,
  type OfferType,
  PriceEngine,
  PriceEngineHistorical,
  type PriceEngineType as PriceType,
  Ratings,
  Review,
  Sandbox,
  TagModel,
  Tags,
} from "../../models/index.js";
import { ageRatingsCountries } from "../../utils/age-ratings.js";
import { attributesToObject } from "../../utils/attributes-to-object.js";
import { regions } from "../../utils/countries.js";
import { getGameFeatures } from "../../utils/game-features.js";
import { getImage } from "../../utils/get-image.js";
import { getOfferSubItems } from "../../utils/get-offer-sub-items.js";
import { getProduct } from "../../utils/get-product.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { verifyGameOwnership } from "../../utils/verify-game-ownership.js";
import { epic } from "../auth.js";

const app = new Hono();

app.get("/og", async (c) => {
  const { id } = c.req.param();
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");
  const selectedCountry = country ?? cookieCountry ?? "US";

  const region = Object.keys(regions).find((r) =>
    regions[r].countries.includes(selectedCountry),
  );

  if (!region) {
    c.status(404);
    return c.json({ message: "Country not found" });
  }

  const offer = await Offer.findOne({ id }).lean();

  if (!offer) {
    c.status(404);
    return c.json({ message: "Offer not found" });
  }

  const [price, lowestPrice, lastDiscount] = await Promise.all([
    PriceEngine.findOne({ offerId: id, region }, undefined, {
      sort: { updatedAt: -1 },
    }),
    PriceEngineHistorical.findOne(
      { offerId: id, region, "price.discount": { $gt: 0 } },
      undefined,
      { sort: { "price.discountPrice": 1 } },
    ),
    PriceEngineHistorical.findOne(
      { offerId: id, region, "price.discount": { $gt: 0 } },
      undefined,
      { sort: { updatedAt: -1 } },
    ),
  ]);

  const tagsIds = offer.tags.map((t) => t.id);
  const tagsInformation = await TagModel.find({ id: { $in: tagsIds } });
  const _genres = tagsInformation
    .filter((t) => t.groupName === "genre")
    .map((g) => g.name)
    .slice(0, 3);

  const subItemsData = await getOfferSubItems({ _id: id });
  const items = await Item.find({
    $or: [
      {
        id: {
          $in: [
            ...offer.items.map((i) => i.id),
            ...subItemsData.flatMap((i) => i.subItems.map((s) => s.id)),
          ],
        },
      },
      { linkedOffers: id },
    ],
  });

  const customAttributes = items.reduce((acc, item) => {
    return Object.assign(acc, attributesToObject(item.customAttributes));
  }, attributesToObject([]));

  const tagsObject = offer.tags.reduce((acc: Record<string, unknown>, tag) => {
    acc[tag.id] = tag;
    return acc;
  }, {});

  const featuresData = getGameFeatures({
    attributes: customAttributes,
    // @ts-expect-error
    tags: tagsObject,
  });

  const assets = await Asset.find({
    itemId: { $in: items.map((i) => i.id) },
  });

  const buildsAgg = await db.db
    .collection("builds")
    .aggregate([
      { $match: { appName: { $in: assets.map((a) => a.artifactId) } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$appName",
          doc: { $first: "$$ROOT" },
        },
      },
    ])
    .toArray();

  const latestBuilds = buildsAgg.map((b: any) => b.doc);
  const _technologies = latestBuilds
    .flatMap((b: any) => b.technologies || [])
    .filter(Boolean)
    .reduce(
      (acc: Array<{ technology: string }>, tech: any) => {
        if (!acc.find((a) => a.technology === tech.technology)) {
          acc.push(tech);
        }
        return acc;
      },
      [] as Array<{ technology: string }>,
    );

  const sandboxData = await Sandbox.findOne({ _id: offer.namespace });
  let _ageRatingLabel: string | null = null;
  if (sandboxData && (sandboxData as any).ageGatings) {
    const selectedRating =
      Object.entries(ageRatingsCountries).find(([, rating]) =>
        rating.includes(selectedCountry),
      )?.[0] ?? "Generic";
    const rating = (sandboxData as any).ageGatings[selectedRating];
    if (rating) {
      const val = (
        (rating as any).age ||
        (rating as any).rating ||
        (rating as any).value ||
        (rating as any).level ||
        ""
      ).toString();
      _ageRatingLabel = `${selectedRating}${val ? ` ${val}` : ""}`;
    }
  }

  const activeGiveaway = await FreeGames.findOne({
    id,
    startDate: { $lte: new Date() },
    endDate: { $gte: new Date() },
  });

  const _reviewsCount = await Review.countDocuments({ id });

  const achievementSets = await AchievementSet.find({
    sandboxId: offer.namespace,
    isBase: offer.offerType === "BASE_GAME",
  });
  const _achievementsCount = achievementSets.reduce(
    (acc, curr) => acc + (curr.achievements?.length ?? 0),
    0,
  );

  const product = sandboxData
    ? await db.db.collection("products").findOne({
        // @ts-expect-error
        _id: (sandboxData as any).parent,
      })
    : null;

  const epicRatings = product
    ? await Ratings.findOne({
        _id: (product as any).slug,
      })
    : null;

  const epicScoreRaw =
    (epicRatings as any)?.overallScore ?? (epicRatings as any)?.score ?? null;
  const _epicScore =
    typeof epicScoreRaw === "number" ? epicScoreRaw.toFixed(1) : null;
  const epicRecommendedRaw =
    (epicRatings as any)?.recommendedPercentage ??
    (epicRatings as any)?.recommendedPercent ??
    (epicRatings as any)?.recommended ??
    null;
  const _epicRecommended =
    typeof epicRecommendedRaw === "number"
      ? Math.round(epicRecommendedRaw)
      : null;

  const image = getImage(offer.keyImages, [
    "DieselGameBoxTall",
    "OfferImageTall",
    "DieselStoreFrontTall",
    "ProductLogo",
    "DieselStoreFrontWide",
    "OfferImageWide",
    "Featured",
    "DieselGameBoxWide",
  ]);

  const currencyCode = regions[region].currencyCode;
  const originalPrice = price?.price.originalPrice ?? null;
  const discountPrice = price?.price.discountPrice ?? null;
  const discountPercent =
    price?.appliedRules?.discountSetting?.discountPercentage ?? null;
  const isFree = typeof discountPrice === "number" && discountPrice === 0;
  const isDiscounted =
    typeof discountPercent === "number" && discountPercent > 0;
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  });

  const title = offer.title;
  const publisher = offer.publisherDisplayName ?? offer.seller?.name ?? "";
  const developer = offer.developerDisplayName ?? "";
  const releaseDate =
    offer.releaseDate ?? offer.effectiveDate ?? offer.viewableDate ?? null;
  const notReleased = releaseDate ? new Date(releaseDate) > new Date() : false;

  const svg = await satori(
    React.createElement(
      "div",
      {
        style: {
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "row",
          background: "#001B3D",
          fontFamily: "Inter, sans-serif",
          position: "relative",
          overflow: "hidden",
          padding: "24px",
        },
      },
      [
        React.createElement("div", {
          key: "bg-gradient",
          style: {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background:
              "linear-gradient(135deg, rgba(0, 27, 61, 1) 0%, rgba(0, 9, 19, 1) 100%)",
          },
        }),
        React.createElement(
          "div",
          {
            key: "left",
            style: {
              width: "460px",
              height: "100%",
              borderRadius: "16px",
              overflow: "hidden",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              background: "rgba(255, 255, 255, 0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginRight: "24px",
            },
          },
          [
            React.createElement("img", {
              key: "cover",
              src: image?.url,
              style: {
                width: "100%",
                height: "100%",
                objectFit: "cover",
              },
            }),
          ],
        ),
        React.createElement(
          "div",
          {
            key: "right",
            style: {
              width: "668px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            },
          },
          [
            React.createElement(
              "div",
              {
                key: "eyebrow",
                style: {
                  fontSize: "18px",
                  color: "rgba(255, 255, 255, 0.7)",
                  letterSpacing: "0.1em",
                },
              },
              "egdata.app",
            ),
            React.createElement(
              "div",
              {
                key: "title",
                style: {
                  fontSize: "42px",
                  fontWeight: 800,
                  color: "#FFFFFF",
                  lineHeight: "1.1",
                },
              },
              title,
            ),
            React.createElement(
              "div",
              {
                key: "meta",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  color: "rgba(255,255,255,0.85)",
                  fontSize: "18px",
                },
              },
              [
                React.createElement(
                  "div",
                  { key: "devpub" },
                  [
                    developer ? `By ${developer}` : "",
                    developer && publisher ? " • " : "",
                    publisher ? `Published by ${publisher}` : "",
                  ].join(""),
                ),
                releaseDate && notReleased
                  ? React.createElement(
                      "div",
                      { key: "release" },
                      new Date(releaseDate).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "2-digit",
                      }),
                    )
                  : null,
              ],
            ),
            React.createElement(
              "div",
              {
                key: "section-pricing",
                style: {
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "12px",
                  padding: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                },
              },
              [
                React.createElement(
                  "div",
                  {
                    key: "section-pricing-title",
                    style: {
                      fontSize: "16px",
                      color: "#0078F2",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    },
                  },
                  "Pricing",
                ),
                React.createElement(
                  "div",
                  {
                    key: "price",
                    style: {
                      display: "flex",
                      alignItems: "baseline",
                      gap: "12px",
                    },
                  },
                  [
                    isFree
                      ? React.createElement(
                          "div",
                          {
                            key: "free",
                            style: {
                              fontSize: "36px",
                              fontWeight: 700,
                              color: "#00D084",
                            },
                          },
                          "Free",
                        )
                      : React.createElement(
                          "div",
                          {
                            key: "discountPrice",
                            style: {
                              fontSize: "36px",
                              fontWeight: 700,
                              color: "#FFFFFF",
                            },
                          },
                          typeof discountPrice === "number"
                            ? formatter.format(discountPrice / 100)
                            : "",
                        ),
                    typeof originalPrice === "number" &&
                    discountPrice !== originalPrice
                      ? React.createElement(
                          "div",
                          {
                            key: "originalPrice",
                            style: {
                              fontSize: "22px",
                              color: "rgba(255,255,255,0.6)",
                              textDecoration: "line-through",
                            },
                          },
                          formatter.format(originalPrice / 100),
                        )
                      : null,
                    typeof discountPercent === "number" && discountPercent > 0
                      ? React.createElement(
                          "div",
                          {
                            key: "discountPercent",
                            style: {
                              fontSize: "20px",
                              color: "#00D084",
                              background: "rgba(0, 208, 132, 0.15)",
                              border: "1px solid rgba(0, 208, 132, 0.4)",
                              borderRadius: "8px",
                              padding: "6px 10px",
                            },
                          },
                          `-${discountPercent}%`,
                        )
                      : null,
                  ],
                ),
                React.createElement(
                  "div",
                  {
                    key: "pricing-badges",
                    style: {
                      display: "flex",
                      gap: "8px",
                      flexWrap: "wrap",
                    },
                  },
                  [
                    isDiscounted
                      ? React.createElement(
                          "div",
                          {
                            key: "sale",
                            style: {
                              fontSize: "16px",
                              color: "#FFFFFF",
                              background: "rgba(0, 120, 242, 0.2)",
                              border: "1px solid rgba(0, 120, 242, 0.4)",
                              borderRadius: "999px",
                              padding: "6px 12px",
                            },
                          },
                          "On Sale",
                        )
                      : null,
                    lowestPrice?.price?.discountPrice
                      ? React.createElement(
                          "div",
                          {
                            key: "lowest",
                            style: {
                              fontSize: "16px",
                              color: "#FFFFFF",
                              background: "rgba(255,255,255,0.08)",
                              border: "1px solid rgba(255,255,255,0.15)",
                              borderRadius: "999px",
                              padding: "6px 12px",
                            },
                          },
                          `Lowest: ${formatter.format(
                            (lowestPrice.price.discountPrice || 0) / 100,
                          )}`,
                        )
                      : null,
                    lastDiscount?.updatedAt
                      ? React.createElement(
                          "div",
                          {
                            key: "lastDiscount",
                            style: {
                              fontSize: "16px",
                              color: "#FFFFFF",
                              background: "rgba(255,255,255,0.08)",
                              border: "1px solid rgba(255,255,255,0.15)",
                              borderRadius: "999px",
                              padding: "6px 12px",
                            },
                          },
                          `Last discount: ${new Date(
                            lastDiscount.updatedAt,
                          ).toLocaleDateString("en-US", {
                            month: "short",
                            day: "2-digit",
                            year: "numeric",
                          })}`,
                        )
                      : null,
                    activeGiveaway
                      ? React.createElement(
                          "div",
                          {
                            key: "giveaway",
                            style: {
                              fontSize: "16px",
                              color: "#FFFFFF",
                              background: "rgba(0, 208, 132, 0.2)",
                              border: "1px solid rgba(0, 208, 132, 0.4)",
                              borderRadius: "999px",
                              padding: "6px 12px",
                            },
                          },
                          `Free until ${new Date(
                            activeGiveaway.endDate,
                          ).toLocaleDateString("en-US", {
                            month: "short",
                            day: "2-digit",
                          })}`,
                        )
                      : null,
                  ],
                ),
              ],
            ),
            React.createElement(
              "div",
              {
                key: "section-features",
                style: {
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "12px",
                  padding: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                },
              },
              [
                React.createElement(
                  "div",
                  {
                    key: "section-features-title",
                    style: {
                      fontSize: "16px",
                      color: "#0078F2",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    },
                  },
                  "Features",
                ),
                React.createElement(
                  "div",
                  {
                    key: "features",
                    style: {
                      display: "flex",
                      gap: "8px",
                      flexWrap: "wrap",
                    },
                  },
                  [
                    ...(featuresData.features || []).slice(0, 6).map((f, i) =>
                      React.createElement(
                        "div",
                        {
                          key: `feat-${i}`,
                          style: {
                            fontSize: "16px",
                            color: "#FFFFFF",
                            background: "rgba(255,255,255,0.08)",
                            border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: "999px",
                            padding: "6px 12px",
                          },
                        },
                        f,
                      ),
                    ),
                    ...(featuresData.epicFeatures || [])
                      .slice(0, 4)
                      .map((f, i) =>
                        React.createElement(
                          "div",
                          {
                            key: `epicf-${i}`,
                            style: {
                              fontSize: "16px",
                              color: "#FFFFFF",
                              background: "rgba(0, 120, 242, 0.15)",
                              border: "1px solid rgba(0, 120, 242, 0.4)",
                              borderRadius: "999px",
                              padding: "6px 12px",
                            },
                          },
                          f,
                        ),
                      ),
                  ],
                ),
              ],
            ),
            React.createElement(
              "div",
              {
                key: "section-positions",
                style: {
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "12px",
                  padding: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                },
              },
              [
                React.createElement(
                  "div",
                  {
                    key: "section-positions-title",
                    style: {
                      fontSize: "16px",
                      color: "#0078F2",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    },
                  },
                  "Rankings",
                ),
                React.createElement(
                  "div",
                  {
                    key: "positions",
                    style: {
                      display: "flex",
                      gap: "8px",
                      flexWrap: "wrap",
                    },
                  },
                  (await GamePosition.find({ offerId: id }))
                    .map((p) => ({
                      collectionId: p.collectionId,
                      position: p.position,
                    }))
                    .filter(
                      (p) => typeof p.position === "number" && p.position > 0,
                    )
                    .slice(0, 4)
                    .map((p, i) =>
                      React.createElement(
                        "div",
                        {
                          key: `pos-${i}`,
                          style: {
                            fontSize: "16px",
                            color: "#FFFFFF",
                            background: "rgba(255,255,255,0.08)",
                            border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: "999px",
                            padding: "6px 12px",
                          },
                        },
                        `${p.collectionId[0].toUpperCase()}${p.collectionId
                          .substring(1)
                          .replace(/-/g, " ")}: #${p.position}`,
                      ),
                    ),
                ),
              ],
            ),
          ],
        ),
      ],
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: "Roboto",
          data: readFileSync(resolve("./src/static/Roboto-Light.ttf")),
          weight: 400,
          style: "normal",
        },
      ],
    },
  );

  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [resolve("./src/static/Roboto-Light.ttf")],
      loadSystemFonts: false,
    },
    fitTo: { mode: "width", value: 1200 },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return c.body(pngBuffer, 200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/franchises", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `franchises:${id}:v0.2`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const franchises = await Franchise.find({
    offers: id,
  });

  if (franchises.length === 0) {
    return c.json([], 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  // Get all unique offer IDs from the found franchises
  const allOfferIds = Array.from(
    new Set(franchises.flatMap((f) => f.offers || [])),
  );

  // Fetch the namespaces for all these offers
  const offersData = await Offer.find(
    { id: { $in: allOfferIds } },
    { id: 1, namespace: 1 },
  );

  const offerNamespaceMap = new Map(offersData.map((o) => [o.id, o.namespace]));

  // Filter out franchises where all offers belong to the same namespace
  const filteredFranchises = franchises.filter((franchise) => {
    const namespaces = new Set(
      (franchise.offers || [])
        .map((offerId: string) => offerNamespaceMap.get(offerId))
        .filter(Boolean),
    );
    return namespaces.size > 1;
  });

  await client.set(cacheKey, JSON.stringify(filteredFranchises), "EX", 3600);

  return c.json(filteredFranchises, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/features", async (c) => {
  const { id } = c.req.param();

  // We need to get the offers and items for that offer
  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const subItems = await getOfferSubItems({
    _id: id,
  });

  const items = await Item.find({
    $or: [
      {
        id: {
          $in: [
            ...offer.items.map((i) => i.id),
            ...subItems.flatMap((i) => i.subItems.map((s) => s.id)),
          ],
        },
      },
      { linkedOffers: id },
    ],
  });

  const customAttributes = items.reduce((acc, item) => {
    return Object.assign(acc, attributesToObject(item.customAttributes as any));
  }, attributesToObject([]));

  // Get the game features
  const tagsObject = offer.tags.reduce((acc, tag) => {
    acc[tag.id] = tag;
    return acc;
  }, {});

  const gameFeatures = getGameFeatures({
    attributes: customAttributes,
    tags: tagsObject,
  });

  return c.json(gameFeatures);
});

app.get("/assets", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `assets:offer:${id}:v0.2`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({
    id: id,
  });

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  const subItems = await getOfferSubItems({
    _id: id,
  });

  const items = await Item.find(
    {
      $or: [
        {
          id: {
            $in: [
              ...offer.items.map((i) => i.id),
              ...subItems.flatMap((i) => i.subItems.map((s) => s.id)),
            ],
          },
        },
        { linkedOffers: id },
      ],
    },
    {
      id: 1,
    },
  );

  const assets = await Asset.find({
    itemId: { $in: items.map((i) => i.id) },
  });

  const result = assets.map((a) => a.toObject());

  await client.set(cacheKey, JSON.stringify(assets), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/items", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `items:offer:${id}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({
    id: id,
  });

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  const itemsSpecified = offer.items.map((item) => item.id);

  const subItems = await getOfferSubItems({
    _id: id,
  });

  // Or it's an item specified by the offer, or it's linked by the item
  const items = await Item.find({
    $or: [
      {
        id: {
          $in: [
            ...itemsSpecified,
            ...subItems.flatMap((i) => i.subItems.map((s) => s.id)),
          ],
        },
      },
      { linkedOffers: id },
    ],
  });

  return c.json(items, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/changelog", async (c) => {
  const { id } = c.req.param();

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const skip = (page - 1) * limit;
  const query = c.req.query("query");
  const changeType = c.req.query("type");
  const field = c.req.query("field");

  const cacheKey = `changelog:${id}:${page}:${limit}:${query}:${changeType}:${field}`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({
    id,
  });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const subItems = await getOfferSubItems({
    _id: id,
  });

  const items = await Item.find({
    $or: [
      {
        id: {
          $in: [
            ...offer.items.map((i) => i.id),
            ...subItems.flatMap((i) => i.subItems.map((s) => s.id)),
          ],
        },
      },
      { linkedOffers: id },
    ],
  });

  const assets = await Asset.find({
    itemId: { $in: items.map((i) => i.id) },
  });

  const allIds = [
    id,
    ...items.map((i) => i.id).concat(assets.map((a) => a.artifactId)),
  ];

  const matchQuery: Record<string, unknown> = {
    "metadata.contextId": { $in: allIds },
  };

  if (query) {
    matchQuery.$text = { $search: query };
  }

  if (changeType) {
    matchQuery["metadata.changes.changeType"] = changeType;
  }

  if (field) {
    matchQuery["metadata.changes.field"] = field;
  }

  // Get total count first
  const totalCount = await db.db
    .collection("changelogs_v2")
    .countDocuments(matchQuery);

  const totalPages = Math.ceil(totalCount / limit);

  // Use aggregation pipeline for better performance
  const changelog = await db.db
    .collection("changelogs_v2")
    .aggregate([
      {
        $match: matchQuery,
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
          from: "offers",
          let: { contextId: "$metadata.contextId" },
          pipeline: [{ $match: { $expr: { $eq: ["$id", "$$contextId"] } } }],
          as: "offerDoc",
        },
      },
      {
        $lookup: {
          from: "items",
          let: { contextId: "$metadata.contextId" },
          pipeline: [{ $match: { $expr: { $eq: ["$id", "$$contextId"] } } }],
          as: "itemDoc",
        },
      },
      {
        $lookup: {
          from: "assets",
          let: { contextId: "$metadata.contextId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$artifactId", "$$contextId"] } } },
          ],
          as: "assetDoc",
        },
      },
      {
        $addFields: {
          document: {
            $switch: {
              branches: [
                {
                  case: { $eq: ["$metadata.contextType", "offer"] },
                  then: { $arrayElemAt: ["$offerDoc", 0] },
                },
                {
                  case: { $eq: ["$metadata.contextType", "item"] },
                  then: { $arrayElemAt: ["$itemDoc", 0] },
                },
                {
                  case: { $eq: ["$metadata.contextType", "asset"] },
                  then: { $arrayElemAt: ["$assetDoc", 0] },
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

  const response = {
    elements: changelog,
    page,
    limit,
    totalCount,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };

  // Cache the results
  await client.set(cacheKey, JSON.stringify(response), "EX", 60);

  return c.json(response, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

/**
 * Retrieve the stats for the offer changelog in a given timeframe
 * - Daily changes number
 * - Weekday changes number
 * - Change-types number
 * - Change field number
 */
app.get("/changelog/stats", async (c) => {
  const { id } = c.req.param();
  const { from, to } = c.req.query();

  // Check if from and to are parseable as Dates
  if (!from || !to) {
    return c.json({
      message: "Missing from or to query parameter",
    });
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return c.json({
      message: "Invalid from or to query parameter",
    });
  }

  const cacheKey = `changelog-stats:${id}:${fromDate.toISOString()}:${toDate.toISOString()}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const changes = await Changelog.find(
    {
      "metadata.contextId": id,
      timestamp: {
        $gte: fromDate,
        $lte: toDate,
      },
    },
    undefined,
    {
      sort: {
        timestamp: -1,
      },
    },
  );

  // Corrected: Get the full date string (YYYY-MM-DD)
  const dailyChanges = changes.reduce(
    (acc, change) => {
      const date = change.timestamp.toISOString().split("T")[0]; // Get YYYY-MM-DD
      if (!acc[date]) {
        acc[date] = 0;
      }
      acc[date]++;
      return acc;
    },
    {} as Record<string, number>,
  );

  const weekdayChanges = changes.reduce(
    (acc, change) => {
      const day = change.timestamp.getDay();
      if (!acc[day]) {
        acc[day] = 0;
      }
      acc[day]++;
      return acc;
    },
    {} as Record<number, number>,
  );

  // Corrected: Use change.metadata.changes[].changeType
  const changeTypes = changes.reduce(
    (acc, change) => {
      change.metadata.changes.forEach((item) => {
        if (!acc[item.changeType]) {
          acc[item.changeType] = 0;
        }
        acc[item.changeType]++;
      });

      return acc;
    },
    {} as Record<string, number>,
  );

  // Corrected: Use change.metadata.changes[].field
  const changeFields = changes.reduce(
    (acc, change) => {
      change.metadata.changes.forEach((item) => {
        if (!acc[item.field]) {
          acc[item.field] = 0;
        }
        acc[item.field]++;
      });
      return acc;
    },
    {} as Record<string, number>,
  );

  await client.set(cacheKey, JSON.stringify(changeFields), "EX", 3600);

  return c.json({
    dailyChanges,
    weekdayChanges,
    changeTypes,
    changeFields,
  });
});

app.get("/achievements", async (c) => {
  const { id } = c.req.param();

  if (!id) {
    c.status(400);
    return c.json({
      message: "Missing id parameter",
    });
  }

  const offer = await Offer.findOne(
    { id },
    {
      namespace: 1,
      offerType: 1,
    },
  );

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const cacheKey = `achievements:offer:${id}:v0.1`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const achievements = await AchievementSet.find({
    sandboxId: offer.namespace,
    isBase: offer.offerType === "BASE_GAME",
  });

  if (achievements.length === 0) {
    c.status(200);
    return c.json([]);
  }

  await client.set(cacheKey, JSON.stringify(achievements), "EX", 3600);

  return c.json(achievements, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/related", async (c) => {
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

  const cacheKey = `related-offers:${id}:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({ id }, { namespace: 1, id: 1 });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const related = await Offer.find(
    {
      namespace: offer.namespace,
      id: { $ne: offer.id },
    },
    undefined,
    {
      limit: 25,
    },
  );

  const prices = await PriceEngine.find({
    offerId: { $in: related.map((o) => o.id) },
    region,
  });

  const result = related.map((o) => {
    const price = prices.find((p) => p.offerId === o.id);
    return {
      ...orderOffersObject(o),
      price: price ?? null,
    };
  });

  await client.set(cacheKey, JSON.stringify(related), "EX", 60);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/mappings", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `mappings:${id}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const mappings = await Mappings.findOne({
    _id: id,
  });

  if (!mappings) {
    c.status(404);
    return c.json({
      message: "Mappings not found",
    });
  }

  await client.set(cacheKey, JSON.stringify(mappings), "EX", 86400);

  return c.json(mappings, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/media", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `media:${id}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const media = await Media.findOne({
    _id: id,
  });

  if (!media) {
    c.status(404);
    return c.json({
      message: "Media not found",
    });
  }

  await client.set(cacheKey, JSON.stringify(media), "EX", 86400);

  return c.json(media, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/suggestions", async (c) => {
  const { id } = c.req.param();
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

  const cacheKey = `suggestions:${id}:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const tagsIds = offer.tags.map((t) => t.id);
  const tagsInformation = await TagModel.find({
    id: { $in: tagsIds },
  });

  const genres = tagsInformation.filter((t) => t.groupName === "genre");

  const suggestions = await Offer.find(
    {
      tags: { $elemMatch: { id: { $in: genres.map((g) => g.id) } } },
      id: { $ne: id },
      namespace: { $ne: offer.namespace },
      offerType: { $in: ["BASE_GAME", "DLC"] },
    },
    undefined,
    {
      limit: 25,
      sort: {
        lastModifiedDate: -1,
      },
    },
  );

  const prices = await PriceEngine.find({
    offerId: { $in: suggestions.map((o) => o.id) },
    region: region,
  });

  const result = suggestions.map((o) => {
    const price = prices.find((p) => p.offerId === o.id);
    return {
      ...orderOffersObject(o),
      price: price ?? null,
    };
  });

  await client.set(cacheKey, JSON.stringify(result), "EX", 60);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/age-rating", async (c) => {
  const { id } = c.req.param();
  const single = c.req.query("single");
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  const cacheKey = `age-rating:${id}:${single ? "single" : "all"}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const sandbox = await Sandbox.findOne({
    _id: offer.namespace,
  });

  if (!sandbox) {
    c.status(404);
    return c.json({
      message: "Sandbox not found",
    });
  }

  const ageRatings = sandbox.ageGatings;

  if (!ageRatings) {
    c.status(404);
    return c.json({
      message: "Sandbox not found",
    });
  }

  if (single) {
    const selectedRating =
      Object.entries(ageRatingsCountries).find(([, rating]) =>
        rating.includes(selectedCountry),
      )?.[0] ?? "Generic";

    const rating = ageRatings[selectedRating];

    if (!rating) {
      c.status(404);
      return c.json({
        message: "Age rating not found",
      });
    }

    return c.json(
      {
        [selectedRating]: rating,
      },
      200,
      {
        "Cache-Control": "public, max-age=60",
      },
    );
  }

  await client.set(cacheKey, JSON.stringify(ageRatings), "EX", 3600);

  return c.json(ageRatings, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/giveaways", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `giveaways:${id}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const giveaways = await FreeGames.find(
    {
      id,
    },
    undefined,
    {
      sort: {
        startDate: -1,
      },
    },
  );

  await client.set(cacheKey, JSON.stringify(giveaways), "EX", 3600);

  return c.json(giveaways, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/ratings", async (c) => {
  const { id } = c.req.param();

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const cacheKey = `ratings:${id}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const sandbox = await Sandbox.findOne({
    _id: offer.namespace,
  });

  if (!sandbox) {
    c.status(404);
    return c.json({
      message: "Sandbox not found",
    });
  }

  const product = await db.db.collection("products").findOne({
    // @ts-expect-error - _id in products is a string
    _id: sandbox.parent,
  });

  if (!product) {
    c.status(404);
    return c.json({
      message: "Product not found",
    });
  }

  const ratings = await Ratings.findOne({
    _id: product.slug,
  });

  if (!ratings) {
    c.status(404);
    return c.json({
      message: "Ratings not found",
    });
  }

  await client.set(cacheKey, JSON.stringify(ratings), "EX", 3600);

  return c.json(ratings, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/tops", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `tops:${id}:all`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const positions = await GamePosition.find({
    offerId: id,
  });

  const result = positions.reduce(
    (acc, position) => {
      acc[position.collectionId] = position.position;
      return acc;
    },
    {} as Record<string, number>,
  );

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/polls", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `polls:${id}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const sandbox = await Sandbox.findOne({ _id: offer.namespace });

  if (!sandbox) {
    c.status(404);
    return c.json({
      message: "Sandbox not found",
    });
  }

  const polls = await db.db
    .collection("ratings_polls")
    .find({
      // @ts-expect-error - _id in polls is a string
      _id: offer.namespace,
    })
    .toArray();

  await client.set(cacheKey, JSON.stringify(polls[0]), "EX", 3600);

  return c.json(polls[0], 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/ownership", epic, async (c) => {
  const { id } = c.req.param();
  const epic = c.var.epic;
  const session = c.var.session;

  if ((!epic || !epic.account_id) && !session) {
    c.status(401);
    return c.json({
      message: "Unauthorized",
    });
  }

  const product = await getProduct(id);

  if (!product) {
    c.status(404);
    return c.json({
      message: "Product not found",
    });
  }

  const isOwned =
    (session?.user?.email.split("@")[0] ?? epic?.account_id)
      ? await verifyGameOwnership(
          session?.user?.email.split("@")[0] ?? (epic?.account_id as string),
          product._id as unknown as string,
        )
      : false;

  return c.json({
    isOwned,
  });
});

app.get("/hltb", async (c) => {
  const { id } = c.req.param();

  if (!id) {
    c.status(400);
    return c.json({
      message: "Missing id parameter",
    });
  }

  const _start = new Date();

  const cacheKey = `hltb:${id}`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const hltb = await Hltb.findOne({
    _id: id,
  });

  if (!hltb || !hltb.hltbId || hltb.hltbId === "00000") {
    return c.json(
      {
        error: "HowLongToBeat data not found for this offer",
      },
      {
        status: 404,
      },
    );
  }

  await client.set(cacheKey, JSON.stringify(hltb), "EX", 3600);

  return c.json(hltb, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/collection", async (c) => {
  const { id } = c.req.param();
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

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const { categories, customAttributes } = offer;

  if (!categories || !(categories.indexOf("collections") > -1)) {
    c.status(404);
    return c.json({
      message: "Selected offer does not have a collection",
    });
  }

  const cacheKey = `collection-offers:${id}:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  // Get the IDs of the collection offers
  const collectionOfferIds = customAttributes
    .filter((a) => a.key?.startsWith("com.epicgames.app.collectionOfferIds."))
    .map((a) => a.value);

  if (!collectionOfferIds.length || collectionOfferIds.length === 0) {
    c.status(404);
    return c.json({
      message: "Selected offer does not have a collection",
    });
  }

  const [offersData, pricesData] = await Promise.allSettled([
    Offer.find({
      id: { $in: collectionOfferIds },
    }),
    PriceEngine.find({
      offerId: { $in: collectionOfferIds },
      region,
    }),
  ]);

  const offers = offersData.status === "fulfilled" ? offersData.value : [];
  const prices = pricesData.status === "fulfilled" ? pricesData.value : [];

  const result = offers.map((o) => {
    const price = prices.find((p) => p.offerId === o.id);
    return {
      ...orderOffersObject(o),
      price: price ?? null,
    };
  });

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/collections/:collection", async (c) => {
  const { id, collection } = c.req.param();

  const offer = await Offer.findOne({ id });

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  const [game, collectionData] = await Promise.all([
    GamePosition.findOne({
      collectionId: collection,
      offerId: id,
    }),
    Collection.findOne({ _id: collection }),
  ]);

  if (!game || !collectionData) {
    return c.json({ error: "Game not found" }, 404);
  }

  return c.json({
    ...game.toJSON(),
    name: collectionData.name,
  });
});

type BUNDLE_RESPONSE = {
  offers: OfferType[];
  bundlePrice: PriceType;
  totalPrice: PriceType;
};

app.get("/bundle", async (c) => {
  const { id } = c.req.param();
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

  const cacheKey = `bundle:${id}:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const [mainOfferData, mainPriceData] = await Promise.allSettled([
    Offer.findOne({ id }),
    PriceEngine.findOne({
      offerId: id,
      region,
    }),
  ]);

  const offer =
    mainOfferData.status === "fulfilled" ? mainOfferData.value : null;
  const mainPrice =
    mainPriceData.status === "fulfilled" ? mainPriceData.value : null;

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const { offerType } = offer;

  if (!offerType || (offerType !== "BUNDLE" && offerType !== "Bundle")) {
    c.status(404);
    return c.json({
      message: "Selected offer is not a bundle",
    });
  }

  const bundleData = await Bundles.findOne({ _id: offer.id });

  if (!bundleData) {
    c.status(404);
    return c.json({
      message: "Bundle not found",
    });
  }

  const bundleOfferIds = bundleData?.offers ?? [];

  const [bundleOffersData, bundlePricesData] = await Promise.allSettled([
    Offer.find({
      id: { $in: bundleOfferIds },
    }),
    PriceEngine.find({
      offerId: { $in: bundleOfferIds },
      region,
    }),
  ]);

  const bundleOffers =
    bundleOffersData.status === "fulfilled" ? bundleOffersData.value : [];
  const bundlePrices =
    bundlePricesData.status === "fulfilled" ? bundlePricesData.value : [];

  const offers = bundleOffers.map((o) => {
    const price = bundlePrices.find((p) => p.offerId === o.id);
    return {
      ...orderOffersObject(o),
      price: price ?? null,
    };
  });

  const result: BUNDLE_RESPONSE = {
    offers: offers,
    // @ts-expect-error
    totalPrice: offers.reduce(
      (acc, offer) => {
        const price = bundlePrices.find((p) => p.offerId === offer.id);

        // If there's no price for the offer, skip it
        if (!price) return acc;

        // Accumulate the price fields within the nested price object
        return {
          ...acc,
          price: {
            ...acc.price,
            currencyCode: price.price.currencyCode,
            discount: acc.price.discount + (price.price.discount ?? 0),
            discountPrice:
              acc.price.discountPrice + (price.price.discountPrice ?? 0),
            originalPrice:
              acc.price.originalPrice + (price.price.originalPrice ?? 0),
            basePayoutCurrencyCode: price.price.basePayoutCurrencyCode,
            basePayoutPrice:
              acc.price.basePayoutPrice + (price.price.basePayoutPrice ?? 0),
            payoutCurrencyExchangeRate: price.price.payoutCurrencyExchangeRate,
          },
        };
      },
      {
        country: mainPrice?.country ?? "US",
        offerId: id,
        region: mainPrice?.region ?? "US",
        namespace: mainPrice?.namespace ?? "epic",
        updatedAt: mainPrice?.updatedAt ?? new Date(),
        price: {
          discount: 0,
          discountPrice: 0,
          originalPrice: 0,
          basePayoutPrice: 0,
          currencyCode: "USD",
          basePayoutCurrencyCode: "USD",
          payoutCurrencyExchangeRate: 1,
        },
        appliedRules: [] as any[],
      },
    ),
    // @ts-expect-error
    bundlePrice: mainPrice,
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/in-bundle", async (c) => {
  const { id } = c.req.param();
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

  const cacheKey = `in-bundle:${id}:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const bundleData = await Bundles.find({ offers: id });

  if (!bundleData) {
    c.status(404);
    return c.json({
      message: "Bundle not found",
    });
  }

  const bundles = await Promise.all(
    bundleData.flatMap(async (bundle) => {
      const id = bundle._id;
      const [bundleData, bundlePriceData] = await Promise.allSettled([
        Offer.findOne({ id }),
        PriceEngine.findOne({
          offerId: id,
          region,
        }),
      ]);

      const b = bundleData.status === "fulfilled" ? bundleData.value : null;
      const bp =
        bundlePriceData.status === "fulfilled" ? bundlePriceData.value : null;

      return {
        ...orderOffersObject(b),
        price: bp ?? null,
      };
    }),
  );

  await client.set(cacheKey, JSON.stringify(bundles), "EX", 3600);

  return c.json(bundles, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/has-prepurchase", async (c) => {
  const { id } = c.req.param();
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

  const cacheKey = `has-prepurchase:${id}:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const { namespace } = offer;

  const prePurchaseOffer = await Offer.findOne({
    namespace,
    offerType: "BASE_GAME",
    prePurchase: true,
    id: { $ne: id },
  });

  if (!prePurchaseOffer) {
    await client.set(cacheKey, JSON.stringify(false), "EX", 3600);
    return c.json(
      {
        hasPrepurchase: false,
      },
      200,
      {
        "Cache-Control": "public, max-age=60",
      },
    );
  }

  const price = await PriceEngine.findOne({
    offerId: prePurchaseOffer.id,
    region,
  });

  const result = {
    hasPrepurchase: true,
    offer: {
      ...orderOffersObject(prePurchaseOffer),
      price: price ?? null,
    },
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/has-regular", async (c) => {
  const { id } = c.req.param();
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

  const cacheKey = `has-regular:${id}:${region}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  if (offer.offerType !== "BASE_GAME") {
    return c.json({
      isPrepurchase: false,
    });
  }

  if (offer.prePurchase !== true) {
    return c.json({
      isPrepurchase: false,
    });
  }

  const { namespace } = offer;

  const prePurchaseOffer = await Offer.findOne({
    namespace,
    offerType: "BASE_GAME",
    prePurchase: { $ne: true },
    id: { $ne: id },
  });

  if (!prePurchaseOffer) {
    await client.set(cacheKey, JSON.stringify(true), "EX", 3600);
    return c.json(
      {
        isPrepurchase: false,
      },
      200,
      {
        "Cache-Control": "public, max-age=60",
      },
    );
  }

  const price = await PriceEngine.findOne({
    offerId: prePurchaseOffer.id,
    region,
  });

  const result = {
    isPrepurchase: true,
    offer: {
      ...orderOffersObject(prePurchaseOffer),
      price: price ?? null,
    },
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/genres", async (c) => {
  const { id } = c.req.param();

  const offer = await Offer.findOne({ id });

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  const genres = await Tags.find({
    groupName: "genre",
    status: "ACTIVE",
  });

  const result = offer.tags.filter((tag) =>
    genres?.map((genre) => genre?.id).includes(tag?.id),
  );

  return c.json(result);
});

app.get("/technologies", async (c) => {
  const { id } = c.req.param();

  const offer = await Offer.findOne({ id });

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  const itemsSpecified = offer.items.map((item) => item.id);

  const subItems = await getOfferSubItems({
    _id: id,
  });

  const items = await Item.find({
    $or: [
      {
        id: {
          $in: [
            ...itemsSpecified,
            ...subItems.flatMap((i) => i.subItems.map((s) => s.id)),
          ],
        },
      },
      { linkedOffers: id },
    ],
  });

  const assets = await Asset.find({
    itemId: { $in: items.map((i) => i.id) },
  });

  const builds = await db.db
    .collection<{
      appName: string;
      labelName: string;
      buildVersion: string;
      hash: string;
      metadata: {
        installationPoolId: string;
      };
      createdAt: {
        $date: string;
      };
      updatedAt: {
        $date: string;
      };
      technologies: Array<{
        section: string;
        technology: string;
      }>;
      downloadSizeBytes: number;
      installedSizeBytes: number;
    }>("builds")
    .aggregate([
      { $match: { appName: { $in: assets.map((a) => a.artifactId) } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$appName",
          doc: { $first: "$$ROOT" },
        },
      },
    ])
    .toArray();

  const latestBuilds = builds.map((b) => b.doc);

  const technologies = latestBuilds
    .flatMap((b) => b.technologies)
    .filter(Boolean)
    .reduce(
      (acc, tech) => {
        if (
          !acc.find(
            (a: { section: string; technology: string }) =>
              a.technology === tech.technology,
          )
        ) {
          acc.push(tech);
        }
        return acc;
      },
      [] as { section: string; technology: string }[],
    );

  return c.json(technologies);
});

app.get("/builds", async (c) => {
  const { id } = c.req.param();

  const cacheKey = `offer:builds:${id}`;

  // 1 day
  const cacheTTL = 86400;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": `public, max-age=${cacheTTL}`,
    });
  }

  const offer = await Offer.findOne({ id });

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  const itemsSpecified = offer.items.map((item) => item.id);

  const subItems = await getOfferSubItems({
    _id: id,
  });

  const items = await Item.find({
    $or: [
      {
        id: {
          $in: [
            ...itemsSpecified,
            ...subItems.flatMap((i) => i.subItems.map((s) => s.id)),
          ],
        },
      },
      { linkedOffers: id },
    ],
  });

  const assets = await Asset.find({
    itemId: { $in: items.map((i) => i.id) },
  });

  const builds = await db.db
    .collection<{
      appName: string;
      labelName: string;
      buildVersion: string;
      hash: string;
    }>("builds")
    .find({
      appName: { $in: assets.map((a) => a.artifactId) },
    })
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray();

  await client.set(cacheKey, JSON.stringify(builds), "EX", 3600);

  return c.json(builds, 200, {
    "Cache-Control": `public, max-age=${cacheTTL}`,
  });
});

app.get("/igdb", async (c) => {
  const { id } = c.req.param();

  const igdb = await db.db.collection("igdb").findOne({
    offerId: id,
  });

  if (!igdb) {
    return c.json({ error: "IGDB data not found" }, 404);
  }

  return c.json(igdb);
});

app.get("/overview", async (c) => {
  const { id } = c.req.param();
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

  const start = new Date();
  const cacheKey = `overview:${id}:${region}:v0.1`;
  const cached = false; // await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  // Get base offer data
  const offer = await Offer.findOne({ id }).lean();

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  // Execute all data fetching in parallel for better performance
  const [price, media, igdb, subItems, sandbox, giveaways, genres] =
    await Promise.allSettled([
      // Price data
      PriceEngine.findOne({ offerId: id, region }),
      // Media data
      Media.findOne({ _id: id }),
      // IGDB data
      db.db.collection("igdb").findOne({ offerId: id }),
      // Sub items for features and technologies
      getOfferSubItems({ _id: id }),
      // Sandbox for age ratings and ratings
      Sandbox.findOne({ _id: offer.namespace }),
      // Giveaways
      FreeGames.find({ id }, undefined, { sort: { startDate: -1 } }),
      // Genres
      Tags.find({ groupName: "genre", status: "ACTIVE" }),
    ]);

  // Get items for features and technologies
  const subItemsData = subItems.status === "fulfilled" ? subItems.value : [];
  const items = await Item.find({
    $or: [
      {
        id: {
          $in: [
            ...offer.items.map((i) => i.id),
            ...subItemsData.flatMap((i) => i.subItems.map((s) => s.id)),
          ],
        },
      },
      { linkedOffers: id },
    ],
  });

  // Get features
  const customAttributes = items.reduce((acc, item) => {
    return Object.assign(acc, attributesToObject(item.customAttributes));
  }, attributesToObject([]));

  const tagsObject = offer.tags.reduce((acc: Record<string, unknown>, tag) => {
    acc[tag.id] = tag;
    return acc;
  }, {});

  const features = getGameFeatures({
    attributes: customAttributes,
    // @ts-expect-error
    tags: tagsObject,
  });

  // Get age ratings
  let ageRating = null;
  const sandboxData = sandbox.status === "fulfilled" ? sandbox.value : null;
  if (sandboxData && "ageGatings" in sandboxData) {
    const selectedRating =
      Object.entries(ageRatingsCountries).find(([, rating]) =>
        rating.includes(selectedCountry),
      )?.[0] ?? "Generic";

    const ageGatings = sandboxData.ageGatings as Record<string, unknown>;
    const rating = ageGatings[selectedRating];
    if (rating) {
      ageRating = { [selectedRating]: rating };
    }
  }

  // Get polls
  const polls = await db.db.collection("ratings_polls").findOne({
    _id: sandboxData?.id,
  });

  // Get technologies
  const assets = await Asset.find({
    itemId: { $in: items.map((i) => i.id) },
  });

  const builds = await db.db
    .collection("builds")
    .aggregate([
      { $match: { appName: { $in: assets.map((a) => a.artifactId) } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$appName",
          doc: { $first: "$$ROOT" },
        },
      },
    ])
    .toArray();

  const latestBuilds = builds.map((b) => b.doc);
  const technologies = latestBuilds
    .flatMap((b) => b.technologies || [])
    .filter(Boolean)
    .reduce((acc: Array<{ technology: string }>, tech) => {
      if (!acc.find((a) => a.technology === tech.technology)) {
        acc.push(tech);
      }
      return acc;
    }, []);

  // Filter genres from offer tags
  const genresData = genres.status === "fulfilled" ? genres.value : [];
  const offerGenres = offer.tags.filter((tag) =>
    genresData?.map((genre) => genre?.id).includes(tag?.id),
  );

  // Combine all data
  const result = {
    offer: {
      ...orderOffersObject(offer),
      customAttributes: attributesToObject(
        offer.customAttributes as unknown as Array<{
          key: string;
          value: string;
        }>,
      ),
    },
    price: price.status === "fulfilled" ? price.value : null,
    media: media.status === "fulfilled" ? media.value : null,
    igdb: igdb.status === "fulfilled" ? igdb.value : null,
    features,
    ageRating,
    giveaways: giveaways.status === "fulfilled" ? giveaways.value : [],
    polls,
    genres: offerGenres,
    technologies,
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
    "Server-Timing": `db;dur=${Date.now() - start.getTime()}`,
  });
});

export default app;
