import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOracle,
  captureResponse,
  fixtureValue,
} from "../rust/oracles/record.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import type { V1Variables } from "../src/v1/request-context.js";
import FreeGamesRoute from "../src/v1/routes/free-games.js";

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  freeGamesFind: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  itemFind: vi.fn(),
  priceFind: vi.fn(),
  priceFindOne: vi.fn(),
  search: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: mocks.collection } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: mocks.cacheGet, set: mocks.cacheSet },
}));
vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: { search: mocks.search },
}));
vi.mock("../src/models/index.js", () => ({
  FreeGames: { find: mocks.freeGamesFind },
  Offer: { find: mocks.offerFind, findOne: mocks.offerFindOne },
  Item: { find: mocks.itemFind },
  PriceEngine: { find: mocks.priceFind, findOne: mocks.priceFindOne },
}));

const now = new Date("2026-11-17T12:00:00.000Z");
const desktopGiveaway = {
  id: "offer-desktop",
  platform: "PC",
  endDate: new Date("2026-12-01T00:00:00Z"),
  startDate: new Date("2026-11-10T00:00:00Z"),
};
const mobileGiveaway = {
  offerId: "offer-mobile",
  platform: "Mobile",
  startDate: new Date("2026-11-01T00:00:00Z"),
  endDate: new Date("2026-12-05T00:00:00Z"),
};
const historyRows = [
  {
    id: "offer-desktop",
    platform: "PC",
    endDate: new Date("2026-10-02T00:00:00Z"),
    startDate: new Date("2026-09-25T00:00:00Z"),
  },
  {
    id: "offer-mobile",
    platform: "Android",
    endDate: new Date("2026-10-01T00:00:00Z"),
    startDate: new Date("2026-09-20T00:00:00Z"),
  },
];
const offer = (id: string, title: string) => ({
  _id: `mongo-${id}`,
  id,
  namespace: `ns-${id}`,
  title,
  description: `${title} description`,
  offerType: "BASE_GAME",
  lastModifiedDate: new Date("2026-10-10T00:00:00Z"),
  releaseDate: new Date("2026-09-01T00:00:00Z"),
  keyImages: [],
  tags: [{ id: "event" }],
  categories: ["Free to Play"],
  customAttributes: [],
  items: [],
  seller: { id: "seller-a", name: "Parity Games" },
  countriesBlacklist: [],
});
const offers = [
  offer("offer-desktop", "Parity Desktop"),
  offer("offer-mobile", "Parity Mobile"),
];
const prices = [
  {
    _id: "price-desktop",
    offerId: "offer-desktop",
    region: "US",
    updatedAt: now,
    price: {
      currencyCode: "USD",
      originalPrice: 1000,
      discountPrice: 0,
      discount: 100,
      basePayoutPrice: 0,
      basePayoutCurrencyCode: "USD",
      payoutCurrencyExchangeRate: 1,
    },
  },
  {
    _id: "price-mobile",
    offerId: "offer-mobile",
    region: "US",
    updatedAt: now,
    price: {
      currencyCode: "USD",
      originalPrice: 500,
      discountPrice: 0,
      discount: 100,
      basePayoutPrice: 0,
      basePayoutCurrencyCode: "USD",
      payoutCurrencyExchangeRate: 1,
    },
  },
];
const app = new Hono<{ Variables: V1Variables }>();
app.use("*", async (c, next) => {
  c.set("requestId", "req_node_oracle");
  await next();
});
app.route("/v1", FreeGamesRoute);
app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  return problemResponse(
    c,
    new ProblemError({
      status: 500,
      code: "INTERNAL_ERROR",
      detail:
        "The API could not complete the request. Retry later and include the request ID when contacting support.",
    }),
  );
});

type Scenario = {
  body?: unknown;
  failure?: "opensearch" | "pricev2" | "egs_localizations";
  cache?: { key: string; value: unknown };
  noSigner?: boolean;
};
type Filter = {
  id?: string;
  offerId?: string | { $in: string[] };
  region?: string;
  $or?: unknown;
  endDate?: { $gte?: Date };
};
type Options = Record<string, unknown>;
let scenario: Scenario;
let trace: unknown[];

function read(
  collection: string,
  method: string,
  query: unknown,
  options: Options,
  result: unknown,
) {
  const call = { collection, method, query: fixtureValue(query), options };
  if (scenario.failure === collection) {
    trace.push({ call, error: true });
    throw new Error("fixture read failed");
  }
  trace.push({ call, result: fixtureValue(result) });
  return result;
}

function configure() {
  mocks.cacheGet.mockImplementation(async (key: string) => {
    const hit = scenario.cache?.key === key ? scenario.cache.value : undefined;
    trace.push({ call: { method: "get", key }, result: hit ?? null });
    return hit === undefined ? null : JSON.stringify(hit);
  });
  mocks.cacheSet.mockImplementation(
    async (key: string, value: string, _mode: string, ttl: number) => {
      trace.push({
        call: { method: "set", key, payload: JSON.parse(value), ttl },
        result: null,
      });
      return "OK";
    },
  );
  function model(
    collection: string,
    method: "one" | "many",
    select: (query: Filter) => unknown,
  ) {
    return (query: Filter, projection?: Options, options: Options = {}) => ({
      lean: async () =>
        read(
          collection,
          method,
          query,
          projection ? { ...options, projection } : options,
          select(query),
        ),
    });
  }
  mocks.freeGamesFind.mockImplementation(
    model("freegames", "many", (filter) =>
      filter.endDate?.$gte
        ? [desktopGiveaway]
        : filter.id
          ? historyRows.filter((row) => row.id === filter.id)
          : filter.$or
            ? historyRows.slice(1)
            : historyRows,
    ),
  );
  mocks.offerFind.mockImplementation(model("offers", "many", () => offers));
  mocks.offerFindOne.mockImplementation(
    model(
      "offers",
      "one",
      (filter) => offers.find((row) => row.id === filter.id) ?? null,
    ),
  );
  mocks.priceFind.mockImplementation(
    model("pricev2", "many", ({ offerId, region }) =>
      prices.filter(
        (row) =>
          row.region === region &&
          typeof offerId === "object" &&
          offerId.$in.includes(row.offerId),
      ),
    ),
  );
  mocks.priceFindOne.mockImplementation(
    model(
      "pricev2",
      "one",
      (filter) => prices.find((row) => row.offerId === filter.offerId) ?? null,
    ),
  );
  mocks.itemFind.mockImplementation(model("items", "many", () => []));
  mocks.collection.mockImplementation((collection: string) => ({
    find: (query: unknown, options: Options = {}) => ({
      toArray: async () =>
        read(
          collection,
          "many",
          query,
          options,
          collection === "mobile-freebies" ? [mobileGiveaway] : [],
        ),
    }),
    findOne: async (query: unknown, options: Options = {}) =>
      read(collection, "one", query, options, mobileGiveaway),
    aggregate: (pipeline: unknown, options: Options = {}) => ({
      toArray: async () =>
        read(collection, "aggregate", pipeline, options, [
          {
            sellerId: "seller-a",
            sellerName: "Parity Games",
            totalSingleGames: 2,
          },
        ]),
    }),
  }));
  mocks.search.mockImplementation(
    async ({
      index,
      body,
    }: {
      index: string;
      body: { search_after?: unknown[] };
    }) => {
      const call = { service: "opensearch", method: "search", index, body };
      if (scenario.failure === "opensearch") {
        trace.push({ call, error: true });
        throw new Error("search unavailable");
      }
      const hits = body.search_after ? offers.slice(1) : offers;
      const result = JSON.parse(
        JSON.stringify(
          scenario.body ?? {
            hits: {
              total: { value: 2, relation: "eq" },
              hits: hits.map((_source) => ({
                _source,
                sort: ["2026-10-10T00:00:00.000Z", _source.id],
              })),
            },
            timed_out: false,
            took: 7,
          },
        ),
      );
      trace.push({ call, result });
      return { body: result };
    },
  );
}

describe("registered free-games Node HTTP oracle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  it("captures complete service reads and responses for registered routes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    configure();
    const cases: unknown[] = [];
    async function add(
      name: string,
      path: string,
      status: number,
      options: Scenario = {},
    ) {
      scenario = options;
      trace = [];
      vi.stubEnv(
        "V1_CURSOR_SECRET",
        options.noSigner ? "" : "test-cursor-secret-that-is-at-least-32-chars",
      );
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
      const response = await captureResponse(await app.request("/v1" + path));
      expect(response.status, name).toBe(status);
      cases.push({
        name,
        request: { method: "GET", path: "/v1" + path },
        ...(options.noSigner ? { noSigner: true } : {}),
        trace,
        response,
      });
      return response;
    }
    await add("free-games-current-populated", "/free-games?country=US", 200);
    const first = await add(
      "free-games-history-paged",
      "/free-games/history?limit=1&country=US",
      200,
    );
    await add(
      "free-games-history-second-page",
      "/free-games/history?limit=1&country=US&cursor=" +
        encodeURIComponent(first.body.meta.pagination.nextCursor),
      200,
    );
    await add(
      "free-games-history-invalid-limit",
      "/free-games/history?limit=0",
      400,
    );
    const filtered =
      "/free-games/search?title=Parity&offerType=BASE_GAME&tags=event&categories=Free%20to%20Play&sortBy=price&sortDir=asc&limit=1&country=US";
    const filteredFirst = await add(
      "free-games-search-filtered-paged",
      filtered,
      200,
    );
    await add(
      "free-games-search-second-page",
      filtered +
        "&cursor=" +
        encodeURIComponent(filteredFirst.body.meta.pagination.nextCursor),
      200,
    );
    const unsorted =
      "/free-games/search?sortBy=upcoming&limit=1&tags=b,a&tags=b,c&categories=beta&categories=alpha";
    const fallback = await add(
      "free-games-search-source-cursor",
      unsorted,
      200,
      {
        body: {
          hits: {
            total: { value: 2, relation: "eq" },
            hits: offers.map((offer) => ({
              _source: { ...offer, upcoming: false },
            })),
          },
          timed_out: false,
          took: 7,
        },
      },
    );
    const cursor = fallback.body.meta.pagination.nextCursor as string;
    expect(
      JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString())
        .last,
    ).toEqual([0, offers[0].id]);
    await add(
      "free-games-search-numeric-cursor-continuation",
      unsorted + "&cursor=" + encodeURIComponent(cursor),
      200,
      { body: { hits: { hits: [] } } },
    );
    await add(
      "free-games-search-grouped-invalid-query",
      "/free-games/search?sortDir=bad&sortBy=bad&offerType=bad&unexpected=1&title=" +
        "a".repeat(201),
      400,
    );
    await add(
      "free-games-search-unavailable",
      "/free-games/search?title=Parity",
      503,
      { failure: "opensearch" },
    );
    await add(
      "free-games-stats-populated",
      "/free-games/stats?country=US",
      200,
    );
    await add(
      "free-games-mobile-populated",
      "/free-games/mobile?country=US",
      200,
    );
    await add("free-games-sellers-populated", "/free-games/sellers", 200);
    await add("free-games-sellers-cache-hit", "/free-games/sellers", 200, {
      cache: {
        key: "v1:free-games.sellers:",
        value: [
          {
            sellerId: "cached-seller",
            sellerName: "Cached Seller",
            totalSingleGames: 7,
          },
        ],
      },
    });
    for (const [name, body, status] of [
      ["missing-hits", {}, 500],
      ["null-hits", { hits: { hits: null } }, 500],
      ["bad-hits", { hits: { hits: {} } }, 500],
      ["null-hit-entry", { hits: { hits: [null] } }, 500],
      [
        "numeric-total",
        { hits: { hits: [], total: -5 }, took: "2.5", timed_out: "false" },
        200,
      ],
      [
        "missing-total",
        { hits: { hits: [] }, took: "junk", timed_out: 1 },
        200,
      ],
      [
        "null-source",
        {
          hits: {
            hits: [{ _source: null }],
            total: { value: null, relation: null },
          },
          took: null,
        },
        200,
      ],
      [
        "array-sort",
        {
          hits: {
            hits: [
              { _source: offers[0], sort: [null, false, { k: 1 }, [1, 2], 4] },
              { _source: offers[1] },
            ],
          },
        },
        200,
      ],
      [
        "nested-fallback",
        {
          hits: {
            hits: [
              {
                _source: {
                  ...offers[0],
                  freeEntries: { endDate: "2027-01-01" },
                },
              },
              { _source: offers[1] },
            ],
          },
        },
        200,
      ],
      [
        "missing-fallback-id",
        { hits: { hits: [{ _source: {} }, { _source: offers[1] }] } },
        200,
      ],
      [
        "extended-json-fallback-id",
        {
          hits: {
            hits: [
              {
                _source: {
                  id: { $oid: "5f0000000000000000000001" },
                  _id: ["series", 2],
                  creationDate: { $date: 1700000000000 },
                  releaseDate: { $date: { $date: "2024-05-12" } },
                  lastModifiedDate: { $date: { $numberLong: "1700000000000" } },
                  seller: { id: { $oid: "publisher" }, name: "Publisher" },
                  keyImages: [
                    {
                      extra: { $oid: "image" },
                      captured: { $date: "2020-01-01" },
                    },
                    {
                      updatedAt: { $date: 12345 },
                      __v: 3,
                      ["__proto__"]: { title: "unlisted" },
                    },
                  ],
                  customAttributes: false,
                },
              },
              { _source: offers[1] },
            ],
          },
        },
        200,
      ],
    ] as const) {
      await add(
        "free-games-search-" + name,
        "/free-games/search?sortBy=giveawayDate&limit=1",
        status,
        { body },
      );
    }
    await add(
      "free-games search invalid stored attributes",
      "/free-games/search",
      500,
      {
        body: {
          hits: {
            hits: [{ _source: { ...offers[0], customAttributes: [null] } }],
          },
        },
      },
    );
    await add(
      "free-games search price store unavailable",
      "/free-games/search?locale=fr",
      500,
      { failure: "pricev2" },
    );
    await add(
      "free-games search localization unavailable",
      "/free-games/search?locale=fr",
      500,
      { failure: "egs_localizations" },
    );
    await add(
      "free-games search cursor signer unavailable",
      "/free-games/search?limit=1",
      503,
      { noSigner: true },
    );
    await add(
      "free-games history cursor signer unavailable",
      "/free-games/history?limit=1",
      503,
      { noSigner: true },
    );
    await add(
      "free-games search terminal page without signer",
      "/free-games/search?limit=2",
      200,
      { noSigner: true },
    );
    assertOracle("free-games-http-node", cases);
  });
});
