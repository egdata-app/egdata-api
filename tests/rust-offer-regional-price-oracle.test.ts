import { Decimal128, Long } from "mongodb";
import { expect, it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import catalog from "../src/v1/routes/catalog.js";
import offers from "../src/v1/routes/offers.js";
import offerDetails from "../src/v1/routes/offer-details.js";

it("records regional offer-price reads against the canonical handler", async () => {
  const { record, cases } = recordMongoReads(offerDetails, offers, catalog);
  const offer = {
    _id: "regional-offer-doc",
    id: "regional-offer-oracle",
    title: "Regional Oracle Game",
    countriesWhitelist: [],
    countriesBlacklist: ["RU"],
    releaseDate: new Date("2026-10-01T00:00:00.000Z"),
  };
  const price = (
    region: string,
    id: string,
    updatedAt: string,
    currencyCode: string,
    originalPrice: number,
    discountPrice: number,
    rate: number,
  ) => ({
    _id: id,
    offerId: offer.id,
    region,
    updatedAt: new Date(updatedAt),
    price: {
      currencyCode,
      originalPrice,
      discountPrice,
      discount: 25,
      basePayoutPrice: 0,
      payoutCurrencyExchangeRate: rate,
    },
  });

  const us = price(
    "US",
    "live-us",
    "2026-11-10T00:00:00.000Z",
    "USD",
    2000,
    1500,
    1,
  );
  const usHistory = [
    price(
      "US",
      "hist-us-new",
      "2026-11-12T00:00:00.000Z",
      "USD",
      2000,
      1200,
      1,
    ),
    price(
      "US",
      "hist-us-old",
      "2026-10-12T00:00:00.000Z",
      "USD",
      2000,
      1000,
      1,
    ),
  ];
  const gb = price(
    "GB",
    "hist-gb",
    "2026-11-11T00:00:00.000Z",
    "GBP",
    1599,
    1199,
    1.25,
  );

  await record(
    "offer-regional-single-price",
    `/v1/offers/${offer.id}/regional-price?country=US`,
    200,
    {
      offers: offer,
      pricev2: us,
      pricev2_historical: usHistory,
    },
  );
  await record(
    "offer-regional-history-current",
    `/v1/offers/${offer.id}/regional-price?country=US`,
    200,
    {
      offers: offer,
      pricev2: null,
      pricev2_historical: [usHistory[0]],
    },
  );
  await record(
    "offer-regional-empty-history-fallback",
    `/v1/offers/${offer.id}/regional-price?country=US`,
    404,
    {
      offers: offer,
      pricev2: null,
      pricev2_historical: [],
    },
  );
  await record(
    "offer-regional-grouped-price",
    `/v1/offers/${offer.id}/regional-price`,
    200,
    {
      offers: offer,
      pricev2: [us, gb],
      pricev2_historical: [...usHistory, gb],
    },
  );
  await record(
    "offer-regional-invalid-country",
    `/v1/offers/${offer.id}/regional-price?country=ZZ`,
    400,
    {
      offers: offer,
    },
  );
  await record(
    "offer-regional-country-ineligible",
    `/v1/offers/${offer.id}/regional-price?country=RU`,
    404,
    {
      offers: offer,
    },
  );
  await record(
    "offer-regional-cache-hit",
    `/v1/offers/${offer.id}/regional-price?country=US`,
    200,
    {
      offers: offer,
    },
    {
      currentPrice: null,
      maxPrice: 1200,
      minPrice: 1200,
      currentPriceUsd: 1200,
      currentOriginalPriceUsd: 2000,
      maxPriceUsd: 1200,
      minPriceUsd: 1200,
    },
  );

  for (const [name, amount, rate] of [
    ["beyond-i64", 1e25, 1],
    ["wide-fx", 1e25, 125.5],
    ["fx-overflow", 1e308, 1e10],
  ] as const) {
    const wide = price(
      "US",
      "wide-" + name,
      "2026-11-01T00:00:00Z",
      "EUR",
      amount,
      amount,
      rate,
    );
    const response = await record(
      "regional USD " + name,
      `/v1/offers/${offer.id}/regional-price?country=US`,
      200,
      { offers: offer, pricev2: wide, pricev2_historical: [usHistory[0]] },
    );
    expect(response).toMatchObject({
      data: {
        currentPriceUsd: Number.isFinite(amount * rate)
          ? Math.round(amount * rate)
          : null,
        minPriceUsd: 1200,
      },
    });
  }
  const native = (n: unknown) => ({
    ...us,
    price: { ...us.price, discountPrice: n, originalPrice: n },
  });
  const decimal = Decimal128.fromString("34.875");
  const large = Long.fromString("9007199254740997");
  for (const [name, current, historical, expected] of [
    [
      "decimal",
      native(decimal),
      [native(large), usHistory[0]],
      {
        minPrice: 34.875,
        maxPrice: 9007199254740996,
        minPriceUsd: 1200,
        maxPriceUsd: 1200,
        currentPriceUsd: null,
      },
    ],
    [
      "native-nan",
      native(Number.NaN),
      [usHistory[0]],
      { minPrice: null, maxPrice: null, minPriceUsd: null, maxPriceUsd: null },
    ],
    [
      "native-infinity",
      native(Number.POSITIVE_INFINITY),
      [usHistory[0]],
      { minPrice: 1200, maxPrice: null, minPriceUsd: 1200, maxPriceUsd: null },
    ],
    [
      "sparse",
      { ...us, price: null },
      [usHistory[0]],
      { minPrice: 0, maxPrice: 1200, minPriceUsd: 1200, maxPriceUsd: 1200 },
    ],
  ] as const) {
    const response = await record(
      "regional raw " + name,
      `/v1/offers/${offer.id}/regional-price?country=US`,
      200,
      { offers: offer, pricev2: current, pricev2_historical: historical },
    );
    expect(response).toMatchObject({ data: expected });
  }
  await record(
    "regional raw invalid current currency",
    `/v1/offers/${offer.id}/regional-price?country=US`,
    500,
    {
      offers: offer,
      pricev2: { ...us, price: { currencyCode: {} } },
      pricev2_historical: [usHistory[0]],
    },
  );
  const group = await record(
    "regional raw group historical current",
    `/v1/offers/${offer.id}/regional-price`,
    200,
    {
      offers: offer,
      pricev2: [],
      pricev2_historical: [
        { ...native(large), updatedAt: new Date("2026-04-01T00:00:00Z") },
        { ...native(decimal), updatedAt: "2026-10-03T00:00:00Z" },
      ],
    },
  );
  expect(group).toMatchObject({
    data: {
      US: {
        currentPrice: { discountPrice: 35 },
        minPrice: 34.875,
        maxPrice: 9007199254740996,
        currentPriceUsd: null,
      },
    },
  });
  const nestedPrice = {
    offerId: offer.id,
    region: "US",
    price: {
      currencyCode: "USD",
      discountPrice: Decimal128.fromString("349.8"),
    },
  };
  for (const path of ["/v1/offers", "/v1/latest-games"]) {
    const data = await record(`regional decimal nested ${path}`, path, 200, {
      offers: [offer],
      pricev2: [
        nestedPrice,
        // The service serializes only the price joined to a returned offer.
        { offerId: "unmatched", price: { currencyCode: {} } },
      ],
    });
    expect(data).toMatchObject({
      data: [{ price: { discountPrice: 350, price: { discountPrice: 350 } } }],
    });
    const flat = await record(`regional decimal flat ${path}`, path, 200, {
      offers: [offer],
      pricev2: [
        {
          offerId: offer.id,
          currencyCode: "USD",
          originalPrice: Long.fromString("799"),
          discountPrice: Decimal128.fromString("-12.5"),
        },
      ],
    });
    expect(flat).toMatchObject({
      data: [{ price: { originalPrice: 799, discountPrice: -12 } }],
    });
    await record(`regional invalid matched currency ${path}`, path, 500, {
      offers: [offer],
      pricev2: [
        { ...nestedPrice, price: { ...nestedPrice.price, currencyCode: {} } },
      ],
    });
  }
  assertOracle("offer-regional-price-http-node", cases);
});
