import {
  BSON,
  Binary,
  BSONSymbol,
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
} from "mongodb";
import { expect, it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import builds from "../src/v1/routes/builds.js";
import catalog from "../src/v1/routes/catalog.js";
import items from "../src/v1/routes/items.js";
import { serializeItem } from "../src/v1/serialization.js";
import sandboxes from "../src/v1/routes/sandboxes.js";

it("records historical item attributes from every versioned projection", async () => {
  const { record, cases } = recordMongoReads(items, catalog, builds, sandboxes);
  const bsonId = new ObjectId("507f1f77bcf86cd799439011");
  const build = {
    _id: bsonId,
    appName: "game",
    namespace: "ns",
    buildVersion: "1",
    labelName: "Live-Windows",
    hash: "test-hash",
  };
  const sandbox = { _id: "ns" };
  const date = new Date("2026-01-01Z");
  const historical = Object.fromEntries([
    ["__proto__", { value: 5 }],
    ["__v", 3],
    ["id", 5],
    ["own", { __v: 2, id: 7, value: Decimal128.fromString("349.8") }],
  ]);
  const casesByInput = {
    sparse: [
      { key: 3, type: 77 },
      { key: "a", type: false, value: null },
      { key: [], type: { id: 4 }, value: historical },
      { key: 0, value: "ignored" },
      { key: "__proto__", value: "ignored" },
      { key: "constructor", type: ["A"], value: "kept" },
      { key: "a", type: true },
      9,
      "old",
    ],
    map: historical,
    fallback: [
      { key: "ignored", __v: 7, value: { id: 5, updatedAt: date } },
      null,
      8,
    ],
    native: [
      {
        key: Decimal128.fromString("9.5"),
        value: Decimal128.fromString("2.5"),
      },
      { key: bsonId, value: new Binary(Buffer.from([9, 4, 2])) },
      { key: true, value: Long.fromString("9007199254740993") },
      { key: { id: 7 }, value: { id: 7, __v: 4, date } },
    ],
    "coercion-error": [
      { key: [{ toString: "old" }], value: { id: 7, __v: 4 } },
    ],
    "native-fallback": [
      { key: bsonId, value: Decimal128.fromString("7.5") },
      null,
    ],
    null: null,
  };
  for (const [label, customAttributes] of Object.entries(casesByInput)) {
    const item = {
      id: "i",
      namespace: "ns",
      releaseInfo: [{ appId: "game" }],
      customAttributes,
    };
    const seed = {
      "items.one": item,
      "items.many": [item],
      "sandboxes.one": sandbox,
      "builds.one": build,
      "builds.many": [build],
    };
    const body = (await record(
      `item attributes ${label} detail`,
      "/v1/items/i",
      200,
      seed,
    )) as { data: { customAttributes: unknown } };
    if (label === "sparse")
      expect(body.data.customAttributes).toMatchObject({
        3: { type: 77 },
        constructor: { type: ["A"], value: "kept" },
        a: { type: true },
      });
    if (label === "fallback")
      expect(body.data.customAttributes).toEqual([
        {
          key: "ignored",
          value: { id: "5", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
        null,
        8,
      ]);
    for (const [name, path, extra] of [
      ["list", "/v1/items", {}],
      [
        "offer",
        "/v1/items-from-offer/offer",
        { "offers.one": { id: "offer", items: [{ id: "i" }] } },
      ],
      ["sandbox list", "/v1/sandboxes/ns/items", {}],
      ["sandbox base", "/v1/sandboxes/ns/base-game", {}],
      ["build items", `/v1/builds/${bsonId}/items`, {}],
      ["build list", "/v1/builds", {}],
    ] as const) {
      await record(`item attributes ${label} ${name}`, path, 200, {
        ...seed,
        ...extra,
      });
    }
    await record(
      `item attributes ${label} bulk`,
      "/v1/items/bulk",
      200,
      seed,
      undefined,
      false,
      {
        rawBody: JSON.stringify({ items: ["i"] }),
        contentType: "application/json",
      },
    );
  }
  assertOracle("item-attributes-http-node", cases);
});

// Keep the BSON wire types in the fixture. The Node driver promotes small Long values
// and Symbols to primitives before the canonical serializer sees their keys or types.
it("compares native stored BSON bytes with Node driver values", () => {
  const inputs = {
    "numeric keys": [
      { key: new Int32(0), value: 1 },
      { key: new Int32(-2), type: false },
      { key: new Double(2.75), type: null, value: true },
      { key: new Double(0), value: "omitted" },
      { key: new Double(NaN), value: "omitted" },
      { key: Long.fromNumber(0), type: 8, value: "omitted" },
      {
        key: Long.fromString("9007199254740999"),
        type: Long.fromNumber(2),
        value: "long",
      },
      { key: null, type: "ignored" },
      { key: new BSONSymbol(""), value: "omitted" },
    ],
    "null fallback": [
      {
        key: "a",
        __v: 1,
        value: { id: 6, cost: Decimal128.fromString("1.25") },
      },
      null,
    ],
    "raw map": { id: 6, __v: 5, native: Decimal128.fromString("3.2") },
    "object coercion failure": [
      { key: { toString: "previous value" }, value: { id: 7, __v: 5 } },
    ],
    "array coercion failure": [
      { key: [{ toString: false }], value: { id: 4 } },
    ],
  };
  const cases = Object.entries(inputs).map(([name, customAttributes]) => {
    const bytes = BSON.serialize({
      id: "stored",
      creationDate: new Date("2026-01-01Z"),
      lastModifiedDate: "2025-06",
      releaseDate: null,
      customAttributes,
    });
    return {
      name,
      bsonHex: Buffer.from(bytes).toString("hex"),
      item: serializeItem(BSON.deserialize(bytes)),
    };
  });
  assertOracle("item-attributes-bson-node", cases);
});
