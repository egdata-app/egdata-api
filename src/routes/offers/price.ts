import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import client from "../../clients/redis.js";
import {
  Offer,
  OfferCountryPricingScore,
  PriceEngine,
  PriceEngineHistorical,
  type PriceEngineType as PriceType,
} from "../../models/index.js";
import { regions } from "../../utils/countries.js";
import { toUsdCents } from "../../utils/price-usd.js";

const app = new Hono();

app.get("/price-history", async (c) => {
  const { id } = c.req.param();
  const since = c.req.query("since");

  const country = c.req.query("country");
  const usrRegion = c.req.query("region");

  const region =
    usrRegion ||
    Object.keys(regions).find((r) => regions[r].countries.includes(country));

  if (region) {
    const cacheKey = `price-history:${id}:${region}:${
      since ?? "unlimited"
    }:v0.1`;
    const cached = await client.get(cacheKey);

    if (cached) {
      return c.json(JSON.parse(cached), 200, {
        "Cache-Control": "public, max-age=60",
      });
    }

    const prices = await PriceEngineHistorical.find({
      offerId: id,
      region,
      ...(since && {
        updatedAt: { $gte: new Date(since) },
      }),
    }).sort({ date: -1 });

    if (!prices) {
      c.status(200);
      return c.json({});
    }

    await client.set(cacheKey, JSON.stringify(prices), "EX", 3600);

    return c.json(prices, 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const cacheKey = `price-history:${id}:all:${since ?? "unlimited"}:v0.1`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached));
  }

  const prices = await PriceEngineHistorical.find({
    offerId: id,
    region: { $in: Object.keys(regions) },
    ...(since && {
      updatedAt: { $gte: new Date(since) },
    }),
  }).sort({ date: -1 });

  const pricesByRegion = prices.reduce(
    (acc, price) => {
      if (!price?.region) return acc;

      if (!acc[price.region]) {
        acc[price.region] = [];
      }

      acc[price.region].push(price);

      return acc;
    },
    {} as Record<string, PriceType[]>,
  );

  if (!pricesByRegion || Object.keys(pricesByRegion).length === 0) {
    c.status(200);
    return c.json({});
  }

  await client.set(cacheKey, JSON.stringify(pricesByRegion), "EX", 3600);

  return c.json(pricesByRegion, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/price", async (c) => {
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

  const cacheKey = `price:${id}:${region}:v0.2`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const price = await PriceEngine.findOne({
    offerId: id,
    region,
  }).lean();

  if (!price) {
    c.status(404);
    return c.json({
      message: "Price not found",
    });
  }

  if (price.price) {
    price.price.basePayoutPrice = toUsdCents(price.price, "original");
  }

  await client.set(cacheKey, JSON.stringify(price), "EX", 3600);

  return c.json(price, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/price/fairness", async (c) => {
  const { id } = c.req.param();
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  const cacheKey = `price-fairness:${id}:${selectedCountry}:v0.1`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const score = await OfferCountryPricingScore.findOne({
    offerId: id,
    country: selectedCountry,
  });

  if (!score) {
    c.status(404);
    return c.json({
      message: "Price fairness score not found",
    });
  }

  await client.set(cacheKey, JSON.stringify(score), "EX", 3600);

  return c.json(score, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/regional-price", async (c) => {
  const { id } = c.req.param();
  const country = c.req.query("country");

  if (country) {
    const region = Object.keys(regions).find((r) =>
      regions[r].countries.includes(country),
    );

    if (!region) {
      c.status(404);
      return c.json({
        message: "Country not found",
      });
    }

    const cacheKey = `regional-price:${id}:${region}:v0.4`;
    const cached = await client.get(cacheKey);

    if (cached) {
      return c.json(JSON.parse(cached), 200, {
        "Cache-Control": "public, max-age=60",
      });
    }

    const [offer, livePrice] = await Promise.all([
      Offer.findOne({ id }).lean(),
      PriceEngine.findOne({ offerId: id, region }).lean(),
    ]);

    const releaseDate = offer?.releaseDate ?? (offer?.effectiveDate as Date);
    const currentDate = new Date();

    const priceQuery = { offerId: id, region } as Record<string, unknown>;

    if (releaseDate && releaseDate <= currentDate) {
      priceQuery.updatedAt = { $gte: releaseDate, $lte: currentDate };
    }

    let price = await PriceEngineHistorical.find(priceQuery, undefined, {
      sort: {
        updatedAt: -1,
      },
    });

    if (!price || price.length === 0) {
      price = await PriceEngineHistorical.find(
        {
          offerId: id,
          region,
        },
        undefined,
        {
          sort: {
            updatedAt: -1,
          },
        },
      );

      if (price.length === 0 && !livePrice) {
        c.status(404);
        return c.json({
          message: "Price not found",
        });
      }
    }

    const currentPrice = livePrice || price[0];

    if (currentPrice?.price) {
      currentPrice.price.basePayoutPrice = toUsdCents(
        currentPrice.price,
        "original",
      );
    }

    const usdValues = price
      .map((p) => toUsdCents(p.price))
      .filter((v): v is number => v != null);

    if (livePrice?.price) {
      const liveUsd = toUsdCents(livePrice.price);
      if (liveUsd !== null) usdValues.unshift(liveUsd);
    }

    const result = {
      currentPrice: currentPrice,
      maxPrice: Math.max(
        ...[
          ...price.map((p) => p.price.discountPrice ?? 0),
          currentPrice.price.discountPrice ?? 0,
        ],
      ),
      minPrice: Math.min(
        ...[
          ...price.map((p) => p.price.discountPrice ?? 0),
          currentPrice.price.discountPrice ?? 0,
        ],
      ),
      currentPriceUsd: toUsdCents(currentPrice.price),
      currentOriginalPriceUsd: toUsdCents(currentPrice.price, "original"),
      maxPriceUsd: usdValues.length ? Math.max(...usdValues) : null,
      minPriceUsd: usdValues.length ? Math.min(...usdValues) : null,
    };

    await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

    return c.json(result, 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const cacheKey = `regional-price:${id}:all:v0.4`;
  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const [offer, livePrices] = await Promise.all([
    Offer.findOne({ id }).lean(),
    PriceEngine.find({ offerId: id }).lean(),
  ]);

  const releaseDate = offer?.releaseDate ?? (offer?.effectiveDate as Date);
  const currentDate = new Date();

  const priceQuery: Record<string, unknown> = { offerId: id };

  if (releaseDate && releaseDate <= currentDate) {
    priceQuery.updatedAt = { $gte: releaseDate };
  }

  let prices = await PriceEngineHistorical.find(priceQuery, undefined, {
    sort: {
      updatedAt: -1,
    },
  });

  if (prices.length === 0) {
    prices = await PriceEngineHistorical.find(
      {
        offerId: id,
      },
      undefined,
      {
        sort: {
          updatedAt: -1,
        },
      },
    );
  }

  const regionsKeys = Object.keys(regions);

  const result = regionsKeys.reduce(
    (acc, r) => {
      const regionPrices = prices.filter((p) => p?.region === r);
      const livePrice = livePrices.find((p) => p.region === r);

      if (!regionPrices.length && !livePrice) {
        return acc;
      }

      const lastPrice =
        livePrice ||
        regionPrices.sort(
          (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
        )[0];

      if (lastPrice?.price) {
        lastPrice.price.basePayoutPrice = toUsdCents(
          lastPrice.price,
          "original",
        );
      }

      const allPrices = [
        ...regionPrices.map((p) => p.price.discountPrice ?? 0),
        lastPrice.price.discountPrice ?? 0,
      ];

      const maxPrice = Math.max(...allPrices);
      const minPrice = Math.min(...allPrices);

      const usdValues = regionPrices
        .map((p) => toUsdCents(p.price))
        .filter((v): v is number => v != null);

      if (livePrice?.price) {
        const liveUsd = toUsdCents(livePrice.price);
        if (liveUsd !== null) usdValues.unshift(liveUsd);
      }

      acc[r] = {
        currentPrice: lastPrice,
        maxPrice,
        minPrice,
        currentPriceUsd: toUsdCents(lastPrice.price),
        currentOriginalPriceUsd: toUsdCents(lastPrice.price, "original"),
        maxPriceUsd: usdValues.length ? Math.max(...usdValues) : null,
        minPriceUsd: usdValues.length ? Math.min(...usdValues) : null,
      };

      return acc;
    },
    {} as Record<
      string,
      {
        currentPrice: PriceType;
        maxPrice: number;
        minPrice: number;
        currentPriceUsd: number | null;
        currentOriginalPriceUsd: number | null;
        maxPriceUsd: number | null;
        minPriceUsd: number | null;
      }
    >,
  );

  await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/price-stats", async (c) => {
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

  const offer = await Offer.findOne({ id });

  if (!offer) {
    c.status(404);
    return c.json({
      message: "Offer not found",
    });
  }

  const [currentPrice, lowestPrice, lastDiscountPrice] = await Promise.all([
    PriceEngine.findOne(
      {
        offerId: id,
        region,
      },
      undefined,
      {
        sort: {
          updatedAt: -1,
        },
      },
    ).lean(),
    PriceEngineHistorical.findOne(
      {
        offerId: id,
        region,
        "price.discount": { $gt: 0 },
      },
      undefined,
      {
        sort: {
          "price.discountPrice": 1,
        },
      },
    ).lean(),
    PriceEngineHistorical.findOne(
      {
        offerId: id,
        region,
        "price.discount": { $gt: 0 },
      },
      undefined,
      {
        sort: {
          updatedAt: -1,
        },
      },
    ).lean(),
  ]);

  const normalize = (p: PriceType | null) => {
    if (p?.price) {
      p.price.basePayoutPrice = toUsdCents(p.price, "original");
    }
    return p;
  };

  return c.json({
    current: normalize(currentPrice),
    lowest: normalize(lowestPrice),
    lastDiscount: normalize(lastDiscountPrice),
  });
});

export default app;
