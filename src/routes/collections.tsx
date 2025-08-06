import React from "react";
import { Hono } from "hono";
import { Offer } from "@egdata/core.schemas.offers";
import { PriceEngine } from "@egdata/core.schemas.price";
import { Collection, GamePosition } from "@egdata/core.schemas.collections";
import { getCookie } from "hono/cookie";
import { regions } from "../utils/countries.js";
import client from "../clients/redis.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getImage } from "../utils/get-image.js";
import satori from "satori";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { db } from "../db/index.js";
import consola from "consola";
import { writeFile } from "node:fs/promises";

/**
 * This function converts a week string (e.g. 2022W01) to a start and end date.
 * @param week A string in the format YYYYWNN (e.g., "2022W01").
 * @returns An object with the start and end dates of the given week.
 */
function getWeek(week: `${number}W${number}`): { start: Date; end: Date } {
  const [year, weekNumber] = week.split("W").map(Number);

  // Jan 4th of the given year is always in week 1 according to ISO-8601
  const jan4 = new Date(Date.UTC(year, 0, 4));

  // Find the first Monday of the ISO week year
  const dayOfWeek = jan4.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - ((dayOfWeek + 6) % 7)); // Adjust to the previous Monday if necessary

  // Calculate the start date of the given week
  const start = new Date(firstMonday);
  start.setUTCDate(firstMonday.getUTCDate() + (weekNumber - 1) * 7);

  // Calculate the end date of the given week
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  return { start, end };
}

const app = new Hono();

app.get("/:slug", async (c) => {
  const { slug } = c.req.param();

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

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10"), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1"), 1);
  const skip = (page - 1) * limit;

  const cacheKey = `collections:${slug}:${region}:${page}:${limit}:v0.1`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const collection = await Collection.findOne({
    _id: slug,
  });

  if (!collection) {
    c.status(404);
    return c.json({
      message: "Collection not found",
    });
  }

  const totalOffersCount = await GamePosition.countDocuments({
    collectionId: collection._id,
    position: { $gt: 0 },
  });

  const offersList = await GamePosition.find({
    collectionId: collection._id,
    position: { $gt: 0 },
  })
    .sort({ position: 1 })
    .limit(limit)
    .skip(skip);

  const offersIds = offersList.map((o) => o.offerId);

  const [offersData, pricesData] = await Promise.allSettled([
    Offer.find({
      id: { $in: offersIds },
    }),
    PriceEngine.find({
      offerId: { $in: offersIds },
      region,
    }),
  ]);

  const offers = offersData.status === "fulfilled" ? offersData.value : [];
  const prices = pricesData.status === "fulfilled" ? pricesData.value : [];

  const result = {
    elements: offers
      .map((o) => {
        const price = prices.find((p) => p.offerId === o.id);
        const collectionOffer = offersList.find(
          (i) => i.toJSON().offerId === o.id,
        );

        console.log(
          `Offer ${o.title} has position ${collectionOffer?.position}`,
        );

        return {
          ...o.toObject(),
          price: price ?? null,
          position: collectionOffer?.position ?? totalOffersCount,
          previousPosition: collectionOffer?.previous,
          metadata: collectionOffer,
        };
      })
      .sort(
        (a, b) =>
          (a.position ?? totalOffersCount) - (b.position ?? totalOffersCount),
      ),
    page,
    limit,
    title: collection.name,
    total: totalOffersCount,
    updatedAt: collection.updatedAt.toISOString(),
  };

  await client.set(cacheKey, JSON.stringify(result), 'EX', 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

/**
 * Gets the collection's offers for a specific week
 * The week is formatted as YYYYWNN (e.g. 2025W31)
 */
app.get("/:slug/:week", async (c) => {
  const { slug, week } = c.req.param();
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

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10"), 50);
  const page = Math.max(Number.parseInt(c.req.query("page") || "1"), 1);
  const skip = (page - 1) * limit;

  const cacheKey = `collections:${week}:${slug}:${region}:${page}:${limit}`;

  // const cached = await client.get(cacheKey);
  // if (cached) {
  //   return c.json(JSON.parse(cached), 200, { "Cache-Control": "public, max-age=60" });
  // }

  // IMPORTANT: endExclusive (not inclusive) to avoid picking next week's first snapshot
  const { start, endExclusive } = getIsoWeekRangeUTC(week); // see helper below

  const collection = await Collection.findOne({ _id: slug });
  if (!collection) {
    return c.json({ error: "Collection not found" }, 404);
  }

  // Pull all positions for this collection (consider aggregation/index note below for perf)
  const offers = await GamePosition.find({ collectionId: collection._id });

  const inWeek = (d: Date) =>
    d.getTime() >= start.getTime() && d.getTime() < endExclusive.getTime();

  // Keep offers that have at least one position in the week
  const offersWithPositions = offers
    .map((offer) => {
      const positionsInWeek = offer.positions.filter((p) =>
        inWeek(new Date(p.date)) && Number(p.position) > 0
      );

      if (positionsInWeek.length === 0) return null;

      // Most recent position within the week (already > 0)
      const latest = positionsInWeek.reduce((a, b) =>
        new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b
      );

      return {
        ...offer.toJSON(),
        position: latest?.position as number | undefined,
        positions: positionsInWeek,
      };
    })
    .filter(Boolean)
    .filter((o) => o !== null)

  const ranked = (offersWithPositions as Array<{ position?: number }>)
    .filter((o) => typeof o.position === "number" && (o.position as number) > 0)
    .sort((a, b) => (a.position as number) - (b.position as number));

  const pageItems = ranked.slice(skip, skip + limit);

  const pageOfferIds = pageItems.map((o) => o.offerId);
  const [offersData, pricesData] = await Promise.all([
    Offer.find({ id: { $in: pageOfferIds } }),
    PriceEngine.find({ offerId: { $in: pageOfferIds }, region }),
  ]);

  const offersWithMetadata = pageItems
    .map((o) => {
      const offerData = offersData.find((x) => x.id === o.offerId);
      const priceData = pricesData.find((x) => x.offerId === o.offerId);
      if (!offerData || !priceData) {
        console.error(`Offer or price not found for ${o.offerId}`);
        return null;
      }
      return {
        ...offerData.toJSON(),
        metadata: o,
        price: priceData.toJSON(),
      };
    })
    .filter(Boolean);

  const result = {
    elements: offersWithMetadata,
    page,
    limit,
    title: collection.name,
    // FIX: "total" should reflect the number of ranked items in this week, not raw insideWeek
    total: ranked.length,
    updatedAt: collection.updatedAt.toISOString(),
    start,          // Date (UTC) inclusive
    end: endExclusive, // Date (UTC) exclusive
  };

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);
  return c.json(result, 200, { "Cache-Control": "public, max-age=60" });
});

/** Helper: ISO week range (UTC), end is exclusive */
function getIsoWeekRangeUTC(week: string) {
  const m = /^(\d{4})W(\d{2})$/.exec(week);
  if (!m) throw new Error("Invalid week format, expected YYYYWNN (e.g., 2025W31)");
  const year = Number(m[1]);
  const wn = Number(m[2]);

  // ISO: Week 1 is the week with Jan 4. Weeks start Monday.
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay(); // 0=Sun..6=Sat
  const isoMonOfWeek1 = new Date(
    jan4 - ((jan4Day === 0 ? 6 : jan4Day - 1) * 24 * 3600 * 1000),
  ); // back to Monday

  const start = new Date(isoMonOfWeek1.getTime() + (wn - 1) * 7 * 24 * 3600 * 1000);
  const endExclusive = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  return { start, endExclusive };
}

app.get("/:slug/:week/og", async (c) => {
  const { slug, week } = c.req.param();
  const render = c.req.query("svg");
  const direct = c.req.query("direct");
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

  const limit = 10;
  const page = 1;
  const skip = 0; // first page only for OG

  const cacheKey = `collections:${week}:${slug}:${region}:${page}:${limit}:og`;

  // const cached = await client.get(cacheKey);
  // if (cached && !render) {
  //   return c.json(JSON.parse(cached), 200, { "Cache-Control": "public, max-age=60" });
  // }

  // Use ISO week with endExclusive
  const { start, endExclusive } = getIsoWeekRangeUTC(week as `${number}W${number}`);

  const collection = await Collection.findOne({ _id: slug });
  if (!collection) {
    return c.json({ error: "Collection not found" }, 404);
  }

  const offers = await GamePosition.find({ collectionId: collection._id });

  const inWeek = (d: Date) =>
    d.getTime() >= start.getTime() && d.getTime() < endExclusive.getTime();

  // Build weekly representative position per offer (latest snapshot within the week)
  const weeklyRanked = offers
    .map((offer) => {
      // ✅ filter by week AND position > 0
      const positionsInWeek = offer.positions.filter((p) =>
        inWeek(new Date(p.date)) && Number(p.position) > 0
      );
      if (positionsInWeek.length === 0) return null;

      const latest = positionsInWeek.reduce((a, b) =>
        new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b
      );

      return {
        ...offer.toJSON(),
        position: latest?.position as number | undefined, // > 0 by construction
        positions: positionsInWeek,
      };
    })
    .filter((o) => o && typeof o.position === "number" && (o.position as number) > 0)
    .filter((o) => o !== null)
    .sort((a, b) => (a.position as number) - (b.position as number));

  const topItems = weeklyRanked.slice(skip, skip + limit);
  const pageOfferIds = topItems.map((o) => o.offerId);

  const [offersData, pricesData] = await Promise.all([
    Offer.find({ id: { $in: pageOfferIds } }),
    PriceEngine.find({ offerId: { $in: pageOfferIds }, region }),
  ]);

  const offersWithMetadata = topItems
    .map((o) => {
      const offerData = offersData.find((x) => x.id === o.offerId);
      const priceData = pricesData.find((x) => x.offerId === o.offerId);
      if (!offerData || !priceData) {
        console.error(`Offer or price not found for ${o.offerId}`);
        return null;
      }
      return {
        ...offerData.toJSON(),
        metadata: o,
        price: priceData.toJSON(),
      };
    })
    .filter(Boolean)
    .filter((o) => o !== null);


  // Stable OG hash tied to week+region+top10 IDs/positions/prices
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      week,
      region,
      items: offersWithMetadata.map((g) => ({
        id: g.id,
        title: g.title,
        pos: g.metadata.position,
        dp: g.price?.price?.discountPrice ?? null,
        op: g.price?.price?.originalPrice ?? null,
        d: g.price?.price?.discount ?? null,
      })),
    }),
  );
  const hex = hash.digest("hex");

  // If we already rendered this exact OG image and not forcing SVG render, reuse it
  const existingImage = !render
    ? await db.db.collection("tops-og").findOne({ hash: hex })
    : null;

  if (existingImage && (!direct && !render)) {
    return c.json(
      {
        id: existingImage.imageId,
        url: `https://cdn.egdata.app/cdn-cgi/imagedelivery/RlN2EBAhhGSZh5aeUaPz3Q/${existingImage.imageId}/og`,
      },
      200,
    );
  }

  // ---- FLEX TABLE LAYOUT (Satori) ----
  // Use the same column spec for header and rows
  const COLS = [
    { key: 'rank', label: 'Rank', flex: 0.6 },
    { key: 'title', label: 'Title', flex: 3.0 },
    { key: 'discount', label: 'Discount', flex: 1.0 },
    { key: 'original', label: 'Original', flex: 1.0 },
    { key: 'price', label: 'Price', flex: 1.3 },
  ];

  const headerCell = (text: string, flex = 1) => (
    <div
      style={{
        display: 'flex',
        flexGrow: flex,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        fontWeight: 'bold',
        color: 'white',
        fontSize: '18px',
        padding: '10px 14px',
        alignItems: 'center',
      }}
    >
      {text}
    </div>
  );

  const cell = (content: unknown, flex = 1) => (
    <div
      style={{
        display: 'flex',
        flexGrow: flex,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        fontSize: '16px',
        color: '#ddd',
        padding: '10px 14px',
        alignItems: 'center',
      }}
    >
      {content}
    </div>
  );

  // Build rows for top 10
  const rows = Array.from({ length: limit }).map((_, i) => {
    const game = offersWithMetadata[i];
    const visible = Boolean(game);

    const currencyFmtr = Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: game?.price?.price?.currencyCode ?? 'USD',
    });

    return (
      <div
        key={game._id}
        style={{
          display: visible ? 'flex' : 'none',
          flexDirection: 'row',
          alignItems: 'center',
          width: '100%',
          borderTop: '1px solid #3a3a6e', // row divider
          backgroundColor: i % 2 === 0 ? '#1a1a3e' : '#20204a',
        }}
      >
        {cell(`#${i + 1}`, COLS[0].flex)}
        {cell(game?.title ?? 'N/A', COLS[1].flex)}
        {cell(
          game?.price?.price?.originalPrice &&
            game?.price?.price?.discountPrice &&
            game.price.price.originalPrice !== game.price.price.discountPrice
            ? `-${Math.round(((game.price.price.originalPrice - game.price.price.discountPrice) / game.price.price.originalPrice) * 100)}%`
            : '',
          COLS[2].flex
        )}
        {cell(
          game?.price?.price?.originalPrice &&
            game.price.price.originalPrice !== game.price.price.discountPrice
            ? currencyFmtr.format(game.price.price.originalPrice / 100)
            : '',
          COLS[3].flex
        )}
        {cell(
          game
            ? game.price?.price?.discountPrice === 0
              ? 'Free'
              : currencyFmtr.format((game.price?.price?.discountPrice ?? 0) / 100)
            : '',
          COLS[4].flex
        )}
      </div>
    );
  });

  const svg = await satori(
    // @ts-expect-error
    <div
      style={{
        height: '630px',
        width: '1200px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        backgroundColor: '#0f0f23',
        backgroundImage: 'linear-gradient(45deg, #0f0f23 0%, #1a1a3e 100%)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '32px',
        boxSizing: 'border-box',
        gap: '16px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          color: 'white',
        }}
      >
        <div style={{ display: 'flex', fontSize: '40px' }}>🎮</div>
        <div style={{ display: 'flex', fontSize: '36px', fontWeight: 'bold' }}>
          Epic Games Store — Top Sellers
        </div>
        <div style={{ display: 'flex', marginLeft: 'auto', color: '#aaa' }}>
          {String(week)} · {region}
        </div>
      </div>

      {/* Table (single outer border fixes header artifact) */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          border: '2px solid #3a3a6e',
          borderRadius: '10px',
          overflow: 'hidden',
          width: '100%',
          backgroundColor: '#20204a',
        }}
      >
        {/* Table header row */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: '#2a2a4e',
          }}
        >
          {headerCell(COLS[0].label, COLS[0].flex)}
          {headerCell(COLS[1].label, COLS[1].flex)}
          {headerCell(COLS[2].label, COLS[2].flex)}
          {headerCell(COLS[3].label, COLS[3].flex)}
          {headerCell(COLS[4].label, COLS[4].flex)}
        </div>

        {/* Table body */}
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          {rows}
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          color: '#999',
          fontSize: '14px',
        }}
      >
        <span style={{ display: 'flex' }}>{String(week)}</span>
        <span style={{ display: 'flex', color: '#666' }}>•</span>
        <span style={{ display: 'flex' }}>
          {start.toISOString().slice(0, 10)} - {endExclusive.toISOString().slice(0, 10)}
        </span>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'Roboto',
          data: readFileSync(resolve('./src/static/Roboto-Light.ttf')),
          weight: 400,
          style: 'normal',
        },
      ],
    },
  );

  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [resolve("./src/static/Roboto-Light.ttf")],
      loadSystemFonts: false,
    },
    fitTo: { mode: "width", value: 2800 },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  if (direct) {
    return c.body(new Uint8Array(pngBuffer), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    });
  }

  const cfImagesUrl =
    "https://api.cloudflare.com/client/v4/accounts/7da0b3179a5b5ef4f1a2d1189f072d0b/images/v1";
  const accessToken = process.env.CF_IMAGES_KEY;

  const formData = new FormData();
  formData.set(
    "file",
    new Blob([pngBuffer], { type: "image/png" }),
    `tops-og/${hex}.png`,
  );

  const response = await fetch(cfImagesUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });

  if (!response.ok) {
    console.error("Failed to upload image", await response.json());
    return c.json({ error: "Failed to upload image" }, 400);
  }

  const responseData = (await response.json()) as { result: { id: string } };

  await db.db.collection("tops-og").updateOne(
    { imageId: responseData.result.id },
    { $set: { imageId: responseData.result.id, hash: hex } },
    { upsert: true },
  );

  const payload = {
    id: responseData.result.id,
    url: `https://cdn.egdata.app/cdn-cgi/imagedelivery/RlN2EBAhhGSZh5aeUaPz3Q/${responseData.result.id}/og`,
  };

  // await client.set(cacheKey, JSON.stringify(payload), "EX", 3600);

  return c.json(payload, 200);
});

export default app;
