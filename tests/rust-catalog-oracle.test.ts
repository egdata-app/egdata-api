import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import type { V1Variables } from "../src/v1/request-context.js";
import ItemsRoute from "../src/v1/routes/items.js";
import SellersRoute from "../src/v1/routes/sellers.js";

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  itemFindOne: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  offerCount: vi.fn(),
  offerAggregate: vi.fn(),
  itemCount: vi.fn(),
  gamePositionFind: vi.fn(),
  priceFind: vi.fn(),
  priceFindOne: vi.fn(),
  sellerFindOne: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: mocks.collection } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: mocks.cacheGet, set: mocks.cacheSet },
}));
vi.mock("../src/models/index.js", () => ({
  Item: { findOne: mocks.itemFindOne, countDocuments: mocks.itemCount },
  Offer: {
    find: mocks.offerFind,
    findOne: mocks.offerFindOne,
    countDocuments: mocks.offerCount,
    aggregate: mocks.offerAggregate,
  },
  PriceEngine: {
    find: mocks.priceFind,
    findOne: mocks.priceFindOne,
  },
  GamePosition: { find: mocks.gamePositionFind },
  Seller: { findOne: mocks.sellerFindOne },
}));

const query = (result: unknown[]) => ({ lean: vi.fn(async () => result) });
const nodeApp = (route: Hono<{ Variables: V1Variables }>, prefix: string) => {
  const app = new Hono<{ Variables: V1Variables }>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req_node_oracle");
    await next();
  });
  app.route(prefix, route);
  app.onError((error, c) => {
    if (error instanceof ProblemError) return problemResponse(c, error);
    throw error;
  });
  return app;
};

import { ProblemError, problemResponse } from "../src/v1/errors.js";

const itemApp = nodeApp(ItemsRoute, "/v1");
const sellerApp = nodeApp(SellersRoute, "/v1");
const offer = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: `mongo-${id}`,
  id,
  namespace: "ns",
  title: `Title ${id}`,
  description: "Desc",
  offerType: "BASE_GAME",
  lastModifiedDate: new Date("2026-10-01T00:00:00Z"),
  keyImages: [],
  tags: [],
  items: [],
  seller: { id: "seller-a", name: "Seller A" },
  ...extra,
});
const capture = async (app: ReturnType<typeof nodeApp>, path: string) =>
  captureResponse(await app.request(path));

describe("registered catalog Node HTTP oracle", () => {
  afterEach(() => vi.clearAllMocks());
  it("records canonical item offer, seller cover, and stats HTTP responses", async () => {
    process.env.V1_CURSOR_SECRET =
      "test-cursor-secret-that-is-at-least-32-chars";
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue("OK");
    mocks.collection.mockImplementation((name: string) => ({
      find: (filter: Record<string, any>) => ({
        toArray: async () => {
          if (name === "egs_localizations") {
            return filter.locale === "fr-FR" &&
              filter.entityId?.$in?.includes("ns:localized")
              ? [
                  {
                    _id: "loc-fr",
                    entityType: "offer",
                    entityId: "ns:localized",
                    namespace: "ns",
                    locale: "fr-FR",
                    source: "oracle",
                    fetchedAt: new Date("2026-11-01T00:00:00Z"),
                    data: {
                      title: "Titre localisé",
                      description: "Description localisée",
                    },
                  },
                ]
              : [];
          }
          if (name !== "offersubitems") return [];
          const ids = Array.isArray(filter["subItems.id"]?.$in)
            ? filter["subItems.id"].$in
            : [filter["subItems.id"]];
          const id = ids.find((value: unknown) =>
            [
              "item-linked",
              "item-blocked",
              "item-localized",
              "item-localized-fallback",
              "item-cache-malformed",
            ].includes(String(value)),
          );
          if (!id) return [];
          return [
            {
              _id:
                id === "item-blocked"
                  ? "blocked"
                  : id === "item-localized"
                    ? "localized"
                    : id === "item-localized-fallback"
                      ? "localized-fallback"
                      : id === "item-cache-malformed"
                        ? "cache-malformed"
                        : "linked",
              subItems: [{ id }],
            },
          ];
        },
      }),
      aggregate: () => ({
        toArray: async () =>
          name === "freegames"
            ? [{ count: 2 }]
            : name === "mobile-freebies"
              ? [{ count: 3 }]
              : [],
      }),
    }));
    mocks.itemFindOne.mockImplementation((filter: Record<string, any>) => ({
      lean: async () =>
        filter.id?.$eq === "item-missing" ? null : { id: filter.id?.$eq },
    }));
    mocks.offerFind.mockImplementation((filter: Record<string, any>) =>
      query(
        filter["items.id"]?.$in?.includes("item-direct")
          ? [offer("direct", { items: [{ id: "item-direct" }] })]
          : filter["items.id"]?.$in?.includes("item-blocked-bulk")
            ? [
                offer("blocked-bulk", {
                  items: [{ id: "item-blocked-bulk" }],
                  countriesBlacklist: ["FR"],
                }),
              ]
            : filter.id?.$in?.includes("linked")
              ? [offer("linked")]
              : filter.id?.$in?.includes("blocked")
                ? [offer("blocked", { countriesBlacklist: ["DE"] })]
                : filter.id?.$in?.includes("localized-fallback")
                  ? [offer("localized-fallback")]
                  : filter.id?.$in?.includes("localized")
                    ? [offer("localized")]
                    : filter.id?.$in?.includes("cache-malformed")
                      ? [offer("cache-malformed")]
                      : filter["seller.id"] === "seller-b" && !filter.id?.$in
                        ? [
                            offer("fallback", {
                              seller: { id: "seller-b", name: "Seller B" },
                            }),
                          ]
                        : filter["seller.id"] === "seller-c" &&
                            filter.id?.$in?.includes("top-offer")
                          ? [
                              offer("top-offer", {
                                seller: { id: "seller-c", name: "Seller C" },
                              }),
                            ]
                          : [],
      ),
    );
    mocks.offerFindOne.mockResolvedValue(null);
    mocks.priceFind.mockReturnValue(query([]));
    mocks.priceFindOne.mockImplementation((filter: Record<string, any>) => ({
      lean: async () =>
        filter.offerId === "localized" && filter.region === "EURO"
          ? {
              offerId: "localized",
              region: "EURO",
              currencyCode: "EUR",
              price: { originalPrice: 1999, discountPrice: 1499, discount: 25 },
            }
          : null,
    }));
    mocks.gamePositionFind.mockReturnValue(
      query([{ offerId: "top-offer", position: 1 }]),
    );
    mocks.sellerFindOne.mockReturnValue({
      lean: async () => ({ _id: "seller-a", name: "Seller A" }),
    });
    mocks.offerCount.mockResolvedValue(7);
    mocks.itemCount.mockResolvedValue(4);
    mocks.offerAggregate.mockResolvedValue([{ count: 2 }]);

    const cases = [
      {
        name: "item-offer-linked",
        request: { method: "GET", path: "/v1/items/item-linked/offer" },
        input: {
          item: { id: "item-linked" },
          subItems: [{ _id: "linked", subItems: [{ id: "item-linked" }] }],
          offers: [offer("linked")],
        },
        response: await capture(itemApp, "/v1/items/item-linked/offer"),
      },
      {
        name: "item-offer-missing",
        request: { method: "GET", path: "/v1/items/item-missing/offer" },
        input: { item: null },
        response: await capture(itemApp, "/v1/items/item-missing/offer"),
      },
      {
        name: "item-offer-no-eligible-offer",
        request: { method: "GET", path: "/v1/items/item-no-offer/offer" },
        input: { item: { id: "item-no-offer" }, subItems: [], offers: [] },
        response: await capture(itemApp, "/v1/items/item-no-offer/offer"),
      },
      {
        name: "item-offer-country-blocked",
        request: {
          method: "GET",
          path: "/v1/items/item-blocked/offer?country=DE",
        },
        input: {
          item: { id: "item-blocked" },
          subItems: [{ _id: "blocked", subItems: [{ id: "item-blocked" }] }],
          offers: [offer("blocked", { countriesBlacklist: ["DE"] })],
        },
        response: await capture(
          itemApp,
          "/v1/items/item-blocked/offer?country=DE",
        ),
      },
      {
        name: "item-offer-localized-translated-price",
        request: {
          method: "GET",
          path: "/v1/items/item-localized/offer?country=FR&locale=fr-FR",
        },
        input: {
          item: { id: "item-localized" },
          subItems: [
            { _id: "localized", subItems: [{ id: "item-localized" }] },
          ],
          offers: [offer("localized")],
          price: {
            offerId: "localized",
            region: "EURO",
            currencyCode: "EUR",
            price: { originalPrice: 1999, discountPrice: 1499, discount: 25 },
          },
          localization: {
            entityType: "offer",
            entityId: "ns:localized",
            locale: "fr-FR",
            source: "oracle",
            fetchedAt: "2026-11-01T00:00:00.000Z",
            data: {
              title: "Titre localisé",
              description: "Description localisée",
            },
          },
        },
        response: await capture(
          itemApp,
          "/v1/items/item-localized/offer?country=FR&locale=fr-FR",
        ),
      },
      {
        name: "item-offer-localized-locale-fallback",
        request: {
          method: "GET",
          path: "/v1/items/item-localized-fallback/offer?country=FR&locale=fr-FR",
        },
        input: {
          item: { id: "item-localized-fallback" },
          subItems: [
            {
              _id: "localized-fallback",
              subItems: [{ id: "item-localized-fallback" }],
            },
          ],
          offers: [offer("localized-fallback")],
        },
        response: await capture(
          itemApp,
          "/v1/items/item-localized-fallback/offer?country=FR&locale=fr-FR",
        ),
      },
      {
        name: "item-offer-localized-bom-locale",
        request: {
          method: "GET",
          path: "/v1/items/item-localized/offer?country=FR&locale=%EF%BB%BFfr-FR",
        },
        input: {
          item: { id: "item-localized" },
          subItems: [
            { _id: "localized", subItems: [{ id: "item-localized" }] },
          ],
          offers: [offer("localized")],
          price: {
            offerId: "localized",
            region: "EURO",
            currencyCode: "EUR",
            price: { originalPrice: 1999, discountPrice: 1499, discount: 25 },
          },
          localization: {
            entityType: "offer",
            entityId: "ns:localized",
            locale: "fr-FR",
            source: "oracle",
            fetchedAt: "2026-11-01T00:00:00.000Z",
            data: {
              title: "Titre localisé",
              description: "Description localisée",
            },
          },
        },
        response: await capture(
          itemApp,
          "/v1/items/item-localized/offer?country=FR&locale=%EF%BB%BFfr-FR",
        ),
      },
      {
        name: "item-offer-nel-locale-rejected",
        request: {
          method: "GET",
          path: "/v1/items/item-nel/offer?locale=%C2%85",
        },
        input: { item: null },
        response: await capture(
          itemApp,
          "/v1/items/item-nel/offer?locale=%C2%85",
        ),
      },
      {
        name: "item-offer-cache-hit-not-found",
        request: { method: "GET", path: "/v1/items/item-cache-hit/offer" },
        input: { cache: { status: "offer_not_found" } },
        response: await (async () => {
          mocks.cacheGet.mockResolvedValueOnce(
            JSON.stringify({ status: "offer_not_found" }),
          );
          return capture(itemApp, "/v1/items/item-cache-hit/offer");
        })(),
      },
      {
        name: "item-offer-malformed-cache-falls-through",
        request: {
          method: "GET",
          path: "/v1/items/item-cache-malformed/offer",
        },
        input: {
          cache: "{malformed",
          item: { id: "item-cache-malformed" },
          subItems: [
            {
              _id: "cache-malformed",
              subItems: [{ id: "item-cache-malformed" }],
            },
          ],
          offers: [offer("cache-malformed")],
        },
        response: await (async () => {
          mocks.cacheGet.mockResolvedValueOnce("{malformed");
          return capture(itemApp, "/v1/items/item-cache-malformed/offer");
        })(),
      },
      {
        name: "item-offer-invalid-locale",
        request: {
          method: "GET",
          path: "/v1/items/item-invalid-locale/offer?locale=not_a_locale",
        },
        input: { item: null },
        response: await capture(
          itemApp,
          "/v1/items/item-invalid-locale/offer?locale=not_a_locale",
        ),
      },
      {
        name: "item-offer-unknown-query",
        request: {
          method: "GET",
          path: "/v1/items/item-query/offer?currency=EUR",
        },
        input: { item: null },
        response: await capture(
          itemApp,
          "/v1/items/item-query/offer?currency=EUR",
        ),
      },
      {
        name: "item-offers-direct-linked-missing",
        request: {
          method: "POST",
          path: "/v1/items/bulk/offers",
          body: { items: ["item-direct", "item-linked", "item-absent"] },
        },
        input: {
          direct: [offer("direct", { items: [{ id: "item-direct" }] })],
          linked: [{ _id: "linked", subItems: [{ id: "item-linked" }] }],
          linkedOffers: [offer("linked")],
          absent: "item-absent",
        },
        response: await captureResponse(
          await itemApp.request("/v1/items/bulk/offers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              items: ["item-direct", "item-linked", "item-absent"],
            }),
          }),
        ),
      },
      {
        name: "item-offers-duplicates-and-unknown",
        request: {
          method: "POST",
          path: "/v1/items/bulk/offers?country=FR",
          body: { items: ["item-direct", "item-direct", "unknown"] },
        },
        input: {
          direct: [offer("direct", { items: [{ id: "item-direct" }] })],
          linked: [],
          linkedOffers: [],
          requested: ["item-direct", "unknown"],
        },
        response: await captureResponse(
          await itemApp.request("/v1/items/bulk/offers?country=FR", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              items: ["item-direct", "item-direct", "unknown"],
            }),
          }),
        ),
      },
      {
        name: "item-offers-all-unknown",
        request: {
          method: "POST",
          path: "/v1/items/bulk/offers",
          body: { items: ["unknown-a", "unknown-b"] },
        },
        input: {
          direct: [],
          linked: [],
          linkedOffers: [],
          requested: ["unknown-a", "unknown-b"],
        },
        response: await captureResponse(
          await itemApp.request("/v1/items/bulk/offers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: ["unknown-a", "unknown-b"] }),
          }),
        ),
      },
      {
        name: "item-offers-empty",
        request: {
          method: "POST",
          path: "/v1/items/bulk/offers",
          body: { items: [] },
        },
        input: { direct: [], linked: [], linkedOffers: [], requested: [] },
        response: await captureResponse(
          await itemApp.request("/v1/items/bulk/offers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: [] }),
          }),
        ),
      },
      {
        name: "item-offers-country-blocked",
        request: {
          method: "POST",
          path: "/v1/items/bulk/offers?country=FR",
          body: { items: ["item-blocked-bulk"] },
        },
        input: {
          direct: [
            offer("blocked-bulk", {
              items: [{ id: "item-blocked-bulk" }],
              countriesBlacklist: ["FR"],
            }),
          ],
          linked: [],
          linkedOffers: [],
          requested: ["item-blocked-bulk"],
        },
        response: await captureResponse(
          await itemApp.request("/v1/items/bulk/offers?country=FR", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: ["item-blocked-bulk"] }),
          }),
        ),
      },
      {
        name: "seller-cover-top-list-empty-fallback",
        request: { method: "GET", path: "/v1/sellers/seller-a/cover" },
        input: {
          topSellerPositions: [{ offerId: "top-offer", position: 1 }],
          topSellerOffers: [],
          fallbackOffers: [],
        },
        response: await capture(sellerApp, "/v1/sellers/seller-a/cover"),
      },
      {
        name: "seller-cover-fallback-nonempty",
        request: { method: "GET", path: "/v1/sellers/seller-b/cover" },
        input: {
          topSellerPositions: [{ offerId: "top-offer", position: 1 }],
          topSellerOffers: [],
          fallbackOffers: [
            offer("fallback", { seller: { id: "seller-b", name: "Seller B" } }),
          ],
        },
        response: await capture(sellerApp, "/v1/sellers/seller-b/cover"),
      },
      {
        name: "seller-cover-prefers-top-seller-offers",
        request: { method: "GET", path: "/v1/sellers/seller-c/cover" },
        input: {
          topSellerPositions: [{ offerId: "top-offer", position: 1 }],
          topSellerOffers: [
            offer("top-offer", {
              seller: { id: "seller-c", name: "Seller C" },
            }),
          ],
          fallbackOffers: [],
        },
        response: await capture(sellerApp, "/v1/sellers/seller-c/cover"),
      },
      {
        name: "seller-stats-combined-free-games",
        request: { method: "GET", path: "/v1/sellers/seller-a/stats" },
        input: {
          seller: { _id: "seller-a", name: "Seller A" },
          offers: 7,
          items: 4,
          games: 2,
          freegames: 2,
          mobileFreegames: 3,
        },
        response: await capture(sellerApp, "/v1/sellers/seller-a/stats"),
      },
    ];
    assertOracle("catalog-http-node", cases);
    expect(cases.map((entry) => entry.response.status)).toEqual([
      200, 404, 404, 404, 200, 200, 200, 400, 404, 200, 400, 400, 200, 200, 200,
      200, 200, 200, 200, 200, 200,
    ]);
  });
});
