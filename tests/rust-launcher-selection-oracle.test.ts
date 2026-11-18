import { ObjectId } from "mongodb";
import { it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import builds from "../src/v1/routes/builds.js";

it("records launcher candidate and parent selection through the registered API", async () => {
  const { cases, record } = recordMongoReads(builds);
  const path = "/v1/builds/resolve-launcher-records";
  const candidate = {
    requestId: "one",
    buildAppName: "game",
    buildVersion: "",
    platform: "Windows",
  };
  const item = {
    id: "addon",
    namespace: "ns",
    entitlementType: "DURABLE",
    categories: ["DLC"],
  };
  const parent = { id: "base", namespace: "ns", entitlementType: "EXECUTABLE" };
  const asset = { itemId: "addon", artifactId: "DLC", platform: "Windows" };
  const parentAsset = {
    itemId: "base",
    artifactId: "Base",
    platform: "Windows",
  };
  const baseOffer = {
    id: "offer",
    offerType: "BASE_GAME",
    items: [{ id: "addon" }, { id: "base" }],
  };
  const post = (rawBody: string, contentType = "application/json") => ({
    rawBody,
    contentType,
  });
  const run = (
    name: string,
    items: unknown[],
    assets: unknown[],
    offers: unknown[],
    sub: unknown[] = [],
    candidates: unknown[] = [candidate],
    status = 200,
  ) => {
    return record(
      name,
      path,
      status,
      {
        __sequence: {
          "items.many": items,
          "assets.many": assets,
          "offers.many": offers,
          "offersubitems.many": sub,
        },
      },
      undefined,
      false,
      post(JSON.stringify({ candidates })),
    );
  };
  for (const [name, items, assets, offers, sub] of [
    ["item", ["FAIL"], [], [], []],
    ["asset", [[item]], ["FAIL"], [], []],
    ["direct", [[item]], [[asset]], ["FAIL"], []],
    ["subitems", [[item]], [[asset]], [[]], ["FAIL"]],
    ["indirect", [[item]], [[asset]], [[], "FAIL"], [[{ _id: "offer" }]]],
    ["parent", [[item], "FAIL"], [[asset]], [[baseOffer]], []],
    ["parent-asset", [[item], [parent]], [[asset], "FAIL"], [[baseOffer]], []],
  ] as const)
    await run(
      `failure-${name}`,
      [...items],
      [...assets],
      [...offers],
      [...sub],
      [candidate],
      500,
    );
  await run("parent-missing", [[item], []], [[asset]], [[baseOffer]]);
  await run(
    "parent-windows-missing",
    [[item], [parent]],
    [[asset], []],
    [[baseOffer]],
  );
  await run(
    "parent-two-executables",
    [[item], [parent, { ...parent, id: "second" }]],
    [[asset]],
    [[baseOffer]],
  );
  await run(
    "parent-two-durable",
    [[item], [{ ...parent, entitlementType: "DURABLE" }, { id: "second" }]],
    [[asset]],
    [[baseOffer]],
  );
  await run(
    "parent-unique-durable",
    [[item], [{ ...parent, entitlementType: "DURABLE" }]],
    [[asset], [parentAsset]],
    [[baseOffer]],
  );
  await run(
    "parent-two-windows",
    [[item], [parent]],
    [[asset], [parentAsset, parentAsset]],
    [[baseOffer]],
  );
  await run(
    "duplicate-offer-source",
    [[item], [item, parent]],
    [[asset], [parentAsset]],
    [[{ ...baseOffer, offerType: "DLC" }], [baseOffer]],
    [[{ _id: new ObjectId("640000000000000000000099") }]],
  );
  await run(
    "parent-number-and-string-ids",
    [[{ ...item, id: 7 }], [{ ...parent, id: "7" }]],
    [[asset], [parentAsset]],
    [
      [
        {
          ...baseOffer,
          items: [{ id: 7 }, { id: "7" }, { id: null }, { id: false }],
        },
      ],
    ],
  );
  const oid = new ObjectId("640000000000000000000022");
  await run(
    "parent-separate-bson-ids",
    [
      [{ ...item, id: oid }],
      [{ ...parent, id: new ObjectId(oid.toHexString()) }],
    ],
    [[asset], [parentAsset]],
    [[{ ...baseOffer, items: [{ id: oid }] }]],
  );
  await run(
    "asset-without-string-hint",
    [[item]],
    [[{ ...asset, artifactId: 7 }]],
    [],
    [],
    [
      {
        ...candidate,
        catalogHint: {
          artifactId: "7",
          catalogItemId: "addon",
          catalogNamespace: "ns",
        },
      },
    ],
  );
  await run(
    "trim-js-whitespace",
    [
      [
        {
          ...parent,
          customAttributes: [
            { key: "", value: "ignored" },
            { key: "FolderName", value: "\uFEFF Folder \uFEFF" },
            { key: "IgnoredProcessNames", value: "\uFEFF app , helper \uFEFF" },
          ],
        },
      ],
    ],
    [[parentAsset]],
    [],
    [],
    [
      {
        ...candidate,
        requestId: "\uFEFFone\uFEFF",
        buildAppName: "\uFEFFgame\uFEFF",
      },
    ],
  );
  await run(
    "keep-non-js-whitespace",
    [],
    [],
    [],
    [],
    [{ ...candidate, requestId: "\u0085", buildAppName: "\u0085app\u0085" }],
  );
  await run(
    "batch-stops-on-service-failure",
    [[], "FAIL"],
    [],
    [],
    [],
    [
      candidate,
      { ...candidate, requestId: "two" },
      { ...candidate, requestId: "three" },
    ],
    500,
  );
  for (const [name, body, type, pathSuffix, status] of [
    ["malformed", "{", "application/json", "", 400],
    ["non-json", "{}", "text/plain", "", 415],
    ["strict-query", "{}", "application/json", "?extra=x", 400],
    [
      "long-candidates-string",
      JSON.stringify({ candidates: "x".repeat(101) }),
      "application/json",
      "",
      400,
    ],
    [
      "oversized-request-id-array",
      JSON.stringify({
        candidates: [{ ...candidate, requestId: Array(129).fill("x") }],
      }),
      "application/json",
      "",
      400,
    ],
    [
      "strict-keys",
      JSON.stringify({
        candidates: [{ ...candidate, second: true, third: null }],
      }),
      "application/json",
      "",
      400,
    ],
  ] as const)
    await record(
      name,
      path + pathSuffix,
      status,
      {},
      undefined,
      false,
      post(body, type),
    );
  assertOracle("launcher-selection-http-node", cases);
});
