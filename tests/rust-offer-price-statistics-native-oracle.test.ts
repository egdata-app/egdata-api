import { BSON, BSONSymbol, Decimal128, Long } from "mongodb";
import { it, expect, vi } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle, fixtureValue } from "../rust/oracles/record.js";
import { PriceEngineHistorical } from "../src/models/index.js";
import offerDetails from "../src/v1/routes/offer-details.js";

it("records price statistics and price history against native Mongo values", async () => {
  const { record, cases } = recordMongoReads(offerDetails);
  const stats = "/v1/offers/offer-oracle/price-stats?country=fr&locale=fr-FR";
  const hist = "/v1/offers/offer-oracle/price-history";
  const raw = (
    originalPrice: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    offerId: Decimal128.fromString("24.00"),
    region: "EURO",
    updatedAt: new Date("2025-10-13T00:00:00Z"),
    date: new Date("2025-10-12T00:00:00Z"),
    price: {
      currencyCode: "EUR",
      discountPrice: Decimal128.fromString("349.8"),
      originalPrice,
      payoutCurrencyExchangeRate: 1.75,
      ...extra,
    },
  });
  const ordinary = raw(125.5),
    decimal = raw(Decimal128.fromString("410.50"));
  const statsSeed = (
    current: unknown,
    lowest: unknown,
    last: unknown,
    offer: unknown = {},
  ) => ({
    offers: offer,
    pricev2: current,
    __sequence: { "pricev2_historical.one": [lowest, last] },
  });
  for (const [name, row] of Object.entries({
    decimal,
    unpromoted: raw(Long.fromString("9007199254740999")),
    unknownRate: raw(125, { payoutCurrencyExchangeRate: "1.25" }),
    otherField: raw(123.5, { discountPrice: "123" }),
    bogusDiscount: raw(12.5, { currencyCode: "USD", discountPrice: [3, 4] }),
    sparse: {
      offerId: "sparse",
      currencyCode: "JPY",
      discountPrice: Decimal128.fromString("349.80"),
      price: null,
    },
    negative: raw(-40),
    usd: raw(25.5, {
      currencyCode: "USD",
      payoutCurrencyExchangeRate: { rate: 1 },
    }),
    exchangeDecimal: raw(125.5, {
      payoutCurrencyExchangeRate: Decimal128.fromString("1.175"),
    }),
  })) {
    await record(
      `stats-native-${name}`,
      stats,
      200,
      statsSeed(row, ordinary, row),
    );
  }
  const bad = raw(7, { currencyCode: { code: "foreign" } });
  for (const [i, name] of ["current", "lowest", "last"].entries()) {
    const slots = [ordinary, decimal, ordinary];
    const args = (value: unknown) => slots.map((v, n) => (n === i ? value : v));
    const invalid = args(bad);
    const failure = args("FAIL");
    await record(
      `stats-invalid-${name}-currency`,
      stats,
      500,
      statsSeed(invalid[0], invalid[1], invalid[2]),
    );
    await record(
      `stats-${name}-read-failure`,
      stats,
      500,
      statsSeed(failure[0], failure[1], failure[2]),
    );
  }
  for (const [name, source, status] of [
    [
      "lowercase-blocked",
      { countriesWhitelist: ["fr"], countriesBlacklist: ["FR"] },
      200,
    ],
    ["out-of-country", { countriesWhitelist: ["US"] }, 200],
    ["lowercase-allowed", { countriesWhitelist: ["fr"] }, 500],
    ["malformed-list", { countriesBlacklist: "FR" }, 500],
    ["malformed-entry", { countriesWhitelist: [null] }, 500],
  ] as const)
    await record(
      `stats-availability-${name}`,
      stats,
      status,
      statsSeed(bad, decimal, null, source),
    );
  for (const seed of [
    statsSeed(null, null, null),
    statsSeed(ordinary, null, null),
    statsSeed(null, decimal, null),
  ]) {
    await record(`stats-independent-missing-${cases.length}`, stats, 200, seed);
  }
  const storedRows = [
    raw(Long.fromNumber(125), {
      payoutCurrencyExchangeRate: Long.fromNumber(2),
      currencyCode: new BSONSymbol("EUR"),
    }),
  ];
  const promoted = BSON.deserialize(BSON.serialize({ rows: storedRows }))
    .rows[0];
  await record(
    "stats-native-driver-promotion",
    stats,
    200,
    statsSeed(promoted, promoted, promoted),
  );
  type Trace = {
    trace: Array<{
      call: { collection?: string; method: string };
      result?: unknown;
    }>;
  };
  for (const step of (cases.at(-1) as Trace).trace) {
    if (step.call.collection?.startsWith("pricev2"))
      step.result = fixtureValue(storedRows[0], true);
  }
  for (const [name, region] of [
    ["typed-decimal", Decimal128.fromString("23.00")],
    ["typed-long", Long.fromString("9007199254741011")],
    ["noncoercible", { toString: "broken" }],
    ["inherited-key", "constructor"],
    ["ignored-null", null],
  ] as const) {
    const rows = [
      { ...decimal, region },
      { ...ordinary, region: "EURO" },
    ];
    const good = name !== "noncoercible" && name !== "inherited-key";
    await record(`history-group-${name}`, hist, good ? 200 : 500, {
      offers: { id: "offer-oracle" },
      pricev2_historical: rows,
    });
  }
  for (const [name, hit] of [
    ["array", ["a", "b"]],
    ["text", "A🎮"],
    ["scalar", false],
  ] as const)
    await record(`history-group-cache-${name}`, hist, 200, {}, hit);
  for (const [name, hit] of [
    ["absent", {}],
    ["only-elements", { elements: [7] }],
    ["only-meta", { pagination: { limit: 5 } }],
  ] as const)
    await record(
      `history-page-cache-${name}`,
      hist + "?region=EURO",
      200,
      {},
      hit,
    );
  // Hold one historical Mongo promise past the current-price failure.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resumed!: () => void;
  const finished = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const find = PriceEngineHistorical.findOne.bind(PriceEngineHistorical);
  let started = false;
  const spy = vi
    .spyOn(PriceEngineHistorical, "findOne")
    .mockImplementation((...args) => {
      const query = find(...args);
      if (!started) {
        started = true;
        const lean = query.lean.bind(query);
        vi.spyOn(query, "lean").mockImplementation(async () => {
          const row = await lean();
          await held;
          resumed();
          return row;
        });
      }
      return query;
    });
  try {
    await record(
      "stats-immediate-error-with-pending-history",
      stats,
      500,
      statsSeed("FAIL", ordinary, decimal),
    );
    expect(started).toBe(true);
    const last = cases.at(-1) as Trace & {
      remainingReadsAfterResponse: number;
    };
    last.remainingReadsAfterResponse = 0;
    const read = last.trace.find(
      (step) => step.call.collection === "pricev2_historical",
    )!;
    Object.assign(read, { releaseAfterResponse: true });
  } finally {
    release();
    spy.mockRestore();
  }
  await finished;
  assertOracle("offer-price-statistics-native-http-node", cases);
});
