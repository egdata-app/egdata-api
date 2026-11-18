import { Hono } from "hono";
import { Decimal128, ObjectId } from "mongodb";
import { it, vi } from "vitest";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";

const r = createReadRecorder();
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name: string) => r.collection(name) } },
}));
vi.mock("../src/clients/response-cache.js", () => ({ default: r.cache }));
it("compares native legacy feature tags, launcher attributes, references, and failures", async () => {
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route(
    "/offers/:id",
    (await import("../src/routes/offers/data.js")).default,
  );
  const cases: Awaited<ReturnType<typeof r.record>>[] = [];
  type Read = Parameters<typeof r.record>[4];
  const request = { method: "GET", path: "/offers/game/features" };
  const read = async (name: string, status: number, reads: Read) => {
    cases.push(
      await r.record(
        app,
        "legacy standalone features " + name,
        request,
        status,
        reads,
      ),
    );
  };
  const decimal = Decimal128.fromString("1264");
  const oid = new ObjectId("65bc00000000000000000001");
  for (const [name, tags, items, status] of [
    [
      "mixed duplicate ids",
      [{ id: "1264" }, { id: 1264 }, { id: 19847 }, { id: "19847" }],
      [],
      200,
    ],
    [
      "decimal shadows string",
      [{ id: "1264" }, { id: decimal }, { id: [19847] }],
      [],
      200,
    ],
    [
      "native links and sparse tags",
      [{}, 7, { id: null }, { id: "1264" }],
      [
        {
          id: oid,
          customAttributes: {
            ThirdPartyManagedApp: "managed",
            PresenceId: true,
          },
        },
      ],
      200,
    ],
    [
      "overwritten launcher",
      [],
      [
        { customAttributes: [{ key: "isUplay", value: "y" }] },
        {
          customAttributes: {
            isUplay: false,
            ThirdPartyManagedApp: { key: "isUplay" },
          },
        },
      ],
      200,
    ],
    ["null tag", [null], [], 500],
    ["wrong tags", {}, [], 500],
    ["null attribute", [], [{ customAttributes: [null] }], 500],
  ] as const) {
    await read(name, status, [
      ["offers", "one", { id: "game", tags, items: [{ id: oid }, {}] }],
      ["offersubitems", "many", [{ subItems: [{ id: decimal }] }]],
      ["items", "many", items],
    ]);
  }
  await read("missing", 404, [["offers", "one", null]]);
  await read("invalid direct reference", 500, [
    ["offers", "one", { items: [null], tags: [] }],
    ["offersubitems", "many", []],
  ]);
  await read("invalid subitem", 500, [
    ["offers", "one", { items: [], tags: [] }],
    ["offersubitems", "many", [{ subItems: [null] }]],
  ]);
  await read("failed subitems", 500, [
    ["offers", "one", { items: [], tags: [] }],
    ["offersubitems", "many", new Error("unavailable")],
  ]);
  assertOracle("legacy-offer-features-http-node", cases);
});
