import { it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import offerDetails from "../src/v1/routes/offer-details.js";

it("records current, fairness and summary offer price reads", async () => {
  const { record, cases } = recordMongoReads(offerDetails);
  const offer = {
    _id: "offer-doc",
    id: "offer-oracle",
    title: "Oracle Game",
    description: "Price fixture",
    offerType: "BASE_GAME",
    countriesWhitelist: [],
    countriesBlacklist: [],
    keyImages: [],
    tags: [],
    items: [],
  };
  const usPrice = {
    _id: "price-us",
    offerId: "offer-oracle",
    region: "US",
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    price: {
      currencyCode: "USD",
      originalPrice: 1999,
      discountPrice: 999,
      discount: 50,
      basePayoutPrice: 0,
      payoutCurrencyExchangeRate: 1,
    },
  };
  const euroPrice = {
    ...usPrice,
    _id: "price-eu",
    region: "EU",
    price: {
      ...usPrice.price,
      currencyCode: "EUR",
      originalPrice: 2499,
      discountPrice: 1249,
      payoutCurrencyExchangeRate: 0.91,
    },
  };
  const discountHistory = {
    ...usPrice,
    _id: "hist-discount",
    date: new Date("2026-10-15T00:00:00.000Z"),
    updatedAt: new Date("2026-10-15T00:00:00.000Z"),
    price: { ...usPrice.price, discountPrice: 1499 },
  };

  await record(
    "offer-price-current",
    "/v1/offers/offer-oracle/price?country=US",
    200,
    {
      offers: offer,
      pricev2: usPrice,
    },
  );
  await record(
    "offer-price-with-historical-top-level-currency",
    "/v1/offers/offer-oracle/price?country=US",
    200,
    {
      offers: offer,
      pricev2: {
        ...usPrice,
        currencyCode: "USD",
        price: { originalPrice: 1999, discountPrice: 999, discount: 50 },
      },
    },
  );
  await record(
    "offer-price-beyond-i64",
    "/v1/offers/offer-oracle/price?country=US",
    200,
    {
      offers: offer,
      pricev2: { ...usPrice, price: { ...usPrice.price, originalPrice: 1e25 } },
    },
  );
  await record(
    "offer-price-current-eu",
    "/v1/offers/offer-oracle/price?country=FR",
    200,
    {
      offers: offer,
      pricev2: euroPrice,
    },
  );
  await record(
    "offer-price-whitelist-precedes-blacklist",
    "/v1/offers/offer-oracle/price?country=US",
    200,
    {
      offers: {
        ...offer,
        countriesWhitelist: ["US"],
        countriesBlacklist: ["US"],
      },
      pricev2: usPrice,
    },
  );
  await record(
    "offer-price-country-blocked",
    "/v1/offers/offer-oracle/price?country=GB",
    404,
    {
      offers: { ...offer, countriesBlacklist: ["GB"] },
    },
  );
  await record(
    "offer-price-fairness",
    "/v1/offers/offer-oracle/price/fairness?country=US",
    200,
    {
      offers: offer,
      offer_country_pricing_scores: {
        _id: "score-id",
        offerId: "offer-oracle",
        country: "US",
        score: 0.75,
      },
    },
  );
  await record(
    "offer-price-stats",
    "/v1/offers/offer-oracle/price-stats?country=US",
    200,
    {
      offers: offer,
      pricev2: usPrice,
      "pricev2_historical.one": discountHistory,
    },
  );
  await record(
    "offer-price-missing",
    "/v1/offers/missing/price?country=US",
    404,
  );
  await record(
    "offer-price-fairness-missing",
    "/v1/offers/offer-oracle/price/fairness?country=US",
    404,
    {
      offers: offer,
    },
  );
  assertOracle("offer-prices-http-node", cases);
});
