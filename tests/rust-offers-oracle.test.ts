import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import { captureResponse, assertOracle } from "../rust/oracles/record.js";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  tagFindOne: vi.fn(),
  gamePositionFind: vi.fn(),
  achievementFind: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  offerAggregate: vi.fn(),
  priceFind: vi.fn(),
  priceFindOne: vi.fn(),
  localizations: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/models/index.js", () => ({
  AchievementSet: { find: mocks.achievementFind },
  GamePosition: { find: mocks.gamePositionFind },
  Offer: {
    find: mocks.offerFind,
    findOne: mocks.offerFindOne,
    aggregate: mocks.offerAggregate,
  },
  PriceEngine: { find: mocks.priceFind, findOne: mocks.priceFindOne },
  TagModel: { find: mocks.find, findOne: mocks.tagFindOne },
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

import offers from "../src/v1/routes/offers.js";

const app = new Hono();
app.use("*", v1Context());
app.use("*", responseEtag);
app.use("*", v1CachePolicy());
app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});
app.route("/v1", offers);
const nodeHeaders = {
  "x-egdata-key-id": "key_oracle",
  "x-egdata-key-tier": "free",
  "x-request-id": "req_node_oracle",
};

describe("registered v1 offer Node oracle", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    mocks.find.mockReset().mockReturnValue({
      lean: async () => [
        {
          id: "spring-sale",
          name: "Spring Sale",
          groupName: "event",
          status: "ACTIVE",
        },
      ],
    });
    mocks.tagFindOne.mockReset().mockReturnValue({ lean: async () => null });
    mocks.gamePositionFind
      .mockReset()
      .mockReturnValue({ lean: async () => [] });
    mocks.achievementFind.mockReset().mockReturnValue({ lean: async () => [] });
    process.env.V1_CURSOR_SECRET =
      "test-cursor-secret-that-is-at-least-32-chars";
    mocks.cacheGet.mockReset().mockResolvedValue(null);
    mocks.cacheSet.mockReset().mockResolvedValue("OK");
    mocks.offerFind.mockReset().mockReturnValue({ lean: async () => [] });
    mocks.offerFindOne.mockReset().mockReturnValue({ lean: async () => null });
    mocks.offerAggregate.mockReset().mockReturnValue({ exec: async () => [] });
    mocks.localizations.mockReset().mockReturnValue([]);
    mocks.priceFind.mockReset().mockReturnValue({ lean: async () => [] });
    mocks.priceFindOne.mockReset().mockReturnValue({ lean: async () => null });
  });

  it("records canonical registered event and query validation responses", async () => {
    const cases = [];
    const eventRequest = { method: "GET", path: "/v1/offers/events" };
    const eventResponse = await app.request(eventRequest.path, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "events",
      request: eventRequest,
      input: {
        events: [
          {
            id: "spring-sale",
            name: "Spring Sale",
            groupName: "event",
            status: "ACTIVE",
          },
        ],
      },
      response: await captureResponse(eventResponse),
    });
    const invalidRequest = { method: "GET", path: "/v1/offers?unexpected=1" };
    const listRequest = { method: "GET", path: "/v1/offers?country=US" };
    const rawOffer = {
      id: "oracle-game",
      namespace: "ns-oracle",
      title: "Oracle Game",
      offerType: "BASE_GAME",
      lastModifiedDate: "2026-01-02T00:00:00.000Z",
      keyImages: [],
      tags: [],
      items: [],
      customAttributes: [],
    };
    const rawPrice = {
      offerId: "oracle-game",
      region: "US",
      currencyCode: "USD",
      price: { originalPrice: 1999, discountPrice: 999, discount: 50 },
    };
    mocks.offerFind.mockReturnValue({ lean: async () => [rawOffer] });
    mocks.priceFind.mockReturnValue({ lean: async () => [rawPrice] });
    const listResponse = await app.request(listRequest.path, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "priced-us-list",
      request: listRequest,
      input: { offers: [rawOffer], prices: [rawPrice], cache: "miss" },
      response: await captureResponse(listResponse),
    });
    const listCachePayload = mocks.cacheSet.mock.calls.at(-1)?.[1] as string;
    mocks.cacheGet.mockReset().mockResolvedValue(listCachePayload);
    mocks.offerFind.mockImplementation(() => {
      throw new Error("cache hit queried offers");
    });
    const cachedListResponse = await app.request(listRequest.path, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "priced-us-list-cache-hit",
      request: listRequest,
      input: { cachePayload: listCachePayload },
      response: await captureResponse(cachedListResponse),
    });
    mocks.cacheGet.mockReset().mockResolvedValue("not-json");
    mocks.offerFind.mockReturnValue({ lean: async () => [rawOffer] });
    mocks.priceFind.mockReturnValue({ lean: async () => [rawPrice] });
    const malformedCacheResponse = await app.request(listRequest.path, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "priced-us-list-malformed-cache",
      request: listRequest,
      input: {
        cachePayload: "not-json",
        offers: [rawOffer],
        prices: [rawPrice],
      },
      response: await captureResponse(malformedCacheResponse),
    });
    mocks.cacheGet.mockReset().mockResolvedValue(null);
    const detailOffer = {
      ...rawOffer,
      countriesWhitelist: ["US"],
      description: "Canonical description",
    };
    const detailPrice = { ...rawPrice, updatedAt: "2026-01-03T00:00:00.000Z" };
    mocks.offerFindOne.mockReturnValue({ lean: async () => detailOffer });
    mocks.priceFindOne.mockReturnValue({ lean: async () => detailPrice });
    mocks.localizations.mockReturnValue([
      {
        entityType: "offer",
        entityId: "ns-oracle:oracle-game",
        locale: "es-ES",
        source: "epic",
        fetchedAt: "2026-01-04T00:00:00.000Z",
        data: { title: "Juego Oráculo", description: "Descripción localizada" },
      },
    ]);
    const detailRequest = {
      method: "GET",
      path: "/v1/offers/oracle-game?country=US&locale=es-ES",
    };
    const detailResponse = await app.request(detailRequest.path, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "localized-us-detail-with-price",
      request: detailRequest,
      input: {
        offer: detailOffer,
        prices: [detailPrice],
        localizations: [
          {
            entityType: "offer",
            entityId: "ns-oracle:oracle-game",
            locale: "es-ES",
            source: "epic",
            fetchedAt: "2026-01-04T00:00:00.000Z",
            data: {
              title: "Juego Oráculo",
              description: "Descripción localizada",
            },
          },
        ],
      },
      response: await captureResponse(detailResponse),
    });
    mocks.priceFindOne.mockClear();
    const excludedDetailRequest = {
      method: "GET",
      path: "/v1/offers/oracle-game?country=GB&locale=es-ES",
    };
    const excludedDetailResponse = await app.request(
      excludedDetailRequest.path,
      { headers: nodeHeaders },
    );
    expect(mocks.priceFindOne).not.toHaveBeenCalled();
    cases.push({
      name: "localized-gb-detail-price-ineligible",
      request: excludedDetailRequest,
      input: {
        offer: detailOffer,
        prices: [],
        localizations: [
          {
            entityType: "offer",
            entityId: "ns-oracle:oracle-game",
            locale: "es-ES",
            source: "epic",
            fetchedAt: "2026-01-04T00:00:00.000Z",
            data: {
              title: "Juego Oráculo",
              description: "Descripción localizada",
            },
          },
        ],
      },
      response: await captureResponse(excludedDetailResponse),
    });
    const boundRequest = { method: "GET", path: "/v1/offers?limit=101" };
    const boundResponse = await app.request(boundRequest.path, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "list-limit-bound",
      request: boundRequest,
      input: {},
      response: await captureResponse(boundResponse),
    });
    cases.push({
      name: "unknown-list-query",
      request: invalidRequest,
      input: {},
      response: await captureResponse(
        await app.request(invalidRequest.path, { headers: nodeHeaders }),
      ),
    });

    const upcomingOffer = {
      ...rawOffer,
      id: "oracle-upcoming",
      offerType: "BASE_GAME",
      releaseDate: "2098-01-02T00:00:00.000Z",
    };
    mocks.offerFind.mockReturnValue({ lean: async () => [upcomingOffer] });
    mocks.priceFind.mockReturnValue({ lean: async () => [] });
    const upcomingRequest = {
      method: "GET",
      path: "/v1/offers/upcoming?limit=7",
    };
    cases.push({
      name: "upcoming-populated",
      request: upcomingRequest,
      input: { offers: [upcomingOffer], prices: [] },
      response: await captureResponse(
        await app.request(upcomingRequest.path, { headers: nodeHeaders }),
      ),
    });

    const rankedOffers = [
      { ...rawOffer, id: "ranked-one" },
      { ...rawOffer, id: "ranked-two" },
    ];
    const positions = [
      { collectionId: "top-sellers", offerId: "ranked-two", position: 1 },
      { collectionId: "top-sellers", offerId: "ranked-one", position: 2 },
    ];
    mocks.gamePositionFind.mockReturnValue({ lean: async () => positions });
    mocks.offerFind.mockReturnValue({ lean: async () => rankedOffers });
    const topRequest = {
      method: "GET",
      path: "/v1/offers/top-sellers?limit=5",
    };
    cases.push({
      name: "top-sellers-populated",
      request: topRequest,
      input: { positions, offers: rankedOffers },
      response: await captureResponse(
        await app.request(topRequest.path, { headers: nodeHeaders }),
      ),
    });

    const slugOffer = {
      id: "oracle-slug",
      namespace: "ns-oracle",
      customAttributes: [{ key: "slug", value: "oracle-game/home" }],
    };
    mocks.offerFind.mockReturnValue({ lean: async () => [slugOffer] });
    const slugsRequest = {
      method: "POST",
      path: "/v1/offers/slugs",
      body: { slugs: ["oracle-game", "missing"] },
    };
    cases.push({
      name: "slugs-populated",
      request: slugsRequest,
      input: { offers: [slugOffer] },
      response: await captureResponse(
        await app.request(slugsRequest.path, {
          method: "POST",
          headers: { ...nodeHeaders, "content-type": "application/json" },
          body: JSON.stringify(slugsRequest.body),
        }),
      ),
    });

    mocks.offerFind.mockReturnValue({
      lean: async () => [{ id: "oracle-game" }],
    });
    const existsRequest = {
      method: "POST",
      path: "/v1/offers/exists",
      body: { offers: [" oracle-game ", "missing", "oracle-game"] },
    };
    cases.push({
      name: "exists-populated",
      request: existsRequest,
      input: { offers: [{ id: "oracle-game" }] },
      response: await captureResponse(
        await app.request(existsRequest.path, {
          method: "POST",
          headers: { ...nodeHeaders, "content-type": "application/json" },
          body: JSON.stringify(existsRequest.body),
        }),
      ),
    });

    const releasedOffer = {
      ...rawOffer,
      id: "oracle-released",
      offerType: "BASE_GAME",
      releaseDate: "2020-01-02T00:00:00.000Z",
      effectiveDate: "2020-01-01T00:00:00.000Z",
    };
    mocks.offerFind.mockReturnValue({ lean: async () => [releasedOffer] });
    mocks.priceFind.mockReturnValue({ lean: async () => [] });
    const releasedRequest = {
      method: "GET",
      path: "/v1/offers/latest-released?limit=6",
    };
    cases.push({
      name: "latest-released-populated",
      request: releasedRequest,
      input: { offers: [releasedOffer], prices: [] },
      response: await captureResponse(
        await app.request(releasedRequest.path, { headers: nodeHeaders }),
      ),
    });

    const event = {
      id: "spring-sale",
      name: "Spring Sale",
      groupName: "event",
      status: "ACTIVE",
    };
    const eventOffer = {
      ...rawOffer,
      id: "event-game",
      sortDiscount: 35,
      price: {
        offerId: "event-game",
        price: { discount: 35, originalPrice: 2000, discountPrice: 1300 },
        currencyCode: "USD",
      },
    };
    mocks.tagFindOne.mockReturnValue({ lean: async () => event });
    mocks.offerAggregate.mockReturnValue({ exec: async () => [eventOffer] });
    const eventDetailRequest = {
      method: "GET",
      path: "/v1/offers/events/spring-sale?limit=4",
    };
    cases.push({
      name: "event-detail-populated",
      request: eventDetailRequest,
      input: { event, aggregateOffers: [eventOffer] },
      response: await captureResponse(
        await app.request(eventDetailRequest.path, { headers: nodeHeaders }),
      ),
    });

    const featuredOffers = [
      { ...rawOffer, id: "featured-game", offerType: "BASE_GAME" },
    ];
    const featuredPositions = [{ offerId: "featured-game", position: 3 }];
    const featuredPrices = [
      {
        offerId: "featured-game",
        region: "US",
        currencyCode: "USD",
        price: { originalPrice: 1500, discountPrice: 1000, discount: 33 },
      },
    ];
    mocks.gamePositionFind.mockReturnValue({
      lean: async () => featuredPositions,
    });
    mocks.offerFind.mockReturnValue({ lean: async () => featuredOffers });
    mocks.priceFind.mockReturnValue({ lean: async () => featuredPrices });
    const featuredRequest = {
      method: "GET",
      path: "/v1/offers/featured-discounts?country=US",
    };
    cases.push({
      name: "featured-discounts-populated",
      request: featuredRequest,
      input: {
        positions: featuredPositions,
        offers: featuredOffers,
        prices: featuredPrices,
      },
      response: await captureResponse(
        await app.request(featuredRequest.path, { headers: nodeHeaders }),
      ),
    });

    const achievementOffer = {
      ...rawOffer,
      id: "achievement-game",
      namespace: "ns-achievement",
      offerType: "BASE_GAME",
      tags: [{ id: "19847" }],
      effectiveDate: "2020-01-01T00:00:00.000Z",
    };
    const achievements = [
      { sandboxId: "ns-achievement", isBase: true, count: 8 },
    ];
    mocks.offerFind.mockReturnValue({ lean: async () => [achievementOffer] });
    mocks.achievementFind.mockReturnValue({ lean: async () => achievements });
    mocks.priceFind.mockReturnValue({ lean: async () => [] });
    const achievementRequest = {
      method: "GET",
      path: "/v1/offers/latest-achievements",
    };
    cases.push({
      name: "latest-achievements-populated",
      request: achievementRequest,
      input: { offers: [achievementOffer], achievements, prices: [] },
      response: await captureResponse(
        await app.request(achievementRequest.path, { headers: nodeHeaders }),
      ),
    });

    const genre = {
      id: "genre-action",
      name: "Action",
      groupName: "genre",
      status: "ACTIVE",
    };
    const genreOffer = {
      ...rawOffer,
      id: "genre-game",
      namespace: "ns-genre",
      title: "Genre Game",
      offerType: "BASE_GAME",
      tags: [{ id: genre.id }],
      releaseDate: "2025-01-01T00:00:00.000Z",
    };
    mocks.find.mockReturnValue({ lean: async () => [genre] });
    mocks.offerFind.mockReturnValue({ lean: async () => [genreOffer] });
    const genresRequest = {
      method: "GET",
      path: "/v1/offers/genres?locale=en-US",
    };
    cases.push({
      name: "genres-populated",
      request: genresRequest,
      input: { genres: [genre], offers: [genreOffer] },
      response: await captureResponse(
        await app.request(genresRequest.path, { headers: nodeHeaders }),
      ),
    });

    const wishPositions = [{ offerId: "wish-game", position: 2 }];
    const wishOffer = {
      ...rawOffer,
      id: "wish-game",
      namespace: "ns-wish",
      title: "Wish Game",
      offerType: "BASE_GAME",
    };
    mocks.gamePositionFind.mockReturnValue({ lean: async () => wishPositions });
    mocks.offerFind.mockReturnValue({ lean: async () => [wishOffer] });
    const wishRequest = {
      method: "GET",
      path: "/v1/offers/top-wishlisted?limit=10",
    };
    cases.push({
      name: "top-wishlisted-populated",
      request: wishRequest,
      input: { positions: wishPositions, offers: [wishOffer] },
      response: await captureResponse(
        await app.request(wishRequest.path, { headers: nodeHeaders }),
      ),
    });

    const cursorOffers = [
      {
        ...rawOffer,
        id: "cursor-a",
        releaseDate: "2098-01-01T00:00:00.000Z",
        offerType: "BASE_GAME",
      },
      {
        ...rawOffer,
        id: "cursor-b",
        releaseDate: "2098-01-02T00:00:00.000Z",
        offerType: "BASE_GAME",
      },
    ];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T18:00:00.000Z"));
    mocks.offerFind.mockReturnValue({ lean: async () => cursorOffers });
    mocks.priceFind.mockReturnValue({ lean: async () => [] });
    const cursorFirstRequest = {
      method: "GET",
      path: "/v1/offers/upcoming?limit=1",
    };
    const cursorFirstResponse = await captureResponse(
      await app.request(cursorFirstRequest.path, { headers: nodeHeaders }),
    );
    cases.push({
      name: "upcoming-cursor-first-page",
      request: cursorFirstRequest,
      input: { offers: cursorOffers, prices: [] },
      response: cursorFirstResponse,
    });
    const nextCursor = cursorFirstResponse.body.meta.pagination
      .nextCursor as string;
    mocks.offerFind.mockReturnValue({ lean: async () => [cursorOffers[1]] });
    const cursorNextRequest = {
      method: "GET",
      path: `/v1/offers/upcoming?limit=1&cursor=${encodeURIComponent(nextCursor)}`,
    };
    cases.push({
      name: "upcoming-cursor-continuation",
      request: cursorNextRequest,
      input: { offers: [cursorOffers[1]], prices: [], cursor: nextCursor },
      response: await captureResponse(
        await app.request(cursorNextRequest.path, { headers: nodeHeaders }),
      ),
    });

    const mismatchRequest = {
      method: "GET",
      path: `/v1/offers/upcoming?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
    };
    cases.push({
      name: "upcoming-cursor-limit-mismatch",
      request: mismatchRequest,
      input: { cursor: nextCursor },
      response: await captureResponse(
        await app.request(mismatchRequest.path, { headers: nodeHeaders }),
      ),
    });
    vi.useRealTimers();
    expect(cases).toHaveLength(21);
    await assertOracle("offers-http-node", cases);
  });
});
