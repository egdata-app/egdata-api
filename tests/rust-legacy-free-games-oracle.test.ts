import { Hono } from "hono";
import { afterEach, it, vi } from "vitest";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";
import { loadSeaQaOffers } from "./fixtures/seaqa.js";

const recorder = createReadRecorder();
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name: string) => recorder.collection(name) } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: (key: string) =>
      failedCache === "get"
        ? recorder.fail({ method: "get", key })
        : recorder.cache.get(key),
    set: (...args: Parameters<typeof recorder.cache.set>) =>
      failedCache === "set"
        ? recorder.fail({
            method: "set",
            key: args[0],
            payload: JSON.parse(args[1]),
            ttl: args[3],
          })
        : recorder.cache.set(...args),
  },
}));
let hits: unknown;
let failedCache: "get" | "set" | undefined;
vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: {
    search: async (data: object) => {
      if (hits instanceof Error)
        recorder.fail({ service: "opensearch", method: "search", ...data });
      const body = { hits };
      recorder.service(
        { service: "opensearch", method: "search", ...data },
        body,
      );
      return { body };
    },
  },
}));
afterEach(() => vi.useRealTimers());

it("records native free-games handlers with fixed time and local service replies", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route(
    "/free-games",
    (await import("../src/routes/free-games.js")).default,
  );
  type Reads = Parameters<typeof recorder.record>[4];
  const cases: Awaited<ReturnType<typeof recorder.record>>[] = [];
  const get = async (
    name: string,
    path: string,
    reads: Reads = [],
    status = 200,
    hit: unknown = null,
    headers?: Record<string, string>,
  ) => {
    cases.push(
      await recorder.record(
        app,
        name,
        { method: "GET", path: "/free-games" + path, headers },
        status,
        reads,
        hit,
      ),
    );
  };
  const game = {
    id: "off",
    startDate: new Date("2026-11-16"),
    endDate: new Date("2026-11-19"),
  };
  const mobile = {
    offerId: "off",
    startDate: game.startDate,
    endDate: game.endDate,
    platform: "android",
  };
  const offer = {
    id: "off",
    namespace: "ns",
    title: "A",
    offerType: "BASE_GAME",
    items: [{ id: "i" }],
    countriesBlacklist: "DE",
    seller: { id: "s" },
    extra: "hidden",
  };
  const price = {
    offerId: "off",
    price: {
      currencyCode: "USD",
      originalPrice: 200,
      discountPrice: 120,
      discount: 80,
      basePayoutPrice: 80,
      basePayoutCurrencyCode: "USD",
      payoutCurrencyExchangeRate: 1,
    },
  };
  const index: Reads = [
    ["mobile-freebies", "many", []],
    ["freegames", "many", [game]],
    ["offers", "one", offer],
    ["pricev2", "one", price],
    ["freegames", "many", [game]],
    ["offersubitems", "many", [{ subItems: [{ id: "i2" }] }]],
    ["items", "many", [{ id: "i", __v: 2 }]],
  ];
  await get("free-games-current", "", index);
  await get("free-games-current-expanded", "?expand=true", index);
  await get("free-games-missing-mobile-offer", "", [
    ["mobile-freebies", "many", [mobile]],
    ["freegames", "many", []],
    ["offers", "one", null],
    ["pricev2", "one", null],
    ["mobile-freebies", "one", null],
  ]);
  await get("free-games-partial-source", "", [
    ["mobile-freebies", "many", new Error("offline")],
    ["freegames", "many", []],
  ]);
  await get("free-games-bad-locale", "?locale=x/y", [], 400);
  const history: Reads = [
    ["freegames", "many", [game, { id: "missing" }]],
    ["offers", "many", [offer]],
    ["pricev2", "many", [price]],
  ];
  await get("free-games-history", "/history?page=2&limit=3", history);
  await get("free-games-history-full", "/history?expand=1", history);
  await get("free-games-history-fallback", "/history?locale=fr", [
    ...history,
    ["egs_localizations", "many", []],
  ]);
  await get("free-games-history-cached", "/history", [], 200, [
    { cached: true },
  ]);
  await get("free-games-history-unavailable-prices", "/history", [
    ["freegames", "many", [game]],
    ["offers", "many", [offer]],
    ["pricev2", "many", new Error("offline")],
  ]);
  await get(
    "free-games-mobile-country-cookie",
    "/mobile",
    [
      ["mobile-freebies", "many", [mobile]],
      ["offers", "one", offer],
      ["pricev2", "one", price],
    ],
    200,
    null,
    { cookie: "EGDATA_COUNTRY=DE" },
  );
  await get("free-games-mobile-missing", "/mobile", [
    ["mobile-freebies", "many", [mobile]],
    ["offers", "one", null],
  ]);
  await get("free-games-stats", "/stats", [
    ["freegames", "many", [game, game]],
    ["offers", "many", [offer]],
    ["pricev2", "many", [price, price]],
  ]);
  await get(
    "free-games-stats-empty-prices",
    "/stats",
    [
      ["freegames", "many", []],
      ["offers", "many", []],
      ["pricev2", "many", []],
    ],
    500,
  );
  await get("free-games-stats-cached", "/stats", [], 200, { totalValue: 100 });
  await get("free-games-stats-country", "/stats?country=XX", [], 404);
  await get("free-games-sellers", "/sellers", [
    [
      "freegames",
      "aggregate",
      [{ sellerId: "s", sellerName: "Seller", totalSingleGames: 2 }],
    ],
  ]);
  hits = { hits: [{ _source: offer }], total: { value: 17, relation: "eq" } };
  await get(
    "free-games-search-filters",
    "/search?title=G%C3%A4me&sortBy=price&sortDir=asc&page=2&limit=3&tags=11,12&categories=games&offerType=BASE_GAME",
    [["pricev2", "many", [price]]],
  );
  hits = { hits: [], total: 0 };
  await get("free-games-search-empty", "/search", [["pricev2", "many", []]]);
  await get(
    "free-games-search-cached",
    "/search?sortBy=giveawayDate",
    [],
    200,
    { elements: [] },
  );
  const outage = () => new Error("fixture unavailable");
  const instant = new Date("2026-11-17T00:00:00Z");
  const boundary = {
    ...game,
    endDate: instant,
    startDate: new Date(instant.getTime() + 1),
  };
  const atBoth = { ...mobile, startDate: instant, endDate: instant };
  await get("current-end-inclusive-future-start", "", [
    ["mobile-freebies", "many", []],
    ["freegames", "many", [boundary]],
    ["offers", "one", null],
    ["pricev2", "one", null],
    ["freegames", "many", []],
  ]);
  await get("mobile-start-end-inclusive", "/mobile", [
    ["mobile-freebies", "many", [atBoth]],
    ["offers", "one", offer],
    ["pricev2", "one", null],
  ]);
  await get("current-desktop-source-offline", "", [
    ["mobile-freebies", "many", []],
    ["freegames", "many", outage()],
  ]);
  await get("current-all-enrichment-offline", "", [
    ...index.slice(0, 2),
    ["offers", "one", outage()],
    ["pricev2", "one", outage()],
    ["freegames", "many", outage()],
  ]);
  await get(
    "current-subitems-offline",
    "",
    [...index.slice(0, 5), ["offersubitems", "many", outage()]],
    500,
  );
  await get(
    "current-items-offline",
    "",
    [...index.slice(0, 6), ["items", "many", outage()]],
    500,
  );
  await get(
    "current-missing-items",
    "",
    [
      ...index.slice(0, 2),
      ["offers", "one", { id: "off" }],
      ...index.slice(3, 5),
    ],
    500,
  );
  await get(
    "current-bad-subitems",
    "",
    [...index.slice(0, 5), ["offersubitems", "many", [{}]]],
    500,
  );
  for (const path of ["/history", "/mobile", "/search"]) {
    await get("invalid-locale" + path, path + "?locale=x/y", [], 400);
    await get("invalid-country" + path, path + "?country=XX", [], 404);
  }
  for (const path of ["/history", "/stats", "/search"]) {
    failedCache = "get";
    await get("cache-get-outage" + path, path, [], 500);
    failedCache = undefined;
  }
  await get(
    "history-freegames-offline",
    "/history",
    [["freegames", "many", outage()]],
    500,
  );
  await get("history-offers-offline", "/history", [
    history[0],
    ["offers", "many", outage()],
    history[2],
  ]);
  await get(
    "history-localization-offline",
    "/history?locale=fr",
    [...history, ["egs_localizations", "many", outage()]],
    500,
  );
  failedCache = "set";
  await get("history-cache-set-offline", "/history", history, 500);
  failedCache = undefined;
  for (const [name, rows] of [
    [
      "mixed",
      [
        {
          price: {
            currencyCode: "USD",
            originalPrice: "12",
            discountPrice: true,
            discount: 3,
          },
        },
        {
          price: {
            originalPrice: 4,
            discountPrice: null,
            discount: "xy",
            basePayoutPrice: "tail",
          },
        },
      ],
    ],
    ["missing", [{ price: {} }, { price: { discount: "3" } }]],
    [
      "arrays",
      [
        {
          price: {
            originalPrice: [2, 3],
            discountPrice: { base: 2 },
            discount: false,
            basePayoutPrice: [],
          },
        },
      ],
    ],
  ] as const) {
    await get("stats-price-" + name, "/stats", [
      ["freegames", "many", [game, game]],
      ["offers", "many", [{ seller: {} }, { seller: { id: 0 } }]],
      ["pricev2", "many", rows],
    ]);
  }
  failedCache = "set";
  await get(
    "stats-cache-offline",
    "/stats",
    [history[0], history[1], history[2]],
    500,
  );
  failedCache = undefined;
  await get(
    "mobile-source-outage",
    "/mobile",
    [["mobile-freebies", "many", outage()]],
    500,
  );
  await get(
    "mobile-offer-outage",
    "/mobile",
    [
      ["mobile-freebies", "many", [mobile]],
      ["offers", "one", outage()],
    ],
    500,
  );
  await get(
    "mobile-price-outage",
    "/mobile",
    [
      ["mobile-freebies", "many", [mobile]],
      ["offers", "one", offer],
      ["pricev2", "one", outage()],
    ],
    500,
  );
  await get(
    "sellers-outage",
    "/sellers",
    [["freegames", "aggregate", outage()]],
    500,
  );
  hits = outage();
  await get("search-backend-offline", "/search", [], 500);
  hits = { total: 0 };
  await get("search-missing-hits", "/search", [], 500);
  hits = { hits: [{}], total: null };
  await get("search-missing-source", "/search", [], 500);
  hits = { hits: [], total: null };
  for (const sort of [
    "giveawayDate",
    "releaseDate",
    "price.price.discountPrice",
  ])
    await get("search-sort-" + sort, "/search?sortBy=" + sort, [
      ["pricev2", "many", []],
    ]);
  failedCache = "set";
  await get("search-cache-offline", "/search", [["pricev2", "many", []]], 500);
  failedCache = undefined;
  await get(
    "search-prices-offline",
    "/search",
    [["pricev2", "many", outage()]],
    500,
  );
  const [catalogOffer] = await loadSeaQaOffers();
  const pastGame = { id: catalogOffer.id, endDate: new Date("2023-08-03") };
  const priorGame = { ...pastGame, endDate: new Date("2022-05-26") };
  await get("history-repeat-offer-first-match-price-last-match", "/history", [
    ["freegames", "many", [pastGame, priorGame]],
    ["offers", "many", [catalogOffer, { ...catalogOffer, title: "duplicate" }]],
    [
      "pricev2",
      "many",
      [
        { offerId: catalogOffer.id, price: { originalPrice: 500 } },
        { offerId: catalogOffer.id, price: { originalPrice: 600 } },
      ],
    ],
  ]);
  const sparseGames = [{ id: 14 }, { id: "14" }, { id: null }, {}, { id: 55 }];
  const sparseOffers = [
    { id: 14, title: "number" },
    { id: "14", title: "string" },
    { id: null, title: "explicit null" },
  ];
  const sparsePrices = [
    { offerId: 14, price: { originalPrice: 20 } },
    { offerId: null, price: { originalPrice: 0 } },
  ];
  await get("history-typed-ids-and-absent-references", "/history", [
    ["freegames", "many", sparseGames],
    ["offers", "many", sparseOffers],
    ["pricev2", "many", sparsePrices],
  ]);
  await get(
    "history-unicode-whitespace-expand",
    "/history?expand=%EF%BB%BFFuLl",
    history,
  );
  await get("stats-distinct-property-keys", "/stats", [
    ["freegames", "many", [...sparseGames, { id: 55 }, { id: null }, {}]],
    [
      "offers",
      "many",
      [
        { seller: false },
        { seller: {} },
        { seller: { id: "undefined" } },
        { seller: { id: null } },
        { seller: { id: "null" } },
      ],
    ],
    ["pricev2", "many", [{ price: "legacy" }]],
  ]);
  await get(
    "stats-null-price-after-valid-price",
    "/stats",
    [
      ["freegames", "many", [game]],
      ["offers", "many", [offer]],
      ["pricev2", "many", [price, { price: null }]],
    ],
    500,
  );
  await get("current-mixed-item-id-types", "", [
    ...index.slice(0, 2),
    ["offers", "one", { ...offer, items: [{ id: 2 }, {}, { id: "2" }] }],
    ...index.slice(3, 5),
    ["offersubitems", "many", [{ subItems: [{ id: 2 }] }]],
    ["items", "many", [{ id: 2 }]],
  ]);
  for (const source of ["items", "subItems"]) {
    await get(
      "current-null-item-reference-" + source,
      "",
      source === "items"
        ? [
            ...index.slice(0, 2),
            ["offers", "one", { ...offer, items: [null] }],
            ...index.slice(3, 5),
          ]
        : [
            ...index.slice(0, 5),
            ["offersubitems", "many", [{ subItems: [null] }]],
          ],
      500,
    );
  }
  await get("mobile-numeric-id", "/mobile", [
    ["mobile-freebies", "many", [{ ...mobile, offerId: 14 }]],
    ["offers", "one", { ...offer, id: 14 }],
    ["pricev2", "one", null],
  ]);
  hits = {
    hits: [
      { _source: sparseOffers[0] },
      { _source: sparseOffers[1] },
      { _source: { title: "orphan" } },
    ],
    total: {},
  };
  await get("search-distinct-typed-ids-and-prices", "/search", [
    ["pricev2", "many", sparsePrices],
  ]);
  await get("current-country-unavailable", "?country=ZZ", [], 404);
  await get(
    "current-localization-outage",
    "?locale=fr",
    [...index, ["egs_localizations", "many", outage()]],
    500,
  );
  await get("mobile-sparse-platform-and-blacklist", "/mobile", [
    ["mobile-freebies", "many", [{ offerId: "off" }]],
    ["offers", "one", { ...offer, countriesBlacklist: null }],
    ["pricev2", "one", null],
  ]);
  await get(
    "mobile-localization-outage",
    "/mobile?locale=fr",
    [
      ["mobile-freebies", "many", [mobile]],
      ["offers", "one", offer],
      ["pricev2", "one", price],
      ["egs_localizations", "many", outage()],
    ],
    500,
  );
  await get(
    "stats-giveaway-source-outage",
    "/stats",
    [["freegames", "many", outage()]],
    500,
  );
  await get("stats-missing-field-after-string-price", "/stats", [
    ["freegames", "many", [game]],
    ["offers", "many", [offer]],
    ["pricev2", "many", [{ price: { originalPrice: "100" } }, { price: {} }]],
  ]);
  hits = { hits: [{ _source: offer }], total: 1 };
  await get(
    "search-localization-outage",
    "/search?locale=fr",
    [
      ["pricev2", "many", [price]],
      ["egs_localizations", "many", outage()],
    ],
    500,
  );
  await get("search-nonnumeric-page-window", "/search?page=old&limit=bad", [
    ["pricev2", "many", [price]],
  ]);
  assertOracle("legacy-free-games-http-node", cases);
});
