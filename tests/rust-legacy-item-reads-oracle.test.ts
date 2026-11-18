import { it, vi } from "vitest";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";

const recorder = createReadRecorder();
vi.mock("../src/clients/job-api.js", () => recorder.jobs);
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

it("records the item APIs at the Node HTTP, Mongo and Redis boundaries", async () => {
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route("/items", (await import("../src/routes/items.js")).default);
  type Inputs = Parameters<typeof recorder.record>;
  const cases: unknown[] = [];
  const run = async (
    name: string,
    path: string,
    status: number,
    reads: Inputs[4],
    options: { post?: string; hit?: unknown; fail?: number } = {},
  ) => {
    const req =
      options.post === undefined
        ? { method: "GET", path: "/items" + path }
        : {
            method: "POST",
            path: "/items" + path,
            rawBody: options.post,
            headers: { "content-type": "application/json" },
          };
    cases.push(
      await recorder.record(
        app,
        name,
        req,
        status,
        reads,
        options.hit,
        [],
        options.fail,
      ),
    );
  };
  const one = (c: string, v: unknown): Inputs[4][number] => [c, "one", v];
  const many = (c: string, v: unknown): Inputs[4][number] => [c, "many", v];
  const item = { id: "i", title: "Item", releaseInfo: [{ appId: "game" }] };
  const offer = {
    id: "game",
    namespace: "ns",
    title: "Original",
    offerType: "BASE_GAME",
    items: [{ id: "i" }],
  };
  const oid = new ObjectId("65ba00000000000000000001");
  for (const [label, attributes, status] of [
    ["missing", undefined, 200],
    ["null", null, 200],
    ["false", false, 200],
    ["zero", 0, 200],
    ["text", "legacy", 200],
    ["object", { A: { value: 12 } }, 200],
    ["malformed", [null], 500],
    [
      "mixed",
      [
        { key: 0, value: "ignored" },
        { key: "__proto__", value: "ignored" },
        { key: 14, type: 3, value: 0 },
        { key: "label", type: false },
        { key: "again", value: 4 },
        { key: "again", value: 8 },
      ],
      200,
    ],
  ] as const) {
    const row = { ...item, customAttributes: attributes };
    await run("detail-attributes-" + label, "/i", status, [one("items", row)]);
    await run(
      "bulk-attributes-" + label,
      "/bulk",
      status,
      [many("items", [row])],
      { post: '{"items":["i"]}' },
    );
  }
  const desired = JSON.stringify({ items: ["i", "j", "missing", "i"] });
  for (const [name, body] of Object.entries({
    none: "null",
    object: "{}",
    wrong: '{"items":{}}',
  })) {
    for (const url of ["/bulk", "/bulk/offers"])
      await run("bad-" + name + url.replaceAll("/", "-"), url, 500, [], {
        post: body,
      });
  }
  for (const [name, body] of Object.entries({
    malformed: "{",
    empty: "",
    bom: "\ufeff" + JSON.stringify({ items: ["i"] }),
    overflow: '{"items":[1e400,"i"]}',
    whitespace: JSON.stringify({ items: ["\ufeff i \ufeff", "\u0085", false] }),
  })) {
    await run("bulk-input-" + name, "/bulk", 200, [many("items", [])], {
      post: body,
    });
    await run(
      "offer-input-" + name,
      "/bulk/offers",
      200,
      name === "malformed" || name === "empty"
        ? []
        : [many("offers", []), many("offersubitems", [])],
      { post: body },
    );
  }
  const emptySub = many("offersubitems", []);
  const translated = {
    entityType: "offer",
    entityId: "ns:game",
    locale: "fr-FR",
    source: "fixture",
    fetchedAt: new Date("2026-11-12T00:00:00Z"),
    data: { title: "Titre", description: "only translated" },
  };
  for (const [name, rows] of Object.entries({
    duplicate: [
      offer,
      { ...offer, title: "Different doc", items: [{ id: "j" }] },
    ],
    missing: [
      { ...offer, id: undefined },
      { ...offer, id: undefined, title: "Second", items: [{ id: "j" }] },
    ],
    rank: [
      { ...offer, title: "first DLC", offerType: "dlc" },
      { ...offer, title: "unknown rank", offerType: [] },
      { ...offer, title: "Prepurchase", prePurchase: true },
      { ...offer, title: "Ready", offerType: ["BASE_GAME"] },
    ],
  })) {
    await run(
      "matched-" + name,
      "/bulk/offers",
      200,
      [many("offers", rows), emptySub],
      { post: desired },
    );
  }
  await run(
    "bulk-translated",
    "/bulk/offers?locale=fr-FR",
    200,
    [
      many("offers", [offer]),
      emptySub,
      many("egs_localizations", [translated]),
    ],
    { post: desired },
  );
  await run(
    "bulk-fallback",
    "/bulk/offers?locale=fr-FR",
    200,
    [many("offers", [offer]), emptySub, many("egs_localizations", [])],
    { post: desired },
  );
  const mixedIds = [oid, 17, "plain", null];
  const mixedOffers = [
    { ...offer, id: oid, title: "First object", items: [{ id: "i" }] },
    {
      ...offer,
      id: new ObjectId(oid),
      title: "Separate object",
      items: [{ id: "j" }],
    },
    {
      ...offer,
      id: oid.toHexString(),
      title: "Text id",
      items: [{ id: "extra" }],
    },
  ];
  for (const locale of ["en-US", "fr-FR"]) {
    const reads: Inputs[4] = [many("offers", mixedOffers), emptySub];
    if (locale === "fr-FR")
      reads.push(
        many("egs_localizations", [
          { ...translated, entityId: "ns:" + oid.toHexString() },
        ]),
      );
    await run(
      "mixed-key-identity-" + locale,
      "/bulk/offers?locale=" + locale,
      200,
      reads,
      { post: JSON.stringify({ items: ["i", "j", "extra"] }) },
    );
  }
  await run("single-native-object-id", "/i/offer?locale=fr-FR", 200, [
    emptySub,
    many("offers", [mixedOffers[0]]),
  ]);
  await run("item-escaped-body-property", "/bulk", 200, [many("items", [])], {
    post: '{"it\\u0065ms":["i"]}',
  });
  await run(
    "bulk-empty-filter",
    "/bulk/offers?locale=invalid_locale_code",
    400,
    [],
    { post: desired },
  );
  await run(
    "item-offer-invalid-locale",
    "/i/offer?locale=invalid_locale_code",
    400,
    [],
  );
  const secondary = mixedIds.map((id) => ({ ...offer, id, title: String(id) }));
  const subs = mixedIds.map((_id, i) => ({
    _id,
    subItems: [{ id: ["i", "j", "extra", "n"][i] }],
  }));
  await run(
    "bulk-subitem-bson-ids",
    "/bulk/offers",
    200,
    [
      many("offers", []),
      many("offersubitems", subs),
      many(
        "offers",
        secondary.map((row) => ({
          ...row,
          id: row.id instanceof ObjectId ? new ObjectId(row.id) : row.id,
        })),
      ),
    ],
    { post: JSON.stringify({ items: ["i", "j", "extra", "n"] }) },
  );
  for (const [name, members, status] of [
    ["null", null, 200],
    ["text", "legacy", 200],
    ["number", 3, 500],
    ["null-entry", [null], 500],
  ] as const) {
    await run(
      "direct-members-" + name,
      "/bulk/offers",
      status,
      [many("offers", [{ ...offer, items: members }]), emptySub],
      { post: desired },
    );
  }
  for (const [name, members, status] of [
    ["missing", undefined, 500],
    ["text", "legacy", 200],
    ["null-entry", [null], 500],
  ] as const) {
    await run(
      "secondary-members-" + name,
      "/bulk/offers",
      status,
      [
        many("offers", []),
        many("offersubitems", [{ _id: "game", subItems: members }]),
        many("offers", [offer]),
      ],
      { post: desired },
    );
  }
  const groups: Inputs[4] = [
    many(
      "offersubitems",
      mixedIds.map((_id) => ({ _id })),
    ),
    many("offers", [offer]),
  ];
  await run("offer-mixed-id-query", "/i/offer", 200, groups);
  for (const [label, docs, status] of [
    ["ready", [{ ...offer, title: "Wrong", prePurchase: "yes" }, offer], 200],
    [
      "none",
      [
        { ...offer, prePurchase: 1 },
        { ...offer, prePurchase: true },
      ],
      404,
    ],
    ["single", [{ ...offer, prePurchase: true }], 200],
  ] as const)
    await run("offer-prepurchase-" + label, "/i/offer", status, [
      emptySub,
      many("offers", docs),
    ]);
  for (const [name, data] of [
    ["translated", [translated]],
    ["fallback", []],
  ] as const)
    await run("offer-" + name, "/i/offer?locale=fr-FR", 200, [
      ...groups,
      many("egs_localizations", data),
    ]);
  await run("offer-cache-false", "/i/offer", 200, [], { hit: false });
  await run("changelog-cache-false", "/i/changelog", 200, [], { hit: false });
  const changeReads: Inputs[4] = [
    one("items", item),
    many("assets", [{ artifactId: "app" }, { artifactId: 42 }, {}]),
    many("builds", [{ _id: oid }, { _id: 42 }, { _id: { legacy: true } }]),
    ["changelogs_v2", "aggregate", [{ timestamp: new Date("2026-10-01Z") }]],
  ];
  await run(
    "changelog-typed-ids",
    "/i/changelog?page=2&limit=1",
    200,
    changeReads,
  );
  for (const build of [{}, { _id: null }])
    await run(
      "changelog-bad-build-" + (build._id === null ? "null" : "missing"),
      "/i/changelog",
      500,
      [...changeReads.slice(0, 2), many("builds", [build])],
    );
  await run("builds-app-types", "/i/builds", 200, [
    one("items", { releaseInfo: [{ appId: 17 }, { appId: oid }, {}] }),
    many("builds", []),
  ]);
  const build = {
    _id: oid,
    appName: "game",
    buildVersion: "1",
    labelName: "Live-Windows",
    hash: "sha",
  };
  const joins: Inputs[4] = [
    one("items", item),
    many("builds", [build, { ...build, appName: "game-b" }]),
    one("assets", null),
    one("assets", { downloadSizeBytes: 30 }),
  ];
  await run("item-builds-concurrent-assets", "/i/builds", 200, joins);
  await run("item-builds-concurrent-asset-failure", "/i/builds", 500, joins, {
    fail: 2,
  });
  await run("item-builds-missing-label", "/i/builds", 500, [
    one("items", item),
    many("builds", [{ _id: oid, appName: "game" }]),
  ]);
  for (const [name, value] of [
    ["missing", undefined],
    ["object", {}],
    ["null-entry", [null]],
  ] as const)
    await run("builds-release-" + name, "/i/builds", 500, [
      one("items", { releaseInfo: value }),
    ]);
  for (const [label, path, reads, post] of [
    ["item-detail", "/i", [one("items", item)]],
    ["item-assets", "/i/assets", [many("assets", [])]],
    ["list", "?page=2&limit=3", [many("items", [item]), ["items", "count", 5]]],
    [
      "related",
      "/i/offer?locale=fr-FR",
      [...groups, many("egs_localizations", [translated])],
    ],
    ["changes", "/i/changelog", changeReads],
    [
      "related-bulk",
      "/bulk/offers?locale=fr-FR",
      [
        many("offers", []),
        many("offersubitems", [{ _id: "game", subItems: [{ id: "i" }] }]),
        many("offers", [offer]),
        many("egs_localizations", [translated]),
      ],
      desired,
    ],
  ] as [string, string, Inputs[4], string?][]) {
    const hasCache = label === "related" || label === "changes";
    for (let i = 0; i < reads.length + (hasCache ? 2 : 0); i++)
      await run(label + "-failure-" + i, path, 500, reads, { post, fail: i });
  }
  assertOracle("legacy-item-reads-edges-http-node", cases);
});
