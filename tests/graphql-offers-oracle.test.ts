import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ collection: vi.fn() }));
vi.mock("../src/db/index.js", () => ({ db: { db: database } }));

import offerResolvers from "../src/graphql/resolvers/offer.js";
import { createLoaders } from "../src/graphql/loaders.js";
import { typeDefs } from "../src/graphql/typedefs.js";

// parseResolveInfo consumes the CommonJS GraphQL schema classes.
const { buildSchema, graphql } = createRequire(import.meta.url)(
  "graphql",
) as typeof import("graphql");
const schema = buildSchema(typeDefs);
const fixturePath = fileURLToPath(
  new URL("../rust/oracles/graphql-offers-node.json", import.meta.url),
);
const now = "2025-01-10T05:00:00.000Z";
type Row = Record<string, unknown>;
type Answer = Row | Row[] | number | null;
const offer = {
  _id: "mongo-1",
  id: "o1",
  namespace: "ns",
  title: "First",
  items: [{ id: "i1" }],
  keyImages: [
    { type: "Thumbnail", url: "thumb" },
    { type: "OfferImageTall", url: "tall" },
  ],
  tags: [{ id: "19847" }, { id: "1370" }, { id: "1264" }, { id: "1370" }],
  customAttributes: [{ key: "test", type: "STRING", value: "y" }],
  upstreamOnly: "example",
};
const other = { ...offer, id: "o2", title: "Second", namespace: "ns2" };
const price = { offerId: "o1", region: "EURO", price: { discount: 100 } };
const positions = [
  { collectionId: "top-sellers", offerId: "o1", position: 2 },
  { collectionId: "top-sellers", offerId: "o2", position: 1 },
];
const localization = {
  entityType: "offer",
  entityId: "ns:o1",
  locale: "es-ES",
  source: "egs",
  data: { title: "Primero", description: "Descripción localizada" },
  fetchedAt: now,
};
const item = {
  id: "i1",
  customAttributes: [
    { key: "ThirdPartyManagedApp", type: "STRING", value: "yes" },
  ],
};
const genre = { id: "g1", name: "Action" };
const event = { id: "e1", groupName: "event" };
const options = { limit: 3, page: 2, country: "ES", locale: "es-ES" };

it("replays real offer, franchise and discovery resolvers and Mongo driver calls", async () => {
  vi.setSystemTime(new Date(now));
  const cases: unknown[] = [];
  async function record(
    name: string,
    parentType: string,
    field: string,
    parent: Row,
    args: Row,
    answers: Answer[],
    expectError = false,
  ) {
    const trace: unknown[] = [];
    let index = 0;
    database.collection.mockImplementation((collection: string) => {
      function result(method: string, filter: unknown, options: unknown = {}) {
        if (index >= answers.length)
          throw new Error(`${name} unexpected ${method} ${collection}`);
        const value = answers[index++];
        const typedFilter = JSON.parse(
          JSON.stringify(filter, function (key, val) {
            return this[key] instanceof Date
              ? { $date: this[key].toISOString() }
              : val;
          }),
        );
        trace.push({
          method,
          collection,
          filter: typedFilter,
          options,
          result: value,
        });
        return value;
      }
      return {
        findOne: async (filter: unknown, options?: unknown) =>
          result("findOne", filter, options),
        find: (filter: unknown, options?: unknown) => ({
          toArray: async () => result("find", filter, options),
        }),
        aggregate: (pipeline: unknown) => ({
          toArray: async () => result("aggregate", pipeline),
        }),
        countDocuments: async (filter: unknown, options?: unknown) =>
          result("count", filter, options),
      };
    });
    const context = { loaders: createLoaders(database) };
    type Resolver = (
      parent: Row,
      args: Row,
      ctx: typeof context,
      info: unknown,
    ) => Promise<unknown>;
    const resolver = (
      offerResolvers as Record<string, Record<string, Resolver>>
    )[parentType][field];
    let expected: unknown;
    let error: unknown;
    if (parentType === "Query" && field === "offer") {
      const selectedFields = ["id", "title", "localeStatus"];
      const result = await graphql({
        schema,
        source: `query($id:ID!, $locale:String){offer(id:$id,locale:$locale){${selectedFields.join(" ")}}}`,
        variableValues: args,
        rootValue: {
          offer: async (resolved: Row, _: unknown, info: unknown) => {
            expected = await resolver(parent, resolved, context, info);
            return expected;
          },
        },
      });
      if (expectError) {
        expect(result.errors, name).toHaveLength(1);
        const failure = result.errors![0];
        error = { message: failure.message, extensions: failure.extensions };
      } else {
        expect(result.errors).toBeUndefined();
      }
      args = { ...args, __selectedFields: selectedFields };
    } else if (expectError) {
      try {
        await resolver(parent, args, context, {});
      } catch (caught) {
        const failure = caught as Error & { extensions?: Row };
        error = {
          message: failure.message,
          extensions: failure.extensions ?? {},
        };
      }
      expect(error, name).toBeDefined();
    } else {
      expected = await resolver(parent, args, context, {});
    }
    expect(index, name).toBe(answers.length);
    cases.push({
      name,
      parentType,
      field,
      parent,
      args,
      trace,
      expected,
      error,
    });
  }
  try {
    await record(
      "invalid list locale",
      "Query",
      "offers",
      {},
      { locale: "en_US" },
      [],
      true,
    );
    for (const field of [
      "offer",
      "upcoming",
      "latestReleased",
      "topSellers",
      "topWishlisted",
      "featuredDiscounts",
      "event",
      "genres",
      "latestAchievements",
    ]) {
      await record(
        "invalid locale on " + field,
        "Query",
        field,
        {},
        { id: "o1", locale: "bad!" },
        [],
        true,
      );
    }
    for (const field of ["sandbox", "items"]) {
      await record(
        "loader rejects absent " + field,
        "Offer",
        field,
        {},
        {},
        [],
        true,
      );
      await record(
        "loader rejects null " + field,
        "Offer",
        field,
        { id: null, namespace: null },
        {},
        [],
        true,
      );
    }
    const sparsePrices = [
      { offerId: null, region: "US", source: "null" },
      { region: "US", source: "missing" },
    ];
    await record("price for missing ID", "Offer", "price", {}, {}, [
      sparsePrices,
    ]);
    await record("price for null ID", "Offer", "price", { id: null }, {}, [
      sparsePrices,
    ]);
    const unlinked = { id: null, namespace: null, tags: [{ id: "genre" }] };
    await record("unlinked suggestions", "Offer", "suggestions", unlinked, {}, [
      [genre],
      [],
    ]);
    await record("unlinked offer features", "Offer", "features", unlinked, {}, [
      [],
      [],
    ]);
    for (const field of [
      "franchises",
      "giveaways",
      "related",
      "positions",
      "ratings",
      "polls",
      "hltb",
      "ageRating",
    ]) {
      const answer = [
        "franchises",
        "giveaways",
        "related",
        "positions",
      ].includes(field)
        ? []
        : null;
      await record("unlinked offer " + field, "Offer", field, unlinked, {}, [
        answer,
      ]);
    }
    await record("partial position row", "Offer", "positions", offer, {}, [
      [
        { collectionId: "missing-position" },
        { collectionId: "ok", position: 1 },
      ],
    ]);
    await record(
      "partial feature references",
      "Offer",
      "features",
      {
        ...offer,
        items: [{}, { id: "i1" }],
        tags: [{ name: "untagged" }, { id: "not-numeric" }],
      },
      {},
      [[], []],
    );
    await record(
      "invalid related offer locale",
      "Offer",
      "related",
      offer,
      { locale: "bad!" },
      [],
      true,
    );
    await record(
      "invalid franchise locale",
      "Franchise",
      "allOffers",
      { offers: ["o1"] },
      { locale: "bad!" },
      [],
      true,
    );
    await record("genre image fallback", "Query", "genres", {}, {}, [
      [genre],
      [
        { id: "other-art", keyImages: [{ type: "Other", url: "fallback" }] },
        { id: "no-art", keyImages: [] },
      ],
    ]);
    await record(
      "unmatched top seller position",
      "Query",
      "topSellers",
      {},
      {},
      [positions, [offer, { ...other, id: "old-id" }], 2],
    );
    await record(
      "unrelated incomplete localization is ignored",
      "Query",
      "latestReleased",
      {},
      { locale: "es-ES" },
      [[offer], [{ entityId: "unknown" }], 1],
    );
    await record(
      "localization without fetch timestamp",
      "Query",
      "latestReleased",
      {},
      { locale: "es-ES" },
      [[offer], [{ ...localization, fetchedAt: undefined }], 1],
    );
    await record(
      "explicitly null localization timestamps",
      "Query",
      "latestReleased",
      {},
      { locale: "es-ES" },
      [
        [offer],
        [{ ...localization, fetchedAt: null, sourceUpdatedAt: null }],
        1,
      ],
    );
    await record(
      "string localization timestamps retain offset",
      "Query",
      "latestReleased",
      {},
      { locale: "es-ES" },
      [
        [offer],
        [
          {
            ...localization,
            fetchedAt: "2025-02-10T08:00:00+02:00",
            sourceUpdatedAt: "2025-01-10T05:00:00Z",
          },
        ],
        1,
      ],
    );
    await record(
      "stored localization timestamp scalars",
      "Query",
      "latestReleased",
      {},
      { locale: "es-ES" },
      [
        [offer],
        [{ ...localization, fetchedAt: 0, sourceUpdatedAt: "historical" }],
        1,
      ],
    );
    await record(
      "upcoming localized",
      "Query",
      "upcoming",
      {},
      { locale: "es-ES" },
      [[offer], [localization], 1],
    );
    await record(
      "latest released localized",
      "Query",
      "latestReleased",
      {},
      { locale: "es-ES" },
      [[offer], [localization], 1],
    );
    await record(
      "invalid nested locale",
      "Offer",
      "suggestions",
      { id: "o1", locale: "bad!" },
      {},
      [],
      true,
    );
    await record(
      "genre missing image collection",
      "Query",
      "genres",
      {},
      {},
      [[genre], [{ id: "absent-images" }]],
      true,
    );
    await record("empty ratings are null", "Offer", "ageRating", offer, {}, [
      { ageGatings: { ESRB: "" } },
    ]);
    await record(
      "localized offer",
      "Query",
      "offer",
      {},
      { id: "o1", locale: "es-ES" },
      [
        { _id: "mongo-1", id: "o1", title: "First", namespace: "ns" },
        [localization],
      ],
    );
    await record("missing offer", "Query", "offer", {}, { id: "absent" }, [
      null,
    ]);
    await record("localized offers", "Query", "offers", {}, options, [
      [offer, other],
      [price, { ...price, price: { discount: 500 } }],
      [localization],
      17,
    ]);
    await record("upcoming", "Query", "upcoming", {}, {}, [[offer], 12]);
    await record(
      "latest released",
      "Query",
      "latestReleased",
      {},
      { limit: -1, page: -1 },
      [[other], 17],
    );
    for (const field of ["topSellers", "topWishlisted"]) {
      await record(field, "Query", field, {}, { limit: 2, page: 3 }, [
        positions,
        [offer, other],
        18,
      ]);
    }
    await record(
      "featured discount",
      "Query",
      "featuredDiscounts",
      {},
      options,
      [positions, [offer, other], [price], [localization]],
    );
    await record("event missing", "Query", "event", {}, { id: "missing" }, [
      null,
    ]);
    await record("event", "Query", "event", {}, { id: "e1", ...options }, [
      event,
      [{ ...offer, price }],
      [localization],
      9,
    ]);
    await record("genres", "Query", "genres", {}, { locale: "es-ES" }, [
      [genre],
      [offer],
      [localization],
    ]);
    await record(
      "latest achievements",
      "Query",
      "latestAchievements",
      {},
      options,
      [[offer, other], [{ sandboxId: "ns" }], [price], [localization]],
    );
    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      ...offer,
      id: "o" + i,
      namespace: "ns" + i,
    }));
    await record(
      "achievements scanned another page",
      "Query",
      "latestAchievements",
      {},
      {},
      [fifteen, [], [], [other], [{ sandboxId: other.namespace }], []],
    );
    await record(
      "individual price",
      "Offer",
      "price",
      offer,
      { country: "ES" },
      [[price]],
    );
    await record(
      "explicit items keep caller order",
      "Offer",
      "items",
      { ...offer, items: [{ id: "i1" }, { id: "missing" }, { id: "i1" }] },
      {},
      [[item]],
    );
    await record(
      "subitem fallback",
      "Offer",
      "items",
      { ...offer, items: [] },
      {},
      [[{ _id: "o1", subItems: [{ id: "i1" }] }], [item]],
    );
    await record("no subitems", "Offer", "items", { ...offer, items: [] }, {}, [
      [],
    ]);
    await record("franchises", "Offer", "franchises", offer, {}, [
      [{ offers: ["o1"] }],
    ]);
    await record("giveaways", "Offer", "giveaways", offer, {}, [
      [{ id: "o1", startDate: now }],
    ]);
    await record(
      "localized related",
      "Offer",
      "related",
      { ...offer, locale: "es-ES" },
      {},
      [[other], []],
    );
    await record(
      "suggestions",
      "Offer",
      "suggestions",
      offer,
      { locale: "es-ES" },
      [[genre], [other], []],
    );
    await record(
      "suggestions no tags",
      "Offer",
      "suggestions",
      { ...offer, tags: [] },
      {},
      [],
    );
    await record("rating chain", "Offer", "ratings", offer, {}, [
      { parent: "p1" },
      { slug: "game" },
      { rating: 4 },
    ]);
    await record("rating no product", "Offer", "ratings", offer, {}, [
      { parent: "p1" },
      null,
    ]);
    await record("polls", "Offer", "polls", offer, {}, [{ _id: "ns" }]);
    await record("hltb", "Offer", "hltb", offer, {}, [{ _id: "o1" }]);
    await record("sandbox", "Offer", "sandbox", offer, {}, [
      [{ _id: "ns", name: "Sandbox" }],
    ]);
    await record(
      "positions use last duplicate",
      "Offer",
      "positions",
      offer,
      {},
      [positions],
    );
    for (const country of ["US", "DE", "ZZ", null]) {
      await record(
        "age rating " + country,
        "Offer",
        "ageRating",
        offer,
        { country },
        [{ ageGatings: { ESRB: "T", USK: "12", Generic: "all" } }],
      );
    }
    await record(
      "features from items and tags",
      "Offer",
      "features",
      offer,
      {},
      [[{ _id: "o1", subItems: [{ id: "i2" }] }], [item]],
    );
    await record(
      "franchise offers",
      "Franchise",
      "allOffers",
      { offers: ["o1", "o2"] },
      { locale: "es-ES" },
      [[offer, other], [localization]],
    );
    const fixture = JSON.stringify({ now, cases }, null, 2) + "\n";
    if (process.env.RUST_ORACLE_WRITE === "1")
      writeFileSync(fixturePath, fixture);
    else
      expect(JSON.parse(fixture)).toEqual(
        JSON.parse(readFileSync(fixturePath, "utf8")),
      );
  } finally {
    vi.useRealTimers();
  }
});
