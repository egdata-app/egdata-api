import { Hono } from "hono";
import { BSON, Decimal128, Long, ObjectId } from "mongodb";
import { it, vi, expect } from "vitest";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";

const r = createReadRecorder();
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (name: string) => {
        const source = r.collection(name);
        if (name !== "reviews") return source;
        // The application's MongoClient uses the driver default ignoreUndefined=false.
        // Anonymous review filters therefore send {$ne:null} to Mongo.
        const wire = (q: object) =>
          BSON.deserialize(BSON.serialize(q, { ignoreUndefined: false }));
        return {
          ...source,
          find: (q: object, opts: Record<string, unknown>) =>
            source.find(wire(q), opts),
          countDocuments: (q: object) => source.countDocuments(wire(q)),
        };
      },
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({ default: r.cache }));
vi.mock("../src/clients/discord.js", () => ({ discord: {} }));
vi.mock("../src/clients/telegram.js", () => ({ telegramBotService: {} }));
vi.mock("../src/clients/redis.js", () => ({ default: {} }));
vi.mock("../src/utils/auth.js", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

it("executes the changelog, stats, and optional Epic review authentication against synthetic services", async () => {
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route(
    "/offers/:id",
    (await import("../src/routes/offers/data.js")).default,
  );
  app.route(
    "/offers/:id",
    (await import("../src/routes/offers/reviews.js")).default,
  );
  let active = true;
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    expect(url).toBe("https://api.epicgames.dev/epic/oauth/v2/tokenInfo");
    expect(options.method).toBe("POST");
    const token = (options.body as URLSearchParams).get("token");
    r.service(
      { method: "epicTokenInfo", token },
      active ? "fixture-reviewer" : null,
    );
    return Response.json({ active, account_id: "fixture-reviewer" });
  });
  try {
    const cases: Awaited<ReturnType<typeof r.record>>[] = [];
    type Reads = Parameters<typeof r.record>[4];
    const get = async (
      name: string,
      path: string,
      status: number,
      reads: Reads = [],
      hit: unknown = null,
      headers?: Record<string, string>,
    ) => {
      cases.push(
        await r.record(
          app,
          "legacy-offer-history-" + name,
          { method: "GET", path: "/offers/game/" + path, headers },
          status,
          reads,
          hit,
        ),
      );
    };
    const date = new Date("2025-04-16T12:00:00Z");
    const entry = {
      _id: new ObjectId("65ba00000000000000000010"),
      timestamp: date,
      metadata: {
        contextId: "item",
        changes: [
          { field: "title", changeType: "update" },
          { field: "title", changeType: "insert" },
        ],
      },
      document: { id: "item" },
    };
    const reads: Reads = [
      ["offers", "one", { id: "game", items: [{ id: "item" }] }],
      ["offersubitems", "many", [{ subItems: [{ id: "subitem" }] }]],
      ["items", "many", [{ id: "item" }, { id: "linked" }]],
      ["assets", "many", [{ artifactId: "asset" }]],
      ["changelogs_v2", "count", 5],
      ["changelogs_v2", "aggregate", [entry]],
    ];
    await get(
      "changelog",
      "changelog?page=2&limit=2junk&query=blue&type=update&field=title",
      200,
      reads,
    );
    await get("changelog-no-offer", "changelog", 404, [
      ["offers", "one", null],
    ]);
    await get("changelog-hit", "changelog?query=&type=", 200, [], {
      elements: ["cached"],
    });
    await get("stats-missing", "changelog/stats?from=2020", 200);
    await get("stats-invalid", "changelog/stats?from=no&to=2025", 200);
    const stats =
      "changelog/stats?from=2025-04-01&to=2025-05-01T15:30:00%2B02:00";
    await get("stats", stats, 200, [
      [
        "changelogs_v2",
        "many",
        [
          entry,
          {
            ...entry,
            metadata: { changes: [{ field: "date", changeType: "update" }] },
          },
        ],
      ],
    ]);
    await get("stats-hit", stats, 200, [], { title: 2, date: 1 });
    await get("stats-invalid-row", stats, 500, [
      ["changelogs_v2", "many", [{ timestamp: "not a BSON date" }]],
    ]);
    const nativeId = new ObjectId("65de00000000000000000021");
    const longId = Long.fromString("9007199254741019");
    const decimalId = Decimal128.fromString("14.5");
    await get("changelog-typed-references", "changelog", 200, [
      [
        "offers",
        "one",
        { id: "game", items: [{ id: nativeId }, { id: longId }, {}] },
      ],
      [
        "offersubitems",
        "many",
        [{ subItems: [{ id: decimalId }, { id: false }] }],
      ],
      ["items", "many", [{ id: nativeId }, { id: longId }, {}]],
      ["assets", "many", [{ artifactId: decimalId }, {}]],
      ["changelogs_v2", "count", 0],
      ["changelogs_v2", "aggregate", []],
    ]);
    await get("changelog-null-reference", "changelog", 500, [
      ["offers", "one", { id: "game", items: [null] }],
      ["offersubitems", "many", []],
    ]);
    await get("changelog-broken-subitems", "changelog", 500, [
      ["offers", "one", { id: "game", items: [] }],
      ["offersubitems", "many", [{}]],
    ]);
    await get("stats-null-change", stats, 500, [
      ["changelogs_v2", "many", [{ ...entry, metadata: { changes: [null] } }]],
    ]);
    await get(
      "stats-legacy-calendar",
      "changelog/stats?from=12%2F31%2F2024%20GMT&to=2025-02-29",
      200,
      [["changelogs_v2", "many", []]],
    );
    await get(
      "stats-inverted-bounds",
      "changelog/stats?from=2026&to=2024",
      200,
      [["changelogs_v2", "many", []]],
    );
    await get("stats-sparse-cache", stats, 200, [], [null, false, 2]);
    await get("stats-native-count-keys", stats, 200, [
      [
        "changelogs_v2",
        "many",
        [
          {
            ...entry,
            metadata: {
              changes: [
                { changeType: decimalId, field: longId },
                { changeType: true, field: [1, decimalId] },
                { field: null },
                {},
              ],
            },
          },
        ],
      ],
    ]);
    const reviewer = { accountId: "fixture-reviewer", displayName: "Fixture" };
    const own = { id: "game", userId: "fixture-reviewer", rating: 5 },
      other = { id: "game", userId: "fixture-other", rating: 4 };
    const token =
      [
        { alg: "HS256", typ: "JWT" },
        { appid: "fixture-app", sub: "fixture-subject" },
      ]
        .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
        .join(".") + ".fixture";
    const unsigned: Reads = [
      ["reviews", "many", [other]],
      ["epic", "many", []],
      ["reviews", "count", 19],
    ];
    await get(
      "reviews-anonymous",
      "reviews?limit=99&page=2&verified=false",
      200,
      unsigned,
    );
    await get(
      "reviews-invalid-token",
      "reviews?verified=other",
      200,
      unsigned,
      null,
      { authorization: "Bearer invalid" },
    );
    await get(
      "reviews-verified",
      "reviews?verified=true",
      200,
      [
        ["reviews", "many", [other]],
        ["reviews", "one", own],
        ["epic", "many", [reviewer]],
        ["reviews", "count", 7],
      ],
      null,
      { authorization: "Bearer " + token },
    );
    await get(
      "reviews-cookie-no-review",
      "reviews",
      200,
      [
        ["reviews", "many", []],
        ["reviews", "one", null],
        ["epic", "many", []],
        ["reviews", "count", 0],
      ],
      null,
      { cookie: "EPIC_AUTH=" + token },
    );
    active = false;
    await get("reviews-inactive", "reviews", 200, unsigned, null, {
      authorization: token,
    });
    assertOracle("legacy-offer-history-http-node", cases);
  } finally {
    vi.unstubAllGlobals();
  }
});
