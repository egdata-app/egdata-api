import { afterAll, expect, it, vi } from "vitest";
import { BSON, MongoClient, ObjectId } from "mongodb";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";

const mongoOptions = new MongoClient("mongodb://127.0.0.1:27017")
  .db("oracle")
  .collection("fixture").bsonOptions;
const wireQuery = (query: unknown) =>
  encoded(BSON.deserialize(BSON.serialize({ query }, mongoOptions)).query);

type Input = {
  rows?: unknown[];
  collections?: Record<string, unknown[]>;
  cache?: unknown;
  fail?: string;
  failMethod?: string;
  renderedLabels?: string[];
  http?: Array<{ status: number; body?: unknown; rawBody?: string }>;
};

const io = vi.hoisted(() => ({
  input: {} as Input,
  trace: [] as unknown[],
  rendered: null as unknown,
  httpQueue: [] as NonNullable<Input["http"]>,
  jobs: [] as unknown[],
}));

function call(entry: Record<string, unknown>, result: unknown) {
  if (
    io.input.fail &&
    io.input.fail === (entry.service ?? entry.collection) &&
    (!io.input.failMethod || entry.method === io.input.failMethod)
  ) {
    io.trace.push({ call: entry, error: true });
    throw new Error("fixture read failed");
  }
  io.trace.push({ call: entry, result: encoded(result) });
  return result;
}

function encoded(value: unknown): unknown {
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof RegExp)
    return {
      $regularExpression: { pattern: value.source, options: value.flags },
    };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encoded);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, encoded(v)]),
    );
  return value;
}

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      command: async () => {
        call({ method: "ping", service: "mongo" }, true);
        return { ok: 1 };
      },
      collection: (collection: string) => ({
        find: (query = {}, options: Record<string, unknown> = {}) => {
          const actual = { ...options };
          delete actual.lean;
          return {
            sort(sort: unknown) {
              actual.sort = sort;
              return this;
            },
            limit(limit: number) {
              actual.limit = limit;
              return this;
            },
            skip(skip: number) {
              actual.skip = skip;
              return this;
            },
            toArray: async () =>
              call(
                {
                  collection,
                  method: "many",
                  query: wireQuery(query),
                  options: encoded(actual),
                },
                io.input.collections?.[collection] ?? io.input.rows ?? [],
              ),
          };
        },
        findOne: async (query = {}, options = {}) =>
          call(
            {
              collection,
              method: "one",
              query: wireQuery(query),
              options: encoded(options),
            },
            (io.input.collections?.[collection] ?? io.input.rows)?.[0] ?? null,
          ),
        updateOne: async (
          query: unknown,
          update: unknown,
          options: Record<string, unknown> = {},
        ) =>
          call(
            {
              collection,
              method: "update",
              query: wireQuery(query),
              options: {
                update: wireQuery(update),
                upsert: Boolean(options?.upsert),
              },
            },
            { modifiedCount: 1 },
          ),
        aggregate: (pipeline: unknown[]) => ({
          toArray: async () =>
            call(
              {
                collection,
                method: "aggregate",
                query: encoded(pipeline),
                options: {},
              },
              io.input.collections?.[collection] ?? io.input.rows ?? [],
            ),
        }),
        countDocuments: async (query = {}) =>
          call(
            {
              collection,
              method: "count",
              query: wireQuery(query),
              options: {},
            },
            0,
          ),
      }),
    },
  },
}));

vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: {
    search: async ({ index, body }: { index: string; body: unknown }) => ({
      body: call({ service: "opensearch", method: "search", index, body }, {}),
    }),
  },
}));

vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: async (key: string) => {
      const hit = call(
        { method: "get", key: key.slice(2) },
        io.input.cache ?? null,
      );
      return hit === null ? null : JSON.stringify(hit);
    },
    ping: async () => {
      call({ method: "ping", service: "redis" }, true);
      return "PONG";
    },
  },
}));

vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      call({ method: "get", key }, io.input.cache ?? null);
      return io.input.cache === undefined || io.input.cache === null
        ? null
        : JSON.stringify(io.input.cache);
    },
    set: async (key: string, value: string, _mode: string, ttl: number) =>
      call(
        {
          method: "set",
          key,
          ...(value === undefined ? {} : { payload: JSON.parse(value) }),
          ttl,
        },
        null,
      ),
  },
  disconnectResponseCache: () => {},
}));

const receipt = {
  jobId: "job-1",
  workflowId: "workflow-1",
  statusUrl: "/jobs/job-1",
  deduplicated: false,
};

vi.mock("../src/clients/job-api.js", () => ({
  submitJobApiRequest: async (jobType: string, payload: unknown) =>
    call(
      {
        service: "job",
        method: "submit",
        jobType,
        payload,
        requestId: null,
      },
      receipt,
    ),
  submitJobApiBatch: async (jobType: string, payloads: unknown[]) =>
    call(
      {
        service: "job",
        method: "submitBatch",
        jobType,
        payloads,
        requestId: null,
      },
      payloads.map(() => receipt),
    ),
}));

vi.mock("satori", () => ({
  default: vi.fn(async (element: unknown) => {
    io.rendered = JSON.stringify(element);
    return "<svg></svg>";
  }),
}));

vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    render() {
      return {
        asPng: () => Buffer.from([137, 80, 78, 71]),
      };
    }
  },
}));

it("replays the root, refresh, regen, review-summary, and Cloudflare OG routes from the full Node app", async () => {
  process.env.CF_IMAGES_KEY = "cf-test-token";
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const next = io.httpQueue.shift();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const httpCall = {
        service: "http",
        method: init?.method ?? "GET",
        url,
        authorization: headers.Authorization ?? null,
        fileName: file.name,
        contentType: file.type,
        byteLength: file.size,
      };
      if (io.input.fail === "http") {
        io.trace.push({ call: httpCall, error: true });
        throw new Error("fixture network unavailable");
      }
      if (!next) throw new Error(`Unexpected fetch to ${url}`);
      io.trace.push({
        call: httpCall,
        status: next.status,
        result: next.body,
        ...(next.rawBody === undefined ? {} : { rawBody: next.rawBody }),
      });
      return new Response(next.rawBody ?? JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  try {
    const { app } = await import("../src/index.js");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));

    const cases: unknown[] = [];
    type RequestCase = {
      method: string;
      path: string;
      headers?: Record<string, string>;
      rawBody?: string;
    };

    const record = async (
      name: string,
      request: RequestCase,
      input: Input = {},
      status = 200,
      captureRendered = false,
    ) => {
      io.input = input;
      io.trace = [];
      io.rendered = null;
      io.httpQueue = [...(input.http ?? [])];
      const response = await app.request(request.path, {
        method: request.method,
        headers: request.headers,
        body: request.rawBody,
      });
      expect(response.status, name).toBe(status);
      const vary = response.headers.get("vary");
      for (const label of input.renderedLabels ?? [])
        expect(io.rendered, name).toContain(label);
      cases.push({
        name,
        request,
        ...(vary !== null ? { additionalHeaders: { vary } } : {}),
        trace: io.trace,
        ...(input.renderedLabels && { renderedLabels: input.renderedLabels }),
        response: await captureResponse(response),
        ...(captureRendered && io.rendered ? { rendered: io.rendered } : {}),
      });
    };

    const get = (
      path: string,
      headers?: Record<string, string>,
    ): RequestCase => ({
      method: "GET",
      path,
      headers,
    });
    const patch = (path: string): RequestCase => ({ method: "PATCH", path });
    const put = (path: string): RequestCase => ({ method: "PUT", path });
    const postJson = (path: string, body: unknown): RequestCase => ({
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      rawBody: JSON.stringify(body),
    });

    // 1. GET /
    await record("root-index", get("/"));

    // 2. PATCH /refresh* and PATCH /free-games/index
    for (const path of [
      "/refresh-meilisearch",
      "/refresh/changelog",
      "/refresh/offers",
      "/refresh/items",
      "/refresh/sellers",
      "/free-games/index",
    ]) {
      await record("patch-" + path.slice(1).replaceAll("/", "-"), patch(path));
    }

    // 3. PUT /offers/regen*, POST /offers/bulk-regen
    await record("offer-regen-slug", put("/offers/regen/my-game"));
    await record("offer-regen-by-id", put("/offers/regen-by-id/offer-123"));
    await record(
      "offer-bulk-regen",
      postJson("/offers/bulk-regen", { offers: ["o1", "o2"] }),
    );
    await record(
      "offer-bulk-regen-invalid",
      postJson("/offers/bulk-regen", {}),
      {},
      500,
    );

    // 4. GET /offers/:id/reviews-summary
    await record(
      "reviews-summary-empty",
      get("/offers/offer-1/reviews-summary"),
      {
        collections: { reviews: [] },
      },
    );
    await record(
      "reviews-summary-cached",
      get("/offers/offer-1/reviews-summary?verified=true"),
      {
        cache: {
          overallScore: 4.5,
          recommendedPercentage: 0.75,
          notRecommendedPercentage: 0.25,
          totalReviews: 4,
        },
      },
    );
    await record(
      "reviews-summary-verified-true",
      get("/offers/offer-1/reviews-summary?verified=true"),
      {
        collections: {
          reviews: [
            { rating: 5, recommended: true },
            { rating: 3, recommended: false },
          ],
        },
      },
    );
    await record(
      "reviews-summary-verified-false",
      get("/offers/offer-1/reviews-summary?verified=false"),
      {
        collections: {
          reviews: [{ rating: 4, recommended: true }],
        },
      },
    );

    // 5. GET /free-games/og
    const freeGame = {
      _id: new ObjectId("65ba00000000000000000010"),
      id: "fg-1",
      startDate: new Date("2026-11-12T16:00:00.000Z"),
      endDate: new Date("2026-11-19T16:00:00.000Z"),
    };
    const freeOffer = {
      id: "fg-1",
      title: "Free Game One",
      keyImages: [
        { type: "DieselGameBoxWide", url: "https://cdn.test/fg-1.png" },
      ],
    };
    const freePrice = {
      offerId: "fg-1",
      region: "ES",
      price: { currencyCode: "EUR", discountPrice: 0, originalPrice: 1999 },
    };
    await record(
      "free-games-og-bad-country",
      get("/free-games/og?country=ZZ"),
      {},
      404,
    );
    await record(
      "free-games-og-cache-hit",
      get("/free-games/og", { cookie: "EGDATA_COUNTRY=ES" }),
      {
        collections: {
          freegames: [freeGame],
          "freebies-og": [{ imageId: "cf-cached-free" }],
        },
      },
    );
    await record(
      "free-games-og-upload-success",
      get("/free-games/og?country=ES"),
      {
        collections: {
          freegames: [freeGame],
          "freebies-og": [],
          offers: [freeOffer],
          pricev2: [freePrice],
        },
        http: [{ status: 200, body: { result: { id: "cf-new-free" } } }],
      },
      200,
      true,
    );
    await record(
      "free-games-og-upload-failure",
      get("/free-games/og?country=US"),
      {
        collections: {
          freegames: [{ ...freeGame, title: "Fallback Free" }],
          "freebies-og": [],
          offers: [],
          pricev2: [],
        },
        http: [{ status: 500, body: { errors: [{ message: "boom" }] } }],
      },
      400,
    );

    // 6. GET /collections/:slug/:week/og
    const collectionDoc = {
      _id: "top-sellers",
      name: "Top Sellers",
      updatedAt: new Date("2026-11-10T00:00:00.000Z"),
    };
    const topPositions = Array.from({ length: 10 }, (_, idx) => ({
      _id: `gp-${idx + 1}`,
      collectionId: "top-sellers",
      offerId: `top-${idx + 1}`,
      positions: [
        { position: idx + 1, date: new Date("2025-07-30T12:00:00.000Z") },
      ],
    }));
    const topOffers = Array.from({ length: 10 }, (_, idx) => ({
      _id: `mongo-top-${idx + 1}`,
      id: `top-${idx + 1}`,
      title: `Top Game ${idx + 1}`,
    }));
    const topPrices = Array.from({ length: 10 }, (_, idx) => ({
      offerId: `top-${idx + 1}`,
      region: "US",
      price: {
        currencyCode: "USD",
        originalPrice: 2999,
        discountPrice: idx === 0 ? 0 : idx === 1 ? 1499 : 2999,
        discount: idx === 0 ? 2999 : idx === 1 ? 1500 : 0,
      },
    }));
    await record(
      "collection-og-incomplete-leaderboard",
      get("/collections/top-sellers/2025W31/og?svg=1"),
      {
        collections: {
          collections_v2: [collectionDoc],
          game_positions: topPositions.slice(0, 9),
          offers: topOffers,
          pricev2: topPrices,
        },
      },
      500,
    );
    await record(
      "collection-og-bad-country",
      get("/collections/top-sellers/2025W31/og?country=ZZ"),
      {},
      404,
    );
    await record(
      "collection-og-missing-collection",
      get("/collections/missing/2025W31/og"),
      { collections: { collections_v2: [] } },
      404,
    );
    await record(
      "collection-og-bad-week",
      get("/collections/top-sellers/bad-week/og"),
      {},
      500,
    );
    await record(
      "collection-og-cache-hit-versioned",
      get("/collections/top-sellers/2025W31/og?v=1"),
      {
        collections: {
          collections_v2: [collectionDoc],
          game_positions: topPositions,
          offers: topOffers,
          pricev2: topPrices,
          "tops-og": [{ imageId: "cf-tops-cached" }],
        },
      },
    );
    await record(
      "collection-og-direct-png-hash",
      get("/collections/top-sellers/2025W31/og?direct=1&hash=abc", {
        cookie: "EGDATA_COUNTRY=US",
      }),
      {
        collections: {
          collections_v2: [collectionDoc],
          game_positions: topPositions,
          offers: topOffers,
          pricev2: topPrices,
          "tops-og": [{ imageId: "cf-tops-cached" }],
        },
      },
      200,
      true,
    );
    await record(
      "collection-og-svg-bypass-upload",
      get("/collections/top-sellers/2025W31/og?svg=1"),
      {
        collections: {
          collections_v2: [collectionDoc],
          game_positions: topPositions,
          offers: topOffers,
          pricev2: topPrices,
        },
        http: [{ status: 200, body: { result: { id: "cf-tops-new" } } }],
      },
      200,
      true,
    );
    await record(
      "collection-og-upload-failure",
      get("/collections/top-sellers/2025W31/og"),
      {
        collections: {
          collections_v2: [collectionDoc],
          game_positions: topPositions,
          offers: topOffers,
          pricev2: topPrices,
          "tops-og": [],
        },
        http: [{ status: 403, body: { success: false } }],
      },
      400,
    );

    const weekly = {
      collections_v2: [collectionDoc],
      game_positions: topPositions,
      offers: topOffers,
      pricev2: topPrices,
      "tops-og": [{ imageId: "cached" }],
    };
    await record(
      "collection-og-stored-date-types-and-ids",
      get("/collections/top-sellers/2025W31/og"),
      {
        collections: {
          ...weekly,
          game_positions: topPositions.map((row, i) => ({
            ...row,
            offerId: i === 0 ? 7 : row.offerId,
            positions: [
              {
                position: i + 1,
                date: i % 2 ? "2025-07-30" : Date.parse("2025-07-30T12:00:00Z"),
              },
            ],
          })),
          offers: topOffers.map((row, i) => ({
            ...row,
            id: i === 0 ? 7 : row.id,
          })),
          pricev2: topPrices.map((row, i) => ({
            ...row,
            offerId: i === 0 ? 7 : row.offerId,
          })),
        },
      },
    );
    const superseded = {
      offerId: "archived",
      positions: [
        { position: 1, date: new Date("2025-07-28T00:00:00Z") },
        { position: "2", date: new Date("2025-07-29T00:00:00Z") },
      ],
    };
    await record(
      "collection-og-latest-string-position",
      get("/collections/top-sellers/2025W31/og"),
      {
        collections: {
          ...weekly,
          game_positions: [superseded, ...topPositions],
        },
      },
    );
    for (const [name, positions] of [
      ["absent", null],
      ["null-entry", [null]],
    ] as const) {
      await record(
        "collection-og-invalid-positions-" + name,
        get("/collections/top-sellers/2025W31/og"),
        {
          collections: {
            ...weekly,
            game_positions: [
              ...topPositions,
              { offerId: "invalid", positions },
            ],
          },
        },
        500,
      );
    }
    for (const service of ["collections_v2", "game_positions", "tops-og"]) {
      await record(
        "collection-og-failed-" + service,
        get("/collections/top-sellers/2025W31/og"),
        {
          collections: weekly,
          fail: service,
        },
        500,
      );
    }
    const free = {
      freegames: [freeGame],
      offers: [freeOffer],
      pricev2: [freePrice],
    };
    for (const [service, method, status] of [
      ["freegames", "many", 500],
      ["freebies-og", "one", 500],
      ["offers", "one", 200],
      ["pricev2", "one", 200],
      ["freebies-og", "update", 500],
    ] as const) {
      await record(
        `free-og-failure-${service}-${method}`,
        get("/free-games/og"),
        {
          collections: free,
          fail: service,
          failMethod: method,
          http: [{ status: 200, body: { result: { id: "og-id" } } }],
        },
        status,
      );
    }
    await record("free-og-cached-missing-id", get("/free-games/og"), {
      collections: { freegames: [freeGame], "freebies-og": [{}] },
    });
    for (const [label, http] of [
      ["bad-gateway-body", { status: 502, rawBody: "edge unavailable" }],
      ["broken-success-json", { status: 200, rawBody: "{" }],
      ["missing-success-result", { status: 201, body: { result: null } }],
    ] as const)
      await record(
        `free-og-${label}`,
        get("/free-games/og"),
        { collections: free, http: [http] },
        500,
      );
    for (const [label, image] of [
      ["missing", {}],
      ["null", { imageId: null }],
      ["numeric", { imageId: 17 }],
    ] as const) {
      await record(
        `collection-og-cached-${label}-id`,
        get("/collections/top-sellers/2025W31/og"),
        { collections: { ...weekly, "tops-og": [image] } },
      );
    }
    for (const fail of ["offers", "pricev2"]) {
      await record(
        `collection-og-joined-read-failure-${fail}`,
        get("/collections/top-sellers/2025W31/og"),
        { collections: weekly, fail },
        500,
      );
    }
    await record(
      "collection-og-old-offer-without-title",
      get("/collections/top-sellers/2025W31/og?hash=%EF%BB%BF"),
      {
        collections: {
          ...weekly,
          offers: topOffers.map((o, i) => (i === 0 ? { id: o.id } : o)),
          "tops-og": [{ imageId: "old" }],
        },
      },
    );
    await record(
      "collection-og-failed-persist",
      get("/collections/top-sellers/2025W31/og?svg=1"),
      {
        collections: weekly,
        fail: "tops-og",
        failMethod: "update",
        http: [{ status: 201, body: { result: { id: "top-image" } } }],
      },
      500,
    );
    for (const [label, request] of [
      ["slug", put("/offers/regen/fail")],
      ["id", put("/offers/regen-by-id/fail")],
      ["bulk", postJson("/offers/bulk-regen", { offers: ["old"] })],
    ] as const) {
      await record(
        `root-regen-store-failure-${label}`,
        request,
        { fail: "job" },
        500,
      );
    }
    const native = new ObjectId("00000000000000000000d101");
    const uploads = [{ status: 201, body: { result: { id: "stored" } } }];
    const og = async (
      name: string,
      game: Record<string, unknown>,
      offer: Record<string, unknown> | null,
      status: number,
      extras: Input = {},
    ) => {
      await record(
        "free-og-historical-" + name,
        get("/free-games/og"),
        {
          collections: {
            freegames: [game],
            offers: offer ? [offer] : [],
            pricev2: [],
          },
          http: uploads,
          ...extras,
        },
        status,
      );
    };
    await og(
      "native-id",
      { ...freeGame, id: native },
      { ...freeOffer, id: new ObjectId(native.toString()) },
      200,
      { renderedLabels: ["Free Game One", "12 Nov", "19 Nov"] },
    );
    await og(
      "string-and-number-dates",
      { ...freeGame, startDate: "Coming this September", endDate: 12345.625 },
      {
        ...freeOffer,
        id: "fg-1",
        keyImages: [
          { type: "OfferImageWide" },
          { type: "Featured", url: "other" },
        ],
      },
      200,
      { renderedLabels: ["Coming this September", "12,345.625"] },
    );
    await og(
      "numeric-title",
      { ...freeGame, title: "Fallback" },
      { id: "fg-1", title: 12345 },
      200,
      { renderedLabels: ["12345"] },
    );
    await og(
      "sparse-without-offer",
      { title: "Future Game", startDate: "TBC", endDate: true },
      null,
      200,
      { renderedLabels: ["Future Game", "TBC", "true"] },
    );
    await og(
      "missing-period",
      { ...freeGame, endDate: undefined },
      freeOffer,
      500,
    );
    await og("null-period", { ...freeGame, startDate: null }, freeOffer, 500);
    await og(
      "broken-offer-attributes",
      freeGame,
      { ...freeOffer, customAttributes: [null] },
      500,
    );
    await og(
      "invalid-image-member",
      freeGame,
      { ...freeOffer, keyImages: [null] },
      500,
    );
    await og(
      "unused-invalid-image",
      freeGame,
      {
        ...freeOffer,
        keyImages: [
          { type: "DieselGameBoxWide", url: "https://cdn.test/first" },
          null,
        ],
      },
      200,
      { renderedLabels: ["https://cdn.test/first"] },
    );
    await og("http-offline", freeGame, freeOffer, 500, { fail: "http" });
    await record(
      "collection-og-http-offline",
      get("/collections/top-sellers/2025W31/og?svg=1"),
      { collections: weekly, fail: "http" },
      500,
    );
    for (const [key, id] of [
      ["oid", native],
      ["missing", undefined],
      ["numeric", 7],
      ["null", null],
    ] as const) {
      await record(
        "collection-og-typed-rank-" + key,
        get("/collections/top-sellers/2025W31/og"),
        {
          collections: {
            ...weekly,
            game_positions: topPositions.map((row, i) =>
              i === 0 ? { ...row, offerId: id } : row,
            ),
            offers: [
              {
                ...topOffers[0],
                id: key === "oid" ? new ObjectId(native.toString()) : id,
              },
              ...topOffers.slice(1),
            ],
            pricev2: [
              {
                ...topPrices[0],
                offerId: key === "oid" ? native.toString() : id,
              },
              ...topPrices.slice(1),
            ],
            "tops-og": [{ imageId: "rank-digest-hit" }],
          },
        },
      );
    }
    await og(
      "array-date-and-fallback-cover",
      { ...freeGame, startDate: ["Period", null, -1234.25], endDate: -7 },
      {
        ...freeOffer,
        title: false,
        keyImages: [
          {
            type: "OldMarketingImage",
            url: "https://cdn.test/old-fallback.png",
          },
        ],
      },
      200,
      {
        renderedLabels: [
          "Period,,-1,234.25",
          "-7",
          "https://cdn.test/old-fallback.png",
        ],
      },
    );
    await record(
      "collection-og-epoch-week-mixed-dates",
      get("/collections/top-sellers/1970W01/og"),
      {
        collections: {
          ...weekly,
          game_positions: topPositions.slice(0, 1).map((row) => ({
            ...row,
            positions: [
              { date: null, position: 20 },
              { date: true, position: 18 },
              { date: { legacy: "date" }, position: 11 },
              { position: 9 },
            ],
          })),
          "tops-og": [{ imageId: "epoch-rank" }],
        },
      },
    );
    for (const [label, result, status] of [
      ["absent", {}, 200],
      ["null", { id: null }, 200],
      ["number", { id: 42 }, 200],
      ["false", { id: false }, 200],
      ["array", { id: [12, "v"] }, 200],
      ["object", { id: { legacy: "id" } }, 200],
      ["scalar-result", "done", 200],
      ["null-result", null, 500],
      ["missing-result", undefined, 500],
    ] as const) {
      const http = [{ status: 201, body: { result } }];
      await record(
        "free-og-upload-id-" + label,
        get("/free-games/og"),
        { collections: free, http },
        status,
      );
      await record(
        "collection-og-upload-id-" + label,
        get("/collections/top-sellers/2025W31/og?svg=1"),
        { collections: weekly, http },
        status,
      );
    }
    assertOracle("legacy-root-ops-http-node", cases);
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

afterAll(async () => {
  vi.useRealTimers();
  const { server } = await import("../src/graphql/index.js");
  await server.stop();
});
