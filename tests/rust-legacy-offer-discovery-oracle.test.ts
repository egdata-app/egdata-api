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
vi.mock("../src/routes/auth.js", () => ({ epic: vi.fn(), epicInfo: vi.fn() }));
vi.mock("../src/clients/epic.js", () => ({ epicStoreClient: {} }));
vi.mock("../src/clients/job-api.js", () => recorder.jobs);
// Isolate this route oracle from the independent rate limiter and media renderer.
vi.mock("../src/middlewares/rate-limit.js", () => ({
  offersListRateLimit: (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../src/routes/offers/og.js", () => ({ default: new Hono() }));

it("records legacy offer discovery HTTP, backing reads and cache behavior", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  try {
    const app = new Hono();
    app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
    app.route(
      "/offers",
      (await import("../src/routes/offers/index.js")).default,
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
          { method: "GET", path: "/offers" + path, headers },
          status,
          reads,
          hit,
          ["server-timing"],
        ),
      );
    };
    const a = {
      _id: "raw-a",
      id: "a",
      namespace: "na",
      title: "Alpha",
      keyImages: [
        { type: "Thumbnail", url: "thumb" },
        { type: "OfferImageTall", url: "tall" },
      ],
      offerType: "BASE_GAME",
      extraField: "full only",
      customAttributes: [],
    };
    const b = {
      id: "b",
      namespace: "nb",
      title: "Beta",
      keyImages: [],
      offerType: "DLC",
    };
    const price = { offerId: "a", region: "US", price: { discount: 330 } };
    const ranked = [
      { offerId: "b", position: 1 },
      { offerId: "a", position: 2 },
    ];
    const set = { sandboxId: "na", totalAchievements: 22 };
    const offers = (v: unknown): Read => ["offers", "many", v];
    const prices = (v: unknown): Read => ["pricev2", "many", v];
    const agg = (v: unknown): Read => ["offers", "aggregate", v];
    const total = (value: number): Read => ["offers", "count", value];
    const pos = (v: unknown): Read => ["game_positions", "many", v];
    const count = (value: number): Read => ["game_positions", "count", value];
    const tag = (v: unknown): Read => ["tags", "one", v];
    const ach = (v: unknown): Read => ["achievementsets", "many", v];
    await get("list", "?limit=5&page=2", 200, [
      offers([a, b]),
      prices([price]),
      total(34),
    ]);
    await get("list-invalid-country", "?country=no", 404);
    await get(
      "list-cache",
      "?expand=FULL&locale=es-es",
      200,
      [],
      { hit: true },
      { cookie: "EGDATA_COUNTRY=ES" },
    );
    await get("event-missing", "/events/abc", 404, [tag(null)]);
    await get("event-card", "/events/abc", 200, [
      tag({ name: "Spring" }),
      agg([{ ...a, price }, b]),
      total(2),
    ]);
    await get("event-expanded", "/events/abc?expand=true", 200, [
      tag({}),
      agg([{ ...a, price }]),
      total(1),
    ]);
    await get("upcoming", "/upcoming?page=2", 200, [
      agg([{ ...a, price }, b]),
      total(9),
    ]);
    await get("upcoming-hit", "/upcoming?limit=99", 200, [], { hit: "up" });
    await get("latest", "/latest-released?limit=1", 200, [
      offers([a]),
      prices([]),
      total(20),
    ]);
    await get("latest-bad-locale", "/latest-released?locale=nope", 400);
    await get("genres-empty", "/genres", 200, [["tags", "many", []]]);
    await get("genres-image", "/genres", 200, [
      ["tags", "many", [{ id: "genre", name: "genre" }]],
      offers([a, b]),
    ]);
    await get("genres-fallback", "/genres?locale=es-es", 200, [
      ["tags", "many", [{ id: "genre" }]],
      offers([b]),
      ["egs_localizations", "many", []],
    ]);
    await get("top-wishlisted", "/top-wishlisted?limit=100", 200, [
      pos(ranked),
      offers([a, b]),
      count(15),
    ]);
    await get("top-sellers-expanded", "/top-sellers?expand=true", 200, [
      pos(ranked),
      offers([a, b]),
      count(7),
    ]);
    await get("top-empty", "/top-sellers?page=2", 200, [pos([]), offers([])]);
    await get("top-cache", "/top-sellers", 200, [], { hit: "ranked" });
    await get("featured-empty", "/featured-discounts", 200, [pos([])]);
    await get("featured", "/featured-discounts", 200, [
      pos(ranked),
      offers([a, b]),
      prices([price]),
    ]);
    await get("featured-expanded", "/featured-discounts?expand=1", 200, [
      pos(ranked),
      offers([b, a]),
      prices([price]),
    ]);
    await get("achievements-empty", "/latest-achievements", 200, [
      offers([]),
      ach([]),
      prices([]),
    ]);
    await get("achievements-full", "/latest-achievements?expand=1", 200, [
      offers([a, b]),
      ach([set]),
      prices([price]),
    ]);
    await get("achievements-partial", "/latest-achievements", 200, [
      offers([a, b]),
      ach([set]),
      prices(new Error("price offline")),
    ]);
    const batch = Array.from({ length: 15 }, (_, i) => ({
      ...a,
      id: "missing" + i,
    }));
    await get("achievements-next-page", "/latest-achievements", 200, [
      offers(batch),
      ach([]),
      prices([]),
      offers([a]),
      ach([set]),
      prices([price]),
    ]);
    assertOracle("legacy-offer-discovery-http-node", cases);
  } finally {
    vi.useRealTimers();
  }
});
