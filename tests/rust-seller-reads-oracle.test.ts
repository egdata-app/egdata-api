import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import type { V1Variables } from "../src/v1/request-context.js";

const mocks = vi.hoisted(() => ({
  offerDistinct: vi.fn(),
  offerFind: vi.fn(),
  offerCount: vi.fn(),
  priceFind: vi.fn(),
  localizations: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/models/index.js", () => ({
  AchievementSet: {},
  GamePosition: {},
  Item: {},
  Offer: {
    distinct: mocks.offerDistinct,
    find: mocks.offerFind,
    countDocuments: mocks.offerCount,
  },
  PriceEngine: { find: mocks.priceFind },
  Seller: {},
  TagModel: {},
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: mocks.cacheGet, set: mocks.cacheSet },
}));
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: () => ({
        find: () => ({ toArray: async () => mocks.localizations() }),
      }),
    },
  },
}));

import sellers from "../src/v1/routes/sellers.js";

const app = new Hono<{ Variables: V1Variables }>();
app.use("*", async (c, next) => {
  c.set("requestId", "req_node_oracle");
  await next();
});
app.onError((error, c) =>
  problemResponse(
    c,
    error instanceof ProblemError
      ? error
      : new ProblemError({
          status: 500,
          code: "INTERNAL_ERROR",
          detail:
            "The API could not complete the request. Retry later and include the request ID when contacting support.",
        }),
  ),
);
app.route("/v1", sellers);

const nodeHeaders = {
  "x-egdata-key-id": "key_oracle",
  "x-egdata-key-tier": "free",
  "x-request-id": "req_node_oracle",
};
const query = (rows: unknown[]) => ({ lean: async () => rows });

describe("registered v1 seller read Node oracle", () => {
  afterEach(() => vi.clearAllMocks());

  it("records seller directory and offer read responses", async () => {
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue("OK");
    mocks.offerCount.mockResolvedValue(0);
    mocks.localizations.mockReturnValue([]);
    const directoryRows = [
      { id: "seller-b", name: "Beta Studio", slug: "beta", externalId: 2 },
      { id: "seller-a", name: "Alpha Studio", slug: "alpha", externalId: 1 },
      {
        id: "seller-a",
        name: "Alpha Duplicate",
        slug: "duplicate",
        externalId: 3,
      },
      { id: "", name: "Invalid Seller" },
    ];
    mocks.offerDistinct.mockResolvedValue(directoryRows);
    const directoryRequest = { method: "GET", path: "/v1/sellers" };
    const directoryResponse = await captureResponse(
      await app.request(directoryRequest.path, { headers: nodeHeaders }),
    );
    const directoryCachePayload = mocks.cacheSet.mock.calls.at(
      -1,
    )?.[1] as string;
    const cases: {
      name: string;
      request: { method: string; path: string };
      input: Record<string, unknown>;
      response: Awaited<ReturnType<typeof captureResponse>>;
    }[] = [
      {
        name: "seller-directory-populated",
        request: directoryRequest,
        input: { sellers: directoryRows },
        response: directoryResponse,
      },
    ];

    mocks.cacheGet.mockReset().mockResolvedValue(directoryCachePayload);
    mocks.offerDistinct.mockImplementation(() => {
      throw new Error("cache hit queried seller directory");
    });
    cases.push({
      name: "seller-directory-cache-hit",
      request: directoryRequest,
      input: { cachePayload: directoryCachePayload },
      response: await captureResponse(
        await app.request(directoryRequest.path, { headers: nodeHeaders }),
      ),
    });

    mocks.cacheGet.mockReset().mockResolvedValue(null);
    const offers = [
      {
        id: "seller-game-a",
        namespace: "ns-a",
        title: "Seller Game A",
        offerType: "BASE_GAME",
        lastModifiedDate: "2026-10-02T00:00:00.000Z",
        keyImages: [],
        tags: [],
        items: [],
        customAttributes: [],
        seller: { id: "seller-a", name: "Alpha Studio" },
      },
      {
        id: "seller-game-b",
        namespace: "ns-b",
        title: "Seller Game B",
        offerType: "BASE_GAME",
        lastModifiedDate: "2026-10-01T00:00:00.000Z",
        keyImages: [],
        tags: [],
        items: [],
        customAttributes: [],
        seller: { id: "seller-a", name: "Alpha Studio" },
      },
    ];
    const prices = [
      {
        offerId: "seller-game-a",
        region: "US",
        currencyCode: "USD",
        price: { originalPrice: 1999, discountPrice: 999, discount: 50 },
      },
    ];
    const mongoFilters: Array<{ collection: string; filter: unknown }> = [];
    mocks.offerFind.mockImplementation((filter: unknown) => {
      mongoFilters.push({ collection: "offers", filter });
      return query(offers);
    });
    mocks.priceFind.mockImplementation((filter: unknown) => {
      mongoFilters.push({ collection: "pricev2", filter });
      return query(prices);
    });
    mocks.offerCount.mockResolvedValue(offers.length);
    const offersRequest = {
      method: "GET",
      path: "/v1/sellers/seller-a?country=US&locale=en-US&offerType=BASE_GAME&ignoredSandboxes=ns-old&limit=10",
    };
    cases.push({
      name: "seller-offers-populated-filtered",
      request: offersRequest,
      input: { offers, prices, mongoFilters },
      response: await captureResponse(
        await app.request(offersRequest.path, { headers: nodeHeaders }),
      ),
    });

    mocks.offerFind.mockReturnValue(query([]));
    mocks.offerCount.mockResolvedValue(0);
    const emptyRequest = { method: "GET", path: "/v1/sellers/seller-missing" };
    cases.push({
      name: "seller-offers-missing-seller-empty",
      request: emptyRequest,
      input: { offers: [], prices: [] },
      response: await captureResponse(
        await app.request(emptyRequest.path, { headers: nodeHeaders }),
      ),
    });

    mocks.cacheGet.mockReset().mockResolvedValue(null);
    mocks.offerDistinct.mockRejectedValue(
      new Error("private database failure"),
    );
    const dbErrorRequest = { method: "GET", path: "/v1/sellers" };
    cases.push({
      name: "seller-directory-database-error",
      request: dbErrorRequest,
      input: { databaseFailure: true },
      response: await captureResponse(
        await app.request(dbErrorRequest.path, { headers: nodeHeaders }),
      ),
    });

    const invalidRequest = { method: "GET", path: "/v1/sellers?country=US" };
    cases.push({
      name: "seller-directory-unknown-query",
      request: invalidRequest,
      input: {},
      response: await captureResponse(
        await app.request(invalidRequest.path, { headers: nodeHeaders }),
      ),
    });

    expect(cases).toHaveLength(6);
    assertOracle("seller-reads-http-node", cases);
  });
});
