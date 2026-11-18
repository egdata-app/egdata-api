import { it, vi } from "vitest";
import { Hono } from "hono";
import { BSON, Decimal128, Long, ObjectId } from "mongodb";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";

const recorder = createReadRecorder();
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name: string) => recorder.collection(name) } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: (...args: Parameters<typeof recorder.cache.get>) =>
      recorder.cache.get(...args),
    set: (...args: Parameters<typeof recorder.cache.set>) =>
      recorder.cache.set(...args),
  },
}));
// Only the public review summary is mounted for calls in this suite.
vi.mock("../src/routes/auth.js", () => ({ epic: vi.fn(), epicInfo: vi.fn() }));
vi.mock("../src/clients/epic.js", () => ({ epicStoreClient: {} }));

it("records legacy offer prices, requirements, and review summary HTTP and service calls", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  try {
    const app = new Hono();
    app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
    app.route(
      "/offers/:id",
      (await import("../src/routes/offers/price.js")).default,
    );
    app.route(
      "/offers/:id",
      (await import("../src/routes/offers/requirements.js")).default,
    );
    app.route(
      "/offers/:id",
      (await import("../src/routes/offers/reviews.js")).default,
    );
    const cases: Awaited<ReturnType<typeof recorder.record>>[] = [];
    type Read = Parameters<typeof recorder.record>[4][number];
    const get = async (
      name: string,
      path: string,
      status: number,
      reads: Read[] = [],
      hit: unknown = null,
      headers?: Record<string, string>,
    ) => {
      cases.push(
        await recorder.record(
          app,
          name,
          { method: "GET", path: "/offers/game/" + path, headers },
          status,
          reads,
          hit,
        ),
      );
    };
    const date = new Date("2026-01-01T12:30:20Z");
    const offer = { id: "game", namespace: "sandbox", releaseDate: date };
    const live = () => ({
      _id: new ObjectId("65bb00000000000000000001"),
      offerId: "game",
      region: "US",
      updatedAt: date,
      price: {
        currencyCode: "USD",
        discountPrice: 650,
        originalPrice: 1000,
        discount: 350,
      },
      legacyField: "visible",
    });
    const past = () => ({
      ...live(),
      price: {
        currencyCode: "USD",
        discountPrice: 400,
        originalPrice: 1199,
        discount: 799,
      },
    });
    const offerRead = (value: unknown = offer): Read => [
      "offers",
      "one",
      value,
    ];
    const h = (value: unknown): Read => ["pricev2_historical", "many", value];
    const current = (value: unknown): Read => ["pricev2", "one", value];
    await get("price-country", "price?country=zz", 404);
    await get("price-offer-missing", "price", 404, [offerRead(null)]);
    await get("price-blocked", "price", 404, [
      offerRead({ ...offer, countriesBlacklist: ["US"] }),
    ]);
    await get("price-row-missing", "price", 404, [offerRead(), current(null)]);
    await get(
      "price-cookie",
      "price",
      200,
      [offerRead(), current(live())],
      null,
      { cookie: "EGDATA_COUNTRY=US" },
    );
    await get("price-cache", "price", 200, [offerRead()], { saved: true });
    await get("fairness-found", "price/fairness?country=ZZ", 200, [
      [
        "offer_country_pricing_scores",
        "one",
        { _id: "foo", country: "ZZ", score: 0 },
      ],
    ]);
    await get("fairness-missing", "price/fairness", 404, [
      ["offer_country_pricing_scores", "one", null],
    ]);
    await get("fairness-cache", "price/fairness", 200, [], {
      country: "US",
      score: 55,
    });
    await get(
      "history-region",
      "price-history?country=US&since=2026-01-01",
      200,
      [h([past()])],
    );
    await get(
      "history-override",
      "price-history?country=US&region=custom&since=",
      200,
      [h([])],
    );
    for (const since of ["2026", "2026-11", "not-a-date"]) {
      await get(
        "history-since-" + since,
        "price-history?region=US&since=" + since,
        200,
        [h([])],
      );
    }
    await get("history-all", "price-history", 200, [
      h([past(), { ...past(), region: "GB" }, {}]),
    ]);
    await get("history-all-empty", "price-history?country=UNKNOWN", 200, [
      h([]),
    ]);
    await get("history-hit", "price-history", 200, [], { US: [past()] });
    await get("regional-missing", "regional-price", 404, [offerRead(null)]);
    await get("regional-country", "regional-price?country=ZZ", 404, [
      offerRead(),
    ]);
    await get("regional-blocked", "regional-price?country=US", 404, [
      offerRead({ ...offer, countriesWhitelist: ["ES"] }),
    ]);
    await get("regional-missing-price", "regional-price?country=US", 404, [
      offerRead(),
      current(null),
      h([]),
      h([]),
    ]);
    await get("regional-live", "regional-price?country=US", 200, [
      offerRead(),
      current(live()),
      h([past()]),
    ]);
    await get("regional-fallback", "regional-price?country=US", 200, [
      offerRead(),
      current(null),
      h([]),
      h([past()]),
    ]);
    await get("regional-all", "regional-price", 200, [
      offerRead(),
      ["pricev2", "many", [live()]],
      h([{ ...past(), region: "GB" }, past()]),
    ]);
    await get("regional-all-empty", "regional-price", 200, [
      offerRead(),
      ["pricev2", "many", []],
      h([]),
      h([]),
    ]);
    await get("regional-cache", "regional-price", 200, [offerRead()], {
      US: { cached: true },
    });
    await get("stats-country", "price-stats?country=ZZ", 404);
    await get("stats-offer", "price-stats", 404, [offerRead(null)]);
    await get("stats", "price-stats", 200, [
      offerRead(),
      current(live()),
      ["pricev2_historical", "one", past()],
      ["pricev2_historical", "one", null],
    ]);
    await get("stats-blocked", "price-stats", 200, [
      offerRead({ ...offer, countriesBlacklist: ["US"] }),
      current(live()),
      ["pricev2_historical", "one", null],
      ["pricev2_historical", "one", past()],
    ]);
    // Use the Mongo client's default read promotion, including native Long
    // objects outside its JS number range and Decimal128 objects at every value.
    const amount = (n: unknown) => BSON.deserialize(BSON.serialize({ n })).n;
    const priced = (n: unknown) => ({
      ...live(),
      price: { ...live().price, discountPrice: amount(n) },
    });
    const decimal = Decimal128.fromString("18.75");
    const large = Long.fromString("9007199254741091");
    for (const [name, values] of [
      [
        "decimal-long",
        [
          decimal,
          large,
          Long.fromString("-9007199254741091"),
          Long.fromNumber(6),
        ],
      ],
      ["decimal-nan", [Decimal128.fromString("NaN"), 7]],
      ["mixed-values", ["0x20", false, true, null, [5], "not a price"]],
    ] as const) {
      await get("regional-amount-" + name, "regional-price?country=US", 200, [
        offerRead(),
        current(priced(values[0])),
        h(values.map(priced)),
      ]);
    }
    for (const since of [
      "12/31/2025 GMT",
      "2025-02-29",
      "2025-13-01",
      "2025-01-01T24:00:00Z",
      "2025-02-01T11:29:00+02:00",
    ]) {
      await get(
        "historical-bound-" + since,
        "price-history?region=US&since=" + encodeURIComponent(since),
        200,
        [h([])],
      );
    }
    for (const [name, releaseDate] of [
      ["milliseconds", 123],
      ["string", "1000"],
      ["bool", true],
      ["decimal", decimal],
      ["future-long", large],
      ["iso-string", "2025-01-01"],
      ["empty", false],
    ] as const) {
      await get("regional-release-" + name, "regional-price?country=US", 200, [
        offerRead({ ...offer, releaseDate }),
        current(live()),
        h([past()]),
      ]);
    }
    for (const [name, price, status] of [
      ["scalar", 7, 500],
      ["zero", 0, 200],
      ["array", [], 200],
      ["absent", undefined, 200],
    ] as const) {
      await get("price-payout-" + name, "price", status, [
        offerRead(),
        current({ ...live(), price }),
      ]);
    }
    await get(
      "regional-incomplete-historical-price",
      "regional-price?country=US",
      500,
      [
        offerRead(),
        current(live()),
        h([priced("invalid"), { ...past(), price: null }]),
      ],
    );
    await get("regional-primitive-current", "regional-price?country=US", 500, [
      offerRead(),
      current({ ...live(), price: true }),
      h([past()]),
    ]);
    const all = (rows: unknown[]): Read => ["pricev2", "many", rows];
    for (const [name, rows, liveRows, status] of [
      ["single-sparse-date", [{ ...past(), updatedAt: null }], [], 200],
      ["unusable-dates", [{ ...past(), updatedAt: null }, past()], [], 500],
      [
        "live-skips-sort",
        [{ ...past(), updatedAt: null }, past()],
        [live()],
        200,
      ],
      [
        "most-recent",
        [past(), { ...priced(decimal), updatedAt: new Date("2026-02-01Z") }],
        [],
        200,
      ],
    ] as const) {
      await get("regional-all-" + name, "regional-price", status, [
        offerRead(),
        all([...liveRows]),
        h(rows),
      ]);
    }
    await get("history-region-keys", "price-history", 200, [
      h([
        { region: 5 },
        { region: 0 },
        { region: false },
        { region: ["US", "GB"] },
      ]),
    ]);
    await get(
      "history-shared-cache-array",
      "price-history",
      200,
      [],
      [false, 0, { old: true }],
    );
    await get(
      "history-region-cache-false",
      "price-history?country=US",
      200,
      [],
      false,
    );
    await get(
      "regional-old-cache",
      "regional-price?country=US",
      200,
      [offerRead()],
      ["old shape"],
    );
    const historical = (n: unknown): Read => ["pricev2_historical", "one", n];
    await get("stats-native-discounts", "price-stats", 200, [
      offerRead(),
      current(priced(decimal)),
      historical(priced(large)),
      historical(priced(Long.fromNumber(22))),
    ]);
    await get("stats-invalid-lowest", "price-stats", 500, [
      offerRead(),
      current(live()),
      historical({ ...past(), price: "invalid" }),
      historical(null),
    ]);
    await get("stats-live-read-failure", "price-stats", 500, [
      offerRead(),
      current(new Error("fixture failure")),
      historical(past()),
      historical(null),
    ]);
    await get("regional-retry-failure", "regional-price?country=US", 500, [
      offerRead(),
      current(null),
      h([]),
      h(new Error("fixture failure")),
    ]);
    for (const [path, raw, status, reads] of [
      ["price-history", "null", 200, []],
      ["price-history?region=US", "", 200, [h([])]],
      ["regional-price?country=US", "{corrupt", 500, [offerRead()]],
    ] as const) {
      cases.push(
        await recorder.record(
          app,
          "price-raw-cache-" + path,
          { method: "GET", path: "/offers/game/" + path },
          status,
          [...reads],
          null,
          [],
          undefined,
          raw,
        ),
      );
    }
    for (const [name, path, reads, failedCall] of [
      ["regional-cache-read", "regional-price", [offerRead()], 1],
      ["history-cache-set", "price-history?region=US", [h([past()])], 2],
      ["current-cache-set", "price", [offerRead(), current(live())], 3],
    ] as const) {
      cases.push(
        await recorder.record(
          app,
          name + "-failed",
          { method: "GET", path: "/offers/game/" + path },
          500,
          [...reads],
          null,
          [],
          failedCall,
        ),
      );
    }
    await get("history-compound-region-key", "price-history", 200, [
      h([{ region: ["US", decimal] }]),
    ]);
    await get("regional-all-eligibility", "regional-price", 200, [
      offerRead({ ...offer, countriesWhitelist: ["ES"] }),
      all([live()]),
      h([past()]),
    ]);
    for (const [name, raw, rate] of [
      ["beyond-i64", 1e25, 1],
      ["large-fx", 1e25, 125.5],
      ["fx-overflow", 1e308, 1e10],
      ["native-nan", Number.NaN, 1],
      ["native-infinity", Number.POSITIVE_INFINITY, 1],
    ] as const) {
      const row = () => ({
        ...live(),
        price: {
          ...live().price,
          currencyCode: "EUR",
          originalPrice: raw,
          discountPrice: raw,
          payoutCurrencyExchangeRate: rate,
        },
      });
      await get("regional-usd-" + name, "regional-price?country=US", 200, [
        offerRead(),
        current(row()),
        h([past(), row()]),
      ]);
      await get("stats-usd-" + name, "price-stats", 200, [
        offerRead(),
        current(row()),
        historical(row()),
        historical(null),
      ]);
    }
    const requirement = {
      namespace: "sandbox",
      offerId: "game",
      platform: "windows",
      offerType: "BASE_GAME",
      source: {
        sourceType: "product_page",
        observedAt: date,
        rawRows: [{ key: "OS" }],
      },
      processing: { sourceGeneration: 3, state: "normalized" },
      requirements: { minimum: { os: "Win" }, recommended: null },
    };
    const req = (v: unknown): Read => ["offer_requirements", "one", v];
    await get("requirements-missing", "requirements", 404, [offerRead(null)]);
    await get("requirements-empty", "requirements", 404, [
      offerRead(),
      req(null),
      req(null),
    ]);
    await get("requirements-found", "requirements", 200, [
      offerRead(),
      req(requirement),
      req(null),
    ]);
    await get("requirements-historical-omissions", "requirements", 200, [
      offerRead(),
      req({
        ...requirement,
        processing: { state: "legacy" },
        source: {},
        requirements: {
          recommended: null,
          minimum: { os: "Win", id: 73, __v: 2 },
          legacyNote: "kept",
        },
      }),
      req(null),
    ]);
    await get("requirements-historical-macos", "requirements", 200, [
      offerRead(),
      req(null),
      req({
        namespace: "sandbox",
        offerId: "game",
        platform: "macos",
        processing: {},
        source: { observedAt: "legacy timestamp" },
      }),
    ]);
    const reviews = (v: unknown): Read => ["reviews", "many", v];
    await get("reviews-empty", "reviews-summary", 200, [reviews([])]);
    await get("reviews-verified", "reviews-summary?verified=true", 200, [
      reviews([
        { rating: 4, recommended: true },
        { rating: 2, recommended: false },
        { rating: 2, recommended: true },
      ]),
    ]);
    await get("reviews-unverified", "reviews-summary?verified=false", 200, [
      reviews([{ rating: 0 }]),
    ]);
    await get("reviews-other", "reviews-summary?verified=other", 200, [
      reviews([]),
    ]);
    await get("reviews-cache", "reviews-summary?verified=", 200, [], {
      totalReviews: 5,
    });
    assertOracle("legacy-offer-prices-http-node", cases);
  } finally {
    vi.useRealTimers();
  }
});
