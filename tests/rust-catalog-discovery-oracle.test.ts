import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOracle,
  captureResponse,
  fixtureValue,
} from "../rust/oracles/record.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { encodeCursor } from "../src/v1/cursor.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import CatalogRoute from "../src/v1/routes/catalog.js";

type Row = Record<string, unknown>;
type Input = Record<string, unknown> &
  Partial<
    Record<
      | "offers"
      | "prices"
      | "items"
      | "changes"
      | "tags"
      | "featured"
      | "localizations",
      Row[]
    >
  > &
  Partial<Record<"offer" | "price" | "change" | "subItems" | "context", Row>>;
const state = vi.hoisted(() => ({
  input: {} as Input,
  cache: new Map<string, string>(),
}));
type TraceEntry = { call: unknown; result?: unknown; error?: boolean };
const trace = vi.hoisted(() => [] as TraceEntry[]);

function traced<T>(call: unknown, read: () => T): T {
  try {
    const result = read();
    trace.push({ call, result: fixtureValue(result) });
    return result;
  } catch (error) {
    trace.push({ call, error: true });
    throw error;
  }
}

function mongoCall(
  collection: string,
  method: string,
  filter: unknown,
  options: unknown = {},
) {
  // The BSON driver encodes undefined filter values as null.
  const query = JSON.parse(
    JSON.stringify(fixtureValue(filter), (_, v) =>
      v === undefined ? null : v,
    ),
  );
  return { collection, method, query, options };
}

function fixtureRows(name: string, method: string): Row[] {
  if (state.input.mongoError === `${name}.${method}`)
    throw Error("Fixture database unavailable");
  const input = state.input;
  switch (name) {
    case "offers":
      return input.offers ?? (input.offer ? [input.offer] : []);
    case "pricev2":
      return input.prices ?? (input.price ? [input.price] : []);
    case "egs_localizations":
      return input.localizations ?? [];
    case "tags":
      return input.tags ?? [];
    case "items":
      return input.items ?? [];
    case "changelogs_v2":
      return input.changes ?? (input.change ? [input.change] : []);
    case "offersubitems":
      return input.subItems ? [input.subItems] : [];
    case "assets":
    case "builds":
      return input.context ? [input.context] : [];
    default:
      return [];
  }
}
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (name: string) => ({
        findOne: async (filter: unknown, options?: Record<string, unknown>) => {
          return traced(mongoCall(name, "one", filter, options), () => {
            if (
              state.input.failPrepurchaseLookup &&
              (filter as Record<string, unknown>).prePurchase === true
            )
              throw Error("Fixture prepurchase read unavailable");
            const values = fixtureRows(name, "findOne");
            const row =
              name === "offers" &&
              state.input.prepurchaseOnly &&
              (filter as Record<string, unknown>).prePurchase !== true
                ? undefined
                : values[0];
            const projection = options?.projection as
              | Record<string, number>
              | undefined;
            if (
              row &&
              projection &&
              Object.values(projection).some((value) => value === 1)
            ) {
              const selected = [
                ...new Set([
                  ...(projection._id === 0 ? [] : ["_id"]),
                  ...Object.keys(projection).filter(
                    (key) => projection[key] === 1,
                  ),
                ]),
              ];
              return Object.fromEntries(
                selected
                  .map((key) => [key, row[key]])
                  .filter(([, value]) => value !== undefined),
              );
            }
            return row ?? null;
          });
        },
        find: (filter: unknown = {}, options?: Record<string, unknown>) => {
          const result = {
            sort: vi.fn(() => result),
            limit: vi.fn(() => result),
            toArray: async () =>
              traced(mongoCall(name, "many", filter, options), () =>
                fixtureRows(name, "find").slice(
                  0,
                  Math.abs(Number(options?.limit ?? Infinity)),
                ),
              ),
          };
          return result;
        },
        countDocuments: async (filter: unknown, options?: unknown) => {
          return traced(
            mongoCall(name, "count", filter, options),
            () => fixtureRows(name, "countDocuments").length,
          );
        },
      }),
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      const value = traced({ method: "get", key }, () => {
        if (state.input.cacheError === "get")
          throw Error("Fixture cache unavailable");
        return (
          state.input.cached ??
          (state.cache.has(key) ? JSON.parse(state.cache.get(key)!) : null)
        );
      });
      return value === null ? null : JSON.stringify(value);
    },
    set: async (key: string, value: string, mode: string, ttl: number) => {
      traced(
        {
          method: "set",
          key,
          payload: JSON.parse(value),
          ttl: mode === "EX" ? ttl : null,
        },
        () => {
          if (state.input.cacheError === "set")
            throw Error("Fixture cache unavailable");
          state.cache.set(key, value);
          return null;
        },
      );
      return "OK";
    },
  },
}));
vi.mock("../src/utils/get-featured-games.js", () => ({
  getFeaturedGames: async () =>
    traced({ method: "featuredGames" }, () => {
      if (state.input.epicError) throw Error("Fixture Epic unavailable");
      return state.input.featured ?? [];
    }),
}));

const app = new Hono();
app.use("*", v1Context());
app.use("*", responseEtag);
app.use("*", v1CachePolicy());
app.route("/v1", CatalogRoute);
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

describe("registered catalog discovery Node HTTP oracle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    state.cache.clear();
    vi.useRealTimers();
  });
  it("records populated discovery, sales, and changelog responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T18:00:00.000Z"));
    const cases: {
      name: string;
      request: { method: string; path: string };
      trace: TraceEntry[];
      cursorUnconfigured?: boolean;
      response: Awaited<ReturnType<typeof captureResponse>>;
    }[] = [];
    const add = async (
      name: string,
      path: string,
      input: Record<string, unknown>,
    ) => {
      state.input = input;
      state.cache.clear();
      trace.length = 0;
      const request = { method: "GET", path };
      const response = await captureResponse(
        await app.request(path, {
          headers: {
            "x-egdata-key-id": "key_oracle",
            "x-egdata-key-tier": "free",
            "x-request-id": "req_node_oracle",
          },
        }),
      );
      cases.push({
        name,
        request,
        ...(input.cursorUnconfigured ? { cursorUnconfigured: true } : {}),
        trace: [...trace],
        response,
      });
      return response;
    };
    const offer = {
      _id: "mongo-offer-a",
      id: "offer-a",
      namespace: "ns-a",
      title: "A Game",
      description: "A description",
      offerType: "BASE_GAME",
      creationDate: new Date("2026-10-01T00:00:00.000Z"),
      lastModifiedDate: new Date("2026-10-02T00:00:00.000Z"),
      keyImages: [],
      items: [],
      tags: [],
      offerMappings: { pageSlug: "a-game" },
    };
    await add("tags-populated", "/v1/tags?group=genre", {
      tags: [{ id: 17, name: "Action", groupName: "genre", referenceCount: 8 }],
    });
    await add("tags-without-group", "/v1/tags", {
      tags: [{ id: 17, name: "Action", groupName: "genre", referenceCount: 8 }],
    });
    await add("offer-slug-populated", "/v1/offer-by-slug/a-game", { offer });
    await add("base-game-populated", "/v1/base-game/ns-a?country=US", {
      offer,
      price: {
        offerId: "offer-a",
        region: "NAE",
        price: {
          currencyCode: "USD",
          discount: 0,
          originalPrice: 1999,
          discountPrice: 1999,
        },
        updatedAt: new Date("2026-10-02T00:00:00.000Z"),
      },
    });
    await add("latest-games-populated", "/v1/latest-games?country=US", {
      offers: [offer],
      prices: [
        {
          offerId: "offer-a",
          region: "NAE",
          price: {
            currencyCode: "USD",
            discount: 0,
            originalPrice: 1999,
            discountPrice: 1999,
          },
        },
      ],
    });
    await add("featured-populated", "/v1/featured?country=US", {
      featured: [{ namespace: "ns-a", id: "offer-a" }],
      offers: [offer],
      prices: [
        {
          offerId: "offer-a",
          region: "NAE",
          price: {
            currencyCode: "USD",
            discount: 0,
            originalPrice: 1999,
            discountPrice: 1999,
          },
        },
      ],
    });
    await add("autocomplete-populated", "/v1/autocomplete?query=game", {
      offers: [offer],
    });
    const autocompleteOffers = Array.from({ length: 10 }, (_, index) => ({
      ...offer,
      _id: `mongo-fortnite-${index}`,
      id: `fortnite-${index}`,
      title: `Fortnite ${index}`,
      offerType: index % 2 ? "BASE_GAME" : "DLC",
      lastModifiedDate: new Date(
        `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      ),
    })).sort(
      (left, right) =>
        right.offerType.localeCompare(left.offerType) ||
        right.lastModifiedDate.getTime() - left.lastModifiedDate.getTime(),
    );
    await add(
      "autocomplete-limit-and-sort",
      "/v1/autocomplete?query=fortnite",
      { offers: autocompleteOffers },
    );
    await add("items-from-offer-populated", "/v1/items-from-offer/offer-a", {
      offer: { ...offer, items: [{ id: "item-a" }] },
      items: [
        {
          id: "item-a",
          namespace: "ns-a",
          title: "Included item",
          keyImages: [],
          tags: [],
          attributes: [],
        },
      ],
    });
    const offerB = {
      ...offer,
      _id: "mongo-offer-b",
      id: "offer-b",
      namespace: "ns-b",
      title: "B Game",
    };
    const priceA = {
      offerId: "offer-a",
      region: "NAE",
      price: {
        currencyCode: "USD",
        discount: 25,
        originalPrice: 1999,
        discountPrice: 1499,
      },
      appliedRules: { endDate: new Date("2026-12-01T00:00:00.000Z") },
    };
    const priceB = {
      offerId: "offer-b",
      region: "NAE",
      price: {
        currencyCode: "USD",
        discount: 15,
        originalPrice: 2999,
        discountPrice: 2549,
      },
      appliedRules: { endDate: new Date("2026-12-02T00:00:00.000Z") },
    };
    const salesFirst = await add(
      "sales-populated",
      "/v1/sales?country=US&limit=1",
      { offers: [offer, offerB], prices: [priceA, priceB] },
    );
    const salesCursor = salesFirst.body.meta.pagination.nextCursor as string;
    await add(
      "sales-cursor-continuation",
      `/v1/sales?country=US&limit=1&cursor=${encodeURIComponent(salesCursor)}`,
      { offers: [offerB], prices: [priceB], cursor: salesCursor },
    );
    await add(
      "sales-invalid-cursor",
      "/v1/sales?limit=1&cursor=not-a-cursor",
      {},
    );
    await add("active-sales-populated", "/v1/active-sales?country=US&limit=1", {
      tags: [
        {
          id: 29899,
          name: "Sale",
          referenceCount: 1,
          updated: new Date("2026-10-03T00:00:00.000Z"),
        },
      ],
      offers: [offer],
      prices: [
        {
          offerId: "offer-a",
          region: "NAE",
          price: {
            currencyCode: "USD",
            discount: 25,
            originalPrice: 1999,
            discountPrice: 1499,
          },
        },
      ],
    });
    const change = {
      _id: "507f1f77bcf86cd799439011",
      timestamp: new Date("2026-10-03T00:00:00.000Z"),
      metadata: {
        contextType: "offer",
        contextId: "offer-a",
        action: "updated",
      },
      changes: { title: { before: "Old", after: "A Game" } },
    };
    await add("changelog-populated", "/v1/changelog?limit=1", {
      changes: [change],
      offer,
      context: offer,
    });
    await add("changelog-alias-populated", "/v1/changelist?limit=1", {
      changes: [change],
      offer,
      context: offer,
    });
    await add(
      "changelog-invalid-cursor",
      "/v1/changelog?limit=1&cursor=not-a-cursor",
      {},
    );
    await add(
      "changelist-detail-populated",
      "/v1/changelist/507f1f77bcf86cd799439011",
      { change, offer, context: offer },
    );
    await add(
      "changelist-detail-missing",
      "/v1/changelist/507f1f77bcf86cd799439099",
      {},
    );
    for (const route of [
      "latest-games",
      "featured",
      "autocomplete",
      "sales",
      "active-sales",
      "base-game/ns",
      "tags",
      "changelog",
    ]) {
      await add(`${route}-unknown`, `/v1/${route}?unknown=x`, {});
    }
    for (const route of [
      "latest-games",
      "featured",
      "sales",
      "active-sales",
      "base-game/ns",
    ]) {
      await add(`${route}-country`, `/v1/${route}?country=ZZ`, {});
    }
    for (const [route, maximum] of [
      ["sales", 30],
      ["active-sales", 50],
      ["changelog", 50],
    ] as const) {
      await add(
        `${route}-excess-limit`,
        `/v1/${route}?limit=${maximum + 1}`,
        {},
      );
      await add(`${route}-boundary`, `/v1/${route}?limit=${maximum}`, {});
    }
    for (const [name, path] of Object.entries({
      required: "",
      empty: "?query=",
      long: `?query=${encodeURIComponent("🎮".repeat(101))}`,
      invalidLocale: "?query=a&locale=_",
      partialInteger: "?query=game&limit=2games",
      zero: "?query=game&limit=0",
      signed: "?query=game&limit=%2B2",
    }))
      await add(`autocomplete-${name}`, `/v1/autocomplete${path}`, {
        offers: [offer, offerB],
      });
    await add("tags-empty-group", "/v1/tags?group=", {});
    await add("slug-absent", "/v1/offer-by-slug/absent", {});
    await add("slug-missing-id", "/v1/offer-by-slug/sparse", {
      offer: { namespace: "ns" },
    });
    await add("slug-number-id", "/v1/offer-by-slug/numeric", {
      offer: { id: 45 },
    });
    await add("hidden-base", "/v1/base-game/SeaQA", {});
    await add("base-absent", "/v1/base-game/ns", {});
    await add("base-prepurchase", "/v1/base-game/ns", {
      offer,
      prepurchaseOnly: true,
    });
    await add("featured-empty", "/v1/featured", {});
    await add("featured-unavailable-offers", "/v1/featured", {
      featured: [{ id: "gone" }],
    });
    await add("items-missing-offer", "/v1/items-from-offer/missing", {});
    const item = { id: "item", title: "first" };
    await add("items-subitems-and-duplicates", "/v1/items-from-offer/set", {
      offer: { items: [{ id: "z" }, { id: "a" }] },
      subItems: { subItems: [{ id: "a" }, { id: "b" }] },
      items: [
        item,
        { ...item, title: "second" },
        { title: "sparse" },
        { title: "also sparse" },
      ],
    });
    await add("latest-empty", "/v1/latest-games", {});
    await add("active-invalid-cursor", "/v1/active-sales?cursor=invalid", {});
    const tag = { id: 2, name: "Sale", updated: new Date("2026-11-01Z") };
    const tagB = { id: 3, name: "Winter Sale" };
    for (const [name, firstTag] of Object.entries({
      dated: tag,
      undated: tagB,
      text: { id: "legacy-tag" },
    })) {
      const first = await add(
        `active-first-${name}`,
        "/v1/active-sales?limit=1",
        { tags: [firstTag, tagB] },
      );
      const next = first.body.meta.pagination.nextCursor;
      await add(
        `active-next-${name}`,
        `/v1/active-sales?limit=1&cursor=${encodeURIComponent(next)}`,
        {},
      );
    }
    for (const [name, prices] of Object.entries({
      free: [{ ...priceA, price: { discount: 0, originalPrice: 0 } }],
      discount: [priceA],
      inactive: [{ ...priceA, price: { originalPrice: 42 } }],
      none: [],
    })) {
      await add(`active-${name}`, "/v1/active-sales", {
        tags: [tag],
        offers: [offer],
        prices,
      });
    }
    const detail = "/v1/changelist/507f1f77bcf86cd799439011";
    for (const [kind, id] of [
      ["item", "item"],
      ["asset", "asset"],
      ["build", "507f1f77bcf86cd799439012"],
      ["build", "legacy-build"],
      ["unknown", "other"],
      ["offer", ""],
      ["", "x"],
    ]) {
      await add(`change-${kind}-${id}`, detail, {
        change: { ...change, metadata: { contextType: kind, contextId: id } },
        items: [item],
        context: { id, _id: id, appName: "Build", artifactId: "asset" },
      });
    }
    await add("detail-missing-metadata", detail, {
      change: { _id: change._id },
    });
    await add("detail-missing-id", detail, {
      change: { metadata: { contextType: "item" } },
    });
    await add("detail-invalid-id", "/v1/changelist/not-an-oid", {});
    for (const [name, row] of Object.entries({
      dated: change,
      sparse: { _id: "legacy-id" },
    })) {
      const first = await add(
        `changes-first-${name}`,
        "/v1/changelog?limit=1",
        { changes: [row, change] },
      );
      await add(
        `changes-next-${name}`,
        "/v1/changelist?limit=1&cursor=" +
          encodeURIComponent(first.body.meta.pagination.nextCursor),
        {},
      );
    }
    const pagination = { limit: 20, hasMore: false, nextCursor: null };
    for (const [route, cached] of Object.entries({
      "latest-games": [{ id: "cached" }],
      featured: [],
      "autocomplete?query=game": { elements: [], total: 10 },
      sales: {
        offers: [],
        pagination,
        localeMeta: { localeStatus: "fallback" },
      },
      "active-sales": { elements: [], pagination },
      changelog: { elements: [], pagination },
      "items-from-offer/id": [],
      "base-game/ns": { id: "cached", locale: "fr" },
    })) {
      await add(`warm-${route}`, `/v1/${route}`, { cached });
    }
    for (const [route, errors, input] of [
      ["latest-games", ["offers.find", "pricev2.find"], { offer }],
      [
        "featured",
        ["offers.find", "pricev2.find"],
        { featured: [{ id: offer.id }], offer },
      ],
      ["autocomplete?query=a", ["offers.find", "offers.countDocuments"], {}],
      ["sales", ["offers.find", "pricev2.find"], { price: priceA }],
      [
        "active-sales",
        ["tags.find", "offers.find", "pricev2.find"],
        { tags: [tag], offer },
      ],
      ["tags", ["tags.find"], {}],
      ["offer-by-slug/id", ["offers.findOne"], {}],
      ["base-game/ns", ["offers.findOne", "pricev2.findOne"], { offer }],
      [
        "items-from-offer/id",
        ["offers.findOne", "offersubitems.findOne", "items.find"],
        { offer },
      ],
      ["changelog", ["changelogs_v2.find"], {}],
      [
        detail.slice(4),
        ["changelogs_v2.findOne", "offers.findOne"],
        { change },
      ],
    ] as const)
      for (const mongoError of errors)
        await add(`failure-${route}-${mongoError}`, `/v1/${route}`, {
          ...input,
          mongoError,
        });
    await add("failure-featured-epic", "/v1/featured", { epicError: true });
    for (const [route, ordering, filters] of [
      ["sales", "appliedRules.endDate:asc,offerId:asc", {}],
      ["active-sales", "updated:desc,id:asc", { group: "active-sales" }],
      ["changelog", "timestamp:desc,_id:asc", {}],
    ] as const) {
      const cursor = encodeCursor(
        {
          operation: `catalog.${route}`,
          ordering,
          filters,
          country: "US",
          locale: "en-US",
          limit: 20,
        },
        [null],
      );
      await add(
        `${route}-signed-wrong-tuple`,
        `/v1/${route}?cursor=${encodeURIComponent(cursor)}`,
        {},
      );
    }
    for (const [route, input] of Object.entries({
      "latest-games": { offer },
      featured: { featured: [{ id: offer.id }], offer },
      "autocomplete?query=game": { offer },
      sales: { offer, price: priceA },
      "active-sales": { tags: [tag], offer, price: priceA },
      "base-game/ns": { offer },
    })) {
      await add(
        `${route}-localization-failure`,
        `/v1/${route}${route.includes("?") ? "&" : "?"}locale=fr`,
        { ...input, mongoError: "egs_localizations.find" },
      );
    }
    await add("detail-legacy-id", "/v1/changelist/not-an-oid", {
      change: { _id: "not-an-oid" },
    });
    await add("autocomplete-negative", "/v1/autocomplete?query=game&limit=-1", {
      offers: [offer, offerB],
    });
    await add(
      "autocomplete-bom",
      `/v1/autocomplete?query=${encodeURIComponent("\ufeffgame")}`,
      {},
    );
    const sparsePrice = { offerId: "missing", price: { discount: 1 } };
    await add("sales-missing-rules", "/v1/sales?limit=1", {
      prices: [sparsePrice, priceB],
    });
    await add("active-fractional-id", "/v1/active-sales?limit=1", {
      tags: [{ ...tag, id: 4.5 }, tagB],
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
    vi.stubEnv("V1_CURSOR_SECRET", "");
    try {
      for (const [route, input] of Object.entries({
        sales: { prices: [priceA, priceB] },
        "active-sales": { tags: [tag, tagB] },
        changelog: { changes: [change, change] },
      })) {
        await add(`${route}-cursor-unconfigured`, `/v1/${route}?limit=1`, {
          ...input,
          cursorUnconfigured: true,
        });
      }
    } finally {
      vi.unstubAllEnvs();
    }
    await add("base-prepurchase-db-failure", "/v1/base-game/ns", {
      failPrepurchaseLookup: true,
    });
    await add("sale-without-offer-id", "/v1/sales", {
      offers: [{ title: "orphan" }],
      prices: [priceA],
    });
    await add("warm-sales-without-localization", "/v1/sales", {
      cached: { offers: [], pagination },
    });
    await add("active-missing-id", "/v1/active-sales", {
      tags: [{ name: "Sale" }],
    });
    await add("detail-missing-type", detail, {
      change: { metadata: { contextId: "item" } },
    });
    const oldOffers = [
      { id: 7, title: "numeric" },
      { id: "7", title: "string" },
      { title: "absent" },
      { id: null, title: "null" },
      { id: false, title: "boolean" },
    ];
    const oldPrices = [
      { offerId: 7, price: { discount: "2" } },
      { offerId: "7", price: { discount: true } },
      { price: { discount: [1] } },
      { offerId: null, price: { originalPrice: 0 } },
      { offerId: false, price: { discount: 4 } },
      { offerId: 7, price: { discount: 5 } },
    ];
    for (const [route, extra] of [
      ["latest-games", {}],
      ["featured", { featured: [{ id: "featured" }] }],
      ["autocomplete?query=Historical", {}],
      ["base-game/historical", {}],
      ["sales", {}],
      ["active-sales", { tags: [{ id: 11, name: "Deals" }] }],
    ] as const) {
      for (const [variant, offers, prices] of [
        ["mixed", oldOffers, oldPrices],
        [
          "malformed-attributes",
          [{ id: "a", customAttributes: [null] }],
          [{ offerId: "a" }],
        ],
        ["object-id", [{ id: { part: "a" } }], [{ offerId: { part: "a" } }]],
      ] as const) {
        await add(`historical-${route}-${variant}`, `/v1/${route}`, {
          ...extra,
          offers,
          prices,
        });
      }
    }
    await add("featured-mixed-seed-order", "/v1/featured", {
      featured: oldOffers,
    });
    for (const [label, items, subItems] of [
      [
        "mixed",
        [{ id: 7 }, { id: false }, {}, 7],
        { subItems: [{ id: "7" }, { id: null }] },
      ],
      ["null-direct-entry", [null], {}],
      ["invalid-direct-array", "legacy", {}],
      ["invalid-sub-entry", [], { subItems: [null] }],
      ["invalid-sub-array", [], { subItems: true }],
      ["object-id", [{ id: { nested: 1 } }], {}],
    ] as const) {
      await add(`historical-items-${label}`, "/v1/items-from-offer/old", {
        offer: { items },
        subItems,
        items: [
          ...oldOffers,
          ...oldOffers,
          { id: { nested: 1 } },
          { id: { nested: 1 } },
        ],
      });
    }
    for (const cached of ["🎮!", { length: "old" }, {}, false]) {
      for (const route of [
        "latest-games",
        "featured",
        "items-from-offer/old",
        "autocomplete?query=Old",
        "sales",
        "active-sales",
        "base-game/old",
      ]) {
        await add(
          `cache-shape-${route}-${JSON.stringify(cached)}`,
          `/v1/${route}`,
          { cached },
        );
      }
    }
    for (const mongoError of [undefined, "offers.find", "pricev2.find"]) {
      await add(
        `active-concurrent-tags-${mongoError ?? "ok"}`,
        "/v1/active-sales",
        {
          tags: [{ id: 1 }, { id: 2 }],
          offers: oldOffers,
          prices: oldPrices,
          mongoError,
        },
      );
    }
    const nativeId = new ObjectId("507f1f77bcf86cd799439011");
    const typedOffers = [
      { id: nativeId, namespace: "old", title: "object" },
      { id: nativeId.toHexString(), namespace: "old", title: "string" },
      { id: "different", namespace: nativeId, title: "namespace object" },
    ];
    const typedPrices = [
      // Independent Mongo reads create distinct ObjectId instances.
      { offerId: new ObjectId(nativeId.toHexString()), price: { discount: 1 } },
      { offerId: nativeId.toHexString(), price: { discount: 2 } },
    ];
    for (const [route, extra] of [
      ["latest-games", {}],
      ["featured", { featured: [{ id: "old" }] }],
      ["autocomplete?query=Old", {}],
      ["sales", {}],
      ["base-game/old", {}],
      ["active-sales", { tags: [{ id: "29899" }] }],
    ] as const) {
      const path = `/v1/${route}${route.includes("?") ? "&" : "?"}locale=fr-FR`;
      for (const [label, data] of [
        [
          "localized",
          {
            localizations: [
              {
                entityId: `old:${nativeId}`,
                data: { title: "Titre" },
                source: "epic",
                fetchedAt: new Date("2026-06-04T00:00:00Z"),
              },
            ],
          },
        ],
        [
          "metadata-absent",
          {
            localizations: [
              { entityId: `old:${nativeId}`, data: { title: "Titre" } },
            ],
          },
        ],
        [
          "metadata-null",
          {
            localizations: [
              {
                entityId: `old:${nativeId}`,
                data: { title: "Titre" },
                fetchedAt: null,
                source: null,
              },
            ],
          },
        ],
        ["read-failure", { mongoError: "egs_localizations.find" }],
      ] as const) {
        await add(`${route}-native-ids-${label}`, path, {
          ...extra,
          ...data,
          offers: typedOffers,
          prices: typedPrices,
        });
      }
    }
    for (const date of [2, true, "", "2020", "2020-08", "bad timestamp"]) {
      for (const [path, input] of [
        [
          "sales",
          { prices: [{ ...priceA, appliedRules: { endDate: date } }, priceB] },
        ],
        ["active-sales", { tags: [{ ...tag, updated: date }, tagB] }],
        ["changelog", { changes: [{ ...change, timestamp: date }, change] }],
      ] as const) {
        await add(
          `historical-cursor-${path}-${JSON.stringify(date)}`,
          `/v1/${path}?limit=1`,
          input,
        );
      }
    }
    for (const metadata of [
      "meta",
      ["sale", 0],
      { contextType: "asset", contextId: 7 },
      { contextType: "build", contextId: nativeId },
      { contextType: "offer", contextId: { id: "7" } },
    ]) {
      for (const path of ["/v1/changelog", detail]) {
        await add(
          `historical-context-${path}-${JSON.stringify(metadata)}`,
          path,
          {
            change: { _id: nativeId, metadata },
            offer: { id: 7 },
            context: { id: 7 },
          },
        );
      }
    }
    for (const cacheError of ["get", "set"]) {
      for (const route of [
        "latest-games",
        "featured",
        "autocomplete?query=x",
        "items-from-offer/old",
        "sales",
        "active-sales",
        "changelog",
        "base-game/old",
      ]) {
        await add(`cache-failure-${route}-${cacheError}`, `/v1/${route}`, {
          offer,
          cacheError,
        });
      }
    }
    for (const route of ["changelog", "changelist"]) {
      await add(`historical-cache-${route}`, `/v1/${route}`, {
        cached: { pagination: "historical" },
      });
    }
    for (const localeMeta of [
      "es",
      ["it"],
      { country: "override", source: null },
    ]) {
      await add(
        `warm-sales-legacy-locale-${JSON.stringify(localeMeta)}`,
        "/v1/sales",
        {
          cached: { offers: null, pagination: null, localeMeta },
        },
      );
    }
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    await assertOracle("catalog-discovery-http-node", cases);
  });
});
