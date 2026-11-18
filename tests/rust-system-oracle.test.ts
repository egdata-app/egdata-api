import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { encodeCursor } from "../src/v1/cursor.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import franchises from "../src/v1/routes/franchises.js";
import awards from "../src/v1/routes/game-awards.js";
import stats from "../src/v1/routes/stats.js";
import system from "../src/v1/routes/system.js";

type Row = Record<string, unknown>;
type Input = {
  counts?: Record<string, number>;
  aggregate?: Row[];
  rows?: Record<string, Row[]>;
  franchise?: Row;
  failure?: string;
  cached?: string;
  noCursorSecret?: boolean;
};
const io = vi.hoisted(() => ({
  input: {} as Input,
  pipelines: [] as unknown[],
  countFilters: [] as unknown[],
  writes: [] as unknown[],
}));
function check(collection: string) {
  if (io.input.failure === collection)
    throw new Error("fixture backend failure");
}
function model(collection: string) {
  return {
    async countDocuments(filter: Row = {}) {
      // Annual count bounds use local midnight in the Node process timezone.
      // Express them as calendar years to compare the same fixture across hosts.
      if (filter.creationDate) {
        const { $gte, $lt } = filter.creationDate as Record<string, Date>;
        for (const date of [$gte, $lt]) {
          if (
            date.getMonth() !== 0 ||
            date.getDate() !== 1 ||
            date.getHours() !== 0 ||
            date.getMinutes() !== 0 ||
            date.getSeconds() !== 0 ||
            date.getMilliseconds() !== 0
          )
            throw new Error("Unexpected annual count boundary");
        }
        filter = { localYears: [$gte.getFullYear(), $lt.getFullYear()] };
      }
      io.countFilters.push({ collection, filter });
      check(collection);
      return io.input.counts?.[collection] ?? 0;
    },
    async aggregate(pipeline: unknown[]) {
      io.pipelines.push(pipeline);
      check(collection);
      return io.input.aggregate ?? [];
    },
    find: (_filter?: Row, projection?: Row) => ({
      lean: async () => {
        check(collection);
        if (projection) check(collection + ".projection");
        return io.input.rows?.[collection] ?? [];
      },
    }),
  };
}
vi.mock("../src/models/index.js", () => ({
  Offer: model("offers"),
  Item: model("items"),
  Tags: model("tags"),
  Asset: model("assets"),
  Changelog: model("changelogs_v2"),
  PriceEngine: model("pricev2"),
  FreeGames: model("freegames"),
  Franchise: {
    findById: () => ({
      lean: async () => {
        check("franchises");
        return io.input.franchise ?? null;
      },
    }),
  },
  AchievementSet: model("achievementsets"),
  Igdb: model("igdbs"),
}));
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      command: async () => {
        check("mongoPing");
        return { ok: 1 };
      },
      collection: (name: string) => ({
        ...model(name),
        find: () => ({
          toArray: async () => {
            check(name);
            return io.input.rows?.[name] ?? [];
          },
          sort: () => ({
            toArray: async () => {
              check(name);
              return io.input.rows?.[name] ?? [];
            },
          }),
        }),
      }),
    },
  },
}));
vi.mock("../src/clients/redis.js", () => ({
  default: {
    ping: async () => {
      check("redisPing");
      return "PONG";
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async () => io.input.cached ?? null,
    set: async (key: string, value: string, mode: string, ttl: number) => {
      io.writes.push({ key, value: JSON.parse(value), mode, ttl });
    },
  },
}));
afterEach(() => vi.useRealTimers());

it("compares public system, statistics and discovery responses with Node", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  const app = new Hono();
  app.use("*", v1Context());
  app.use("*", responseEtag);
  app.use("*", v1CachePolicy());
  for (const routes of [stats, system, awards, franchises])
    app.route("/v1", routes);
  app.onError((e, c) =>
    problemResponse(
      c,
      e instanceof ProblemError
        ? e
        : new ProblemError({
            status: 500,
            code: "INTERNAL_ERROR",
            detail:
              "The API could not complete the request. Retry later and include the request ID when contacting support.",
          }),
    ),
  );
  const cases: unknown[] = [];
  const record = async (name: string, path: string, input: Input = {}) => {
    io.input = input;
    io.pipelines = [];
    io.countFilters = [];
    io.writes = [];
    const request = { method: "GET", path };
    const reply = await app.request(path, {
      headers: {
        "x-egdata-key-id": "key_oracle",
        "x-egdata-key-tier": "free",
        "x-request-id": "req_node_oracle",
      },
    });
    const response = await captureResponse(reply);
    if (name === "openapi")
      response.body = {
        sha256: createHash("sha256")
          .update(JSON.stringify(response.body))
          .digest("hex"),
      };
    cases.push({
      name,
      request,
      input,
      pipelines: io.pipelines,
      counts: io.countFilters,
      writes: io.writes,
      response,
    });
  };
  for (const failure of [undefined, "redisPing", "mongoPing"])
    await record(`health-${failure ?? "ok"}`, "/v1/health", { failure });
  await record("health-query", "/v1/health?unknown=1");
  await record("openapi", "/v1/open-api.json");
  await record("openapi-query", "/v1/open-api.json?unknown=1");
  const counts = {
    offers: 37,
    items: 29,
    tags: 6,
    assets: 10,
    pricev2: 98,
    changelogs_v2: 17,
    sandboxes: 7,
    products: 2,
    freegames: 4,
  };
  await record("stats-counts", "/v1/stats", { counts });
  await record("stats-partial-failure", "/v1/stats", {
    counts,
    failure: "items",
  });
  await record("stats-cached", "/v1/stats", {
    cached: JSON.stringify({ offers: 1 }),
  });
  for (const field of ["releases", "creations"])
    for (const period of ["monthly", "yearly"]) {
      const row = {
        year: 2024,
        [field]: 7,
        ...(period === "monthly" ? { month: 2 } : {}),
      };
      await record(`${field}-${period}`, `/v1/stats/${field}/${period}`, {
        aggregate: [row],
      });
    }
  await record("stats-chart-failure", "/v1/stats/releases/monthly", {
    failure: "offers",
  });
  await record("homepage-euro", "/v1/stats/homepage?country=DE", { counts });
  await record("homepage-invalid", "/v1/stats/homepage?country=ZZ");
  await record("franchise-empty", "/v1/franchises/series", {
    franchise: { _id: "series", name: "A series", offers: [] },
  });
  await record("franchise-missing", "/v1/franchises/missing");
  await record("franchise-populated", "/v1/franchises/series?country=DE", {
    franchise: {
      _id: "series",
      name: "A series",
      offers: ["game"],
      lastUpdated: "2025-03-20T12:00:00Z",
    },
    rows: {
      offers: [
        {
          id: "game",
          namespace: "ns",
          title: "A game",
          releaseDate: "2024-02-02T12:00:00Z",
          offerType: "BASE_GAME",
        },
      ],
      pricev2: [
        {
          offerId: "game",
          price: {
            discountPrice: 1500,
            originalPrice: 2000,
            currencyCode: "EUR",
          },
        },
      ],
      achievementsets: [{ achievements: [{ xp: "10" }, { xp: 5 }] }],
      igdbs: [
        { igdbId: 1, timeToBeat: { hastily: "31", normally: 65 } },
        { igdbId: 1, timeToBeat: { hastily: 90 } },
      ],
    },
  });
  await record("awards-populated", "/v1/game-awards", {
    rows: {
      "storefront-modules": [
        {
          title: " Awards ",
          moduleIndex: 1,
          moduleType: "games",
          offers: [{ id: "game" }],
        },
      ],
      offers: [
        {
          id: "game",
          namespace: "ns",
          title: "A game",
          offerType: "BASE_GAME",
        },
      ],
    },
  });
  await record("awards-empty", "/v1/game-awards?country=DE");
  await record("awards-localized", "/v1/game-awards?locale=es-ES", {
    rows: {
      "storefront-modules": [
        { title: " 2025 ", offers: [{ id: "game" }, { id: "missing" }] },
      ],
      offers: [
        {
          id: "game",
          namespace: "ns",
          title: "Game",
          customAttributes: [{ key: "quality", value: "hd", type: "STRING" }],
        },
      ],
      egs_localizations: [
        {
          entityType: "offer",
          entityId: "ns:game",
          locale: "es-ES",
          source: "epic",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          data: { title: "Juego", description: "Un juego" },
        },
      ],
    },
  });
  const series = { _id: "series", name: "Fixture", offers: ["one", "two"] };
  const gameRows = [
    { id: "one", namespace: "ns", title: "One", releaseDate: "2020-01-01" },
    { id: "two", namespace: "ns2", title: "Two" },
  ];
  for (const [name, path] of [
    ["unknown", "/v1/franchises/series?x=1"],
    ["blank", "/v1/franchises/%20"],
    ["limit", "/v1/franchises/series?limit=-1"],
    ["country", "/v1/franchises/series?country=XX"],
    ["cursor", "/v1/franchises/series?cursor=bad"],
    ["awards-country", "/v1/game-awards?country=XX"],
    ["awards-unknown", "/v1/game-awards?x=1"],
  ])
    await record(name + "-validation", path, { franchise: series });
  const binding = {
    operation: "franchises.detail",
    country: "US",
    locale: "en-US",
    filters: { slug: "series" },
    ordering: "releaseDate:desc,id:asc",
    limit: 1,
  };
  await record(
    "franchise-legacy-cursor-tuple",
    "/v1/franchises/series?limit=1&cursor=" +
      encodeURIComponent(encodeCursor(binding, ["old"])),
    { franchise: series },
  );
  for (const failure of [
    "franchises",
    "offers",
    "offers.projection",
    "pricev2",
    "egs_localizations",
    "achievementsets",
    "igdbs",
  ])
    await record(
      "franchise-dependency-" + failure,
      "/v1/franchises/series?locale=es-ES",
      { franchise: series, rows: { offers: gameRows }, failure },
    );
  await record("franchise-partial", "/v1/franchises/series", {
    franchise: { _id: null, id: "fallback" },
    rows: {},
  });
  await record("franchise-historical-rows", "/v1/franchises/series?limit=1", {
    franchise: series,
    rows: {
      offers: [{ id: 5 }, {}],
      achievementsets: [{ achievements: null }],
      igdbs: [
        { igdbId: 4, timeToBeat: {} },
        { igdbId: "", timeToBeat: {} },
        {},
      ],
    },
  });
  await record("franchise-null-sort-id", "/v1/franchises/series?limit=1", {
    franchise: series,
    rows: { offers: [{ id: null }, {}] },
  });
  const modules = [
    { offers: [{ id: "one" }, { id: "one" }, { id: "two" }], title: 2025 },
    { offers: null },
    {},
    { offers: [] },
  ];
  for (const failure of [
    "storefront-modules",
    "offers",
    "pricev2",
    "egs_localizations",
  ])
    await record(
      "awards-dependency-" + failure,
      "/v1/game-awards?locale=es-ES",
      { rows: { "storefront-modules": modules, offers: gameRows }, failure },
    );
  await record("awards-empty-price-failure", "/v1/game-awards", {
    failure: "pricev2",
  });
  await record("awards-historical-modules", "/v1/game-awards", {
    rows: { "storefront-modules": modules, offers: gameRows },
  });
  await record("awards-invalid-module", "/v1/game-awards", {
    rows: { "storefront-modules": [{ offers: 42 }] },
  });
  await record("awards-null-reference", "/v1/game-awards", {
    rows: { "storefront-modules": [{ offers: [null] }] },
  });
  for (const [label, metadata] of [
    ["missing", { source: "fixture" }],
    ["null", { source: null, fetchedAt: null, sourceUpdatedAt: false }],
    [
      "historical",
      { source: "fixture", fetchedAt: 42, sourceUpdatedAt: "old" },
    ],
  ] satisfies Array<[string, Row]>) {
    const rows = {
      offers: gameRows,
      egs_localizations: [
        {},
        { entityId: "ns:one", data: { title: "Local" }, ...metadata },
      ],
      "storefront-modules": modules,
    };
    await record(
      "franchise-localization-" + label,
      "/v1/franchises/series?locale=es-ES",
      { franchise: series, rows },
    );
    await record(
      "award-localization-" + label,
      "/v1/game-awards?locale=es-ES",
      { rows },
    );
  }
  await record(
    "award-missing-localization-identity",
    "/v1/game-awards?locale=es-ES",
    {
      rows: {
        "storefront-modules": [{ offers: [{ id: "one" }] }],
        offers: [{ id: "one" }],
      },
    },
  );
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("V1_CURSOR_SECRET", "");
  vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
  try {
    await record(
      "franchise-unconfigured-cursor",
      "/v1/franchises/series?limit=1",
      { franchise: series, rows: { offers: gameRows }, noCursorSecret: true },
    );
  } finally {
    vi.unstubAllEnvs();
  }
  assertOracle("system-http-node", cases);
});
