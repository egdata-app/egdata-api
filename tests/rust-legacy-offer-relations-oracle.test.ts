import { it, vi } from "vitest";
import { Hono } from "hono";
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
vi.mock("../src/routes/auth.js", () => ({ epic: vi.fn() }));
vi.mock("../src/clients/epic.js", () => ({ epicStoreClient: {} }));

it("records legacy offer relationship responses, Mongo calls, and cache writes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  try {
    const app = new Hono();
    app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
    app.route(
      "/offers/:id",
      (await import("../src/routes/offers/data.js")).default,
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
    const offer = {
      id: "game",
      namespace: "n",
      offerType: "BASE_GAME",
      tags: [{ id: "genre" }, { id: "foo" }],
    };
    const member = {
      id: "member",
      title: "Member",
      namespace: "member-n",
      offerType: "BASE_GAME",
      customAttributes: [{ key: "foo", value: "bar", type: "STRING" }],
      unknownField: "omitted",
    };
    const price = {
      offerId: "member",
      namespace: "n",
      region: "US",
      price: {
        currencyCode: "USD",
        discountPrice: 400,
        originalPrice: 600,
        discount: 200,
      },
    };
    const coll = {
      ...offer,
      categories: ["collections"],
      customAttributes: [
        { key: "com.epicgames.app.collectionOfferIds.1", value: "member" },
      ],
    };
    const bundle = { ...offer, offerType: "Bundle" };
    const regular = { ...offer, prePurchase: true };
    const one = (value: unknown): Read => ["offers", "one", value];
    const many = (value: unknown): Read => ["offers", "many", value];
    const p = (value: unknown): Read => ["pricev2", "one", value];
    const ps = (value: unknown): Read => ["pricev2", "many", value];
    const b = (value: unknown): Read => ["bundles", "one", value];
    await get("bad-locale", "related?locale=nope", 400);
    await get("bad-country", "related?country=invalid", 404);
    await get("related-missing", "related", 404, [one(null)]);
    await get("related-found", "related", 200, [
      one(offer),
      many([member]),
      ps([price]),
    ]);
    await get(
      "related-localized-fallback",
      "related?locale=es-ES&expand=1",
      200,
      [one(offer), many([member]), ps([]), ["egs_localizations", "many", []]],
    );
    await get("related-hit", "related", 200, [], [{ cached: true }], {
      cookie: "EGDATA_COUNTRY=ES",
    });
    await get("suggestions-missing", "suggestions", 404, [one(null)]);
    await get("suggestions", "suggestions", 200, [
      one(offer),
      [
        "tags",
        "many",
        [
          { id: "foo", groupName: "other" },
          { id: "genre", groupName: "genre" },
        ],
      ],
      many([member]),
      ps([price]),
    ]);
    await get("collection-missing", "collection", 404, [one(null)]);
    await get("collection-not-member", "collection", 404, [one(offer)]);
    await get("collection-no-ids", "collection", 404, [
      one({ ...coll, customAttributes: [] }),
    ]);
    await get("collection-missing-attributes", "collection", 500, [
      one({ ...offer, categories: ["collections"] }),
    ]);
    await get("collection-found", "collection?expand=full", 200, [
      one(coll),
      many([member]),
      ps([]),
    ]);
    await get("collection-hit", "collection", 200, [one(coll)], [member]);
    await get("collection-prices-down", "collection", 200, [
      one(coll),
      many([member]),
      ps(new Error("price read failed")),
    ]);
    await get("collection-offers-down", "collection", 200, [
      one(coll),
      many(new Error("offer read failed")),
      ps([price]),
    ]);
    await get("bundle-missing-offer", "bundle", 404, [one(null), p(null)]);
    await get("bundle-offer-service-failure", "bundle", 404, [
      one(new Error("offer read failed")),
      p(price),
    ]);
    await get("bundle-not-a-bundle", "bundle", 404, [one(offer), p(null)]);
    await get("bundle-missing", "bundle", 404, [one(bundle), p(null), b(null)]);
    await get("bundle-members", "bundle", 200, [
      one(bundle),
      p({
        ...price,
        offerId: "game",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      b({ offers: ["member", "unpriced"] }),
      many([member, { ...member, id: "unpriced" }]),
      ps([price]),
    ]);
    await get("bundle-no-live-price", "bundle", 200, [
      one(bundle),
      p(null),
      b({}),
      many([]),
      ps([]),
    ]);
    await get("in-bundle-empty", "in-bundle", 200, [["bundles", "many", []]]);
    await get("in-bundle-found", "in-bundle?expand=full", 200, [
      ["bundles", "many", [{ _id: "member" }, { _id: "gone" }]],
      one(member),
      p(price),
      one(null),
      p(null),
    ]);
    await get("pre-missing", "has-prepurchase", 404, [one(null)]);
    await get("pre-negative-cold", "has-prepurchase", 200, [
      one(offer),
      one(null),
    ]);
    await get("pre-negative-hot", "has-prepurchase", 200, [], false);
    await get("pre-found", "has-prepurchase", 200, [
      one(offer),
      one(member),
      p(null),
    ]);
    await get("regular-missing", "has-regular", 404, [one(null)]);
    await get("regular-not-pre", "has-regular", 200, [one(offer)]);
    await get("regular-negative-cold", "has-regular", 200, [
      one(regular),
      one(null),
    ]);
    await get("regular-negative-hot", "has-regular", 200, [], true);
    await get("regular-found", "has-regular", 200, [
      one(regular),
      one(member),
      p(price),
    ]);
    assertOracle("legacy-offer-relations-http-node", cases);
  } finally {
    vi.useRealTimers();
  }
});
