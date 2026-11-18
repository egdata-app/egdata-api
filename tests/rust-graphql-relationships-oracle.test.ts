import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

type Doc = Record<string, any>;
const driver = vi.hoisted(() => {
  const trace: Doc[] = [];
  const replies = new Map<string, unknown[]>();
  const record = (call: Doc, fallback: unknown) => {
    const queue = replies.get(`${call.collection ?? "cache"}.${call.method}`);
    const result = queue?.length ? queue.shift() : fallback;
    trace.push({ call, result });
    return result;
  };
  function collection(name: string, native = false) {
    const read = (
      method: string,
      filter: Doc = {},
      projection?: Doc,
      initial?: Doc,
    ) => {
      const options: Doc = { ...initial };
      if (projection)
        Object.assign(options, native ? projection : { projection });
      const run = async () =>
        record(
          { collection: name, method, filter, options },
          method === "one" ? null : [],
        );
      const cursor = {
        skip(n: number) {
          options.skip = n;
          return cursor;
        },
        limit(n: number) {
          options.limit = n;
          return cursor;
        },
        sort(sort: Doc) {
          options.sort = sort;
          return cursor;
        },
        lean: run,
        toArray: run,
        then(
          resolve: (value: unknown) => void,
          reject: (error: unknown) => void,
        ) {
          return run().then(resolve, reject);
        },
      };
      return cursor;
    };
    return {
      find: read.bind(null, "many"),
      findOne: read.bind(null, "one"),
      countDocuments: async (filter: Doc = {}) =>
        record({ collection: name, method: "count", filter, options: {} }, 0),
    };
  }
  const cache = {
    get: async (key: string) => record({ method: "get", key }, null),
    set: async (key: string, data: string, mode: string, ttl: number) =>
      record({ method: "set", key, value: JSON.parse(data), mode, ttl }, null),
  };
  return { collection, replies, trace, cache };
});
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name: string) => driver.collection(name, true) } },
}));
vi.mock("../src/clients/response-cache.js", () => ({ default: driver.cache }));
vi.mock("../src/models/index.js", () =>
  Object.fromEntries(
    Object.entries({
      Asset: "assets",
      Build: "builds",
      Item: "items",
      Offer: "offers",
      AchievementSet: "achievementsets",
      Sandbox: "sandboxes",
      Namespace: "namespaces",
      PriceEngine: "pricev2",
      Tags: "tags",
      Franchise: "franchises",
    }).map(([model, name]) => [model, driver.collection(name)]),
  ),
);

import itemResolvers from "../src/graphql/resolvers/item.js";
import changes from "../src/graphql/resolvers/changelog.js";
import builds from "../src/graphql/resolvers/build.js";
import sandboxes from "../src/graphql/resolvers/sandbox.js";
import { createLoaders } from "../src/graphql/loaders.js";
import { consola } from "consola";

describe("GraphQL Mongo relationships", () => {
  it("records populated and missing relationships, cache data and Mongo reads from the Node resolvers", async () => {
    const cases: Doc[] = [];
    const norm = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v, (_, item) =>
          item instanceof RegExp
            ? {
                $regularExpression: {
                  pattern: item.source,
                  options: item.flags,
                },
              }
            : item,
        ),
      );
    const run = async (
      name: string,
      module: Doc,
      parentType: string,
      field: string,
      parent: Doc,
      args: Doc,
      replies: Doc = {},
    ) => {
      driver.trace.length = 0;
      driver.replies.clear();
      for (const [key, sequence] of Object.entries(replies))
        driver.replies.set(key, [...sequence]);
      const context = {
        loaders: createLoaders({
          collection: (n: string) => driver.collection(n, true),
        }),
      };
      const expected = await module[parentType][field](
        parent,
        args,
        context,
        {},
      );
      for (const [key, rest] of driver.replies)
        expect(rest, name + " unused " + key).toHaveLength(0);
      cases.push(
        norm({
          name,
          parentType,
          field,
          parent,
          args,
          expected,
          trace: driver.trace,
        }),
      );
    };
    const item = {
      id: "i",
      namespace: "ns",
      title: "Example",
      releaseInfo: [
        { appId: "app", platform: ["Windows", "Mac"] },
        { appId: "extra", platform: ["Linux"] },
      ],
    };
    const primary = {
      id: "o",
      namespace: "ns",
      title: "Game",
      offerType: "BASE_GAME",
      developerDisplayName: "Studio",
      creationDate: "2020-01-01T00:00:00.000Z",
      tags: [{ id: "t", groupName: "platform", name: "Deck" }],
      keyImages: [],
    };
    const asset = {
      artifactId: "app",
      itemId: "i",
      platform: "Windows",
      updatedAt: new Date("2026-01-01"),
    };
    const build = {
      _id: "b",
      appName: "app",
      updatedAt: new Date("2026-01-01"),
    };
    const entry = { _id: "change", metadata: { contextId: "i" } };
    const sets = [
      {
        sandboxId: "ns",
        isBase: true,
        achievements: [{ xp: 100 }, { score: "25" }, {}],
      },
    ];
    const links = { subItems: [{ id: "i" }] };
    await run(
      "associated-offers",
      itemResolvers,
      "Item",
      "offers",
      item,
      { locale: "es" },
      { "offers.many": [[primary]], "egs_localizations.many": [[]] },
    );
    await run(
      "main-offer-preorder",
      itemResolvers,
      "Item",
      "mainOffer",
      item,
      {},
      {
        "offersubitems.many": [[{ _id: "pre" }, { _id: "o" }]],
        "offers.many": [
          [{ ...primary, id: "pre", prePurchase: true }, primary],
        ],
      },
    );
    await run(
      "missing-main-offer",
      itemResolvers,
      "Item",
      "mainOffer",
      item,
      {},
    );
    await run(
      "nested-assets",
      itemResolvers,
      "Item",
      "assets",
      item,
      {},
      { "assets.many": [[asset]] },
    );
    await run(
      "nested-builds",
      itemResolvers,
      "Item",
      "builds",
      { releaseInfo: [...item.releaseInfo, { appId: "app" }] },
      {},
      { "builds.many": [[{ ...build, updatedAt: new Date(0) }, build]] },
    );
    await run(
      "stored-offer",
      changes,
      "Changelog",
      "document",
      { document: primary },
      { locale: "fr" },
    );
    await run(
      "linked-offer",
      changes,
      "Changelog",
      "document",
      { metadata: { contextId: "o", contextType: "offer" } },
      {},
      { "offers.one": [primary] },
    );
    await run(
      "linked-changelog-asset",
      changes,
      "Changelog",
      "document",
      { metadata: { contextType: "asset", contextId: "app" } },
      {},
      { "assets.one": [asset] },
    );
    await run(
      "build-loader-numeric-and-invalid-timestamps",
      itemResolvers,
      "Item",
      "builds",
      { releaseInfo: [{ appId: "app" }] },
      {},
      {
        "builds.many": [
          [
            { appName: "app", updatedAt: null, marker: "initial" },
            { appName: "app", updatedAt: true, marker: "one" },
            { appName: "app", marker: "undated" },
            { appName: "app", updatedAt: 1, marker: "old" },
            { appName: "app", updatedAt: "invalid", marker: "invalid" },
            { appName: "app", updatedAt: 1000, marker: "new" },
            { appName: "app", updatedAt: 500, marker: "older" },
            { updatedAt: 2000, marker: "unrelated" },
          ],
        ],
      },
    );
    await run(
      "unknown-document-type",
      changes,
      "Changelog",
      "document",
      { metadata: { contextType: "tag" } },
      {},
    );
    await run(
      "item-history",
      itemResolvers,
      "Item",
      "changelog",
      item,
      { limit: 0, page: 2 },
      {
        "assets.many": [[asset]],
        "builds.many": [[build]],
        "changelogs_v2.count": [3],
        "changelogs_v2.many": [[entry]],
      },
    );
    await run(
      "offer-history",
      changes,
      "Offer",
      "changelog",
      { id: "o", items: [{ id: "other" }] },
      { limit: 3 },
      {
        "offersubitems.many": [[links]],
        "items.many": [[item]],
        "assets.many": [[asset]],
        "changelogs_v2.count": [2],
        "changelogs_v2.many": [[entry]],
      },
    );
    await run(
      "sandbox-history",
      sandboxes,
      "Sandbox",
      "changelog",
      { _id: "ns" },
      {},
      {
        "offers.many": [[{ ...primary, items: [{ id: "i" }] }]],
        "items.many": [[item]],
        "assets.many": [[asset]],
        "builds.many": [[build]],
        "changelogs_v2.count": [2],
        "changelogs_v2.many": [[entry]],
      },
    );
    await run(
      "sandbox-offers",
      sandboxes,
      "Sandbox",
      "offers",
      { _id: "ns", locale: "fr" },
      {},
      {
        "offers.many": [[primary]],
        "offers.count": [1],
        "egs_localizations.many": [
          [
            {
              entityId: "ns:o",
              entityType: "offer",
              locale: "fr",
              source: "fixture",
              fetchedAt: new Date(0),
              data: { description: "Description française" },
            },
          ],
        ],
      },
    );
    await run(
      "localized-sandbox-base-game",
      sandboxes,
      "Sandbox",
      "baseGame",
      { _id: "ns" },
      { locale: "fr" },
      { "offers.one": [primary], "egs_localizations.many": [[]] },
    );
    await run(
      "sandbox-builds-all-platforms",
      sandboxes,
      "Sandbox",
      "builds",
      { _id: "ns" },
      {},
      { "items.many": [[item]], "builds.many": [[build]], "builds.count": [1] },
    );
    await run(
      "sandbox-assets-filter",
      sandboxes,
      "Sandbox",
      "assets",
      { _id: "ns" },
      { platform: "Windows" },
      { "items.many": [[item]], "assets.many": [[asset]] },
    );
    await run(
      "sandbox-builds-filter",
      sandboxes,
      "Sandbox",
      "builds",
      { _id: "ns" },
      { platform: "Mac,Windows,,", page: 2, limit: 1 },
      { "items.many": [[item]], "builds.many": [[build]], "builds.count": [3] },
    );
    await run(
      "sandbox-stats",
      sandboxes,
      "Sandbox",
      "stats",
      { _id: "ns" },
      {},
      {
        "items.many": [[item]],
        "achievementsets.many": [sets],
        "offers.count": [2],
        "assets.many": [[asset]],
        "builds.count": [3],
      },
    );
    await run(
      "sandbox-primary-offer",
      sandboxes,
      "Sandbox",
      "baseGame",
      { _id: "ns" },
      {},
      { "offers.one": [null, primary] },
    );
    await run(
      "sandbox-primary-item",
      sandboxes,
      "Sandbox",
      "baseGame",
      { _id: "ns" },
      {},
      { "offers.one": [null, null], "items.one": [item] },
    );
    await run(
      "sandbox-achievements",
      sandboxes,
      "Sandbox",
      "achievements",
      { _id: "ns" },
      {},
      { "achievementsets.many": [sets] },
    );
    await run(
      "hub-cache-hit",
      sandboxes,
      "Query",
      "sandboxHub",
      {},
      { id: "ns", offerLimit: 100 },
      { "cache.get": ['{"cached":true}'] },
    );
    await run(
      "hub-missing",
      sandboxes,
      "Query",
      "sandboxHub",
      {},
      { id: "missing" },
    );
    await run(
      "hub-populated",
      sandboxes,
      "Query",
      "sandboxHub",
      {},
      { id: "ns", country: "DE", locale: "es" },
      {
        "sandboxes.one": [{ _id: "ns", ageGatings: { USK: "USK 12" } }],
        "offers.one": [primary],
        "items.many": [[item]],
        "achievementsets.many": [sets],
        "offers.many": [[primary]],
        "pricev2.one": [{ offerId: "o" }],
        "offers.count": [3],
        "assets.many": [[asset]],
        "builds.count": [2],
        "builds.many": [[build]],
        "changelogs_v2.many": [[entry]],
        "tags.many": [[{ id: "t" }]],
      },
    );
    await run(
      "build-files-filter",
      builds,
      "Build",
      "files",
      { hash: "manifest" },
      { extension: "exe,dll", q: "game", sort: "fileSize", dir: "desc" },
      { "files.many": [[{ fileName: "game.exe" }]], "files.count": [1] },
    );
    await run(
      "build-install-options",
      builds,
      "Build",
      "installOptions",
      { hash: "manifest" },
      {},
      {
        "files.many": [
          [
            { installTags: ["en", "fr"], fileSize: 24 },
            { installTags: ["en"], fileSize: 2 },
          ],
        ],
      },
    );
    driver.trace.length = 0;
    driver.replies.clear();
    driver.replies.set("assets.many", [
      [
        { ...asset, itemId: "a" },
        { ...asset, itemId: "b" },
      ],
    ]);
    const ids = ["b", "missing", "a", "a"];
    const loaders = createLoaders({
      collection: (n: string) => driver.collection(n, true),
    });
    const resolveAssets = (id: string) =>
      (itemResolvers as any).Item.assets({ id }, {}, { loaders });
    const batch = await Promise.all(ids.map(resolveAssets));
    const cached = await resolveAssets("a");
    cases.push(
      norm({
        name: "batch-assets-with-misses-and-request-cache",
        parentType: "Item",
        field: "assets",
        parents: ids.map((id) => ({ id })),
        repeat: { id: "a" },
        args: {},
        expected: [batch, cached],
        trace: driver.trace,
      }),
    );
    const { server } = await import("../src/graphql/index.js");
    const db = { collection: (n: string) => driver.collection(n, true) };
    const operation = async (name: string, query: string, replies: Doc) => {
      driver.trace.length = 0;
      driver.replies.clear();
      for (const [key, seq] of Object.entries(replies))
        driver.replies.set(key, [...seq]);
      const result = await server.executeOperation(
        { query },
        {
          contextValue: {
            db: db as any,
            logger: consola,
            loaders: createLoaders(db),
          },
        },
      );
      if (result.body.kind !== "single")
        throw new Error(name + " expected single result");
      expect(result.body.singleResult.errors, name).toBeUndefined();
      for (const [key, remaining] of driver.replies)
        expect(remaining, name + " unused " + key).toHaveLength(0);
      cases.push(
        norm({
          name,
          query,
          expected: result.body.singleResult.data,
          trace: driver.trace,
        }),
      );
    };
    try {
      await operation(
        "list-builds-with-fallback-size",
        "{builds(sortBy:null,page:2,limit:1){appName downloadSizeBytes installedSizeBytes files(sort:null,dir:null){total}}}",
        {
          "builds.many": [
            [
              {
                ...build,
                labelName: "Live-Windows",
                hash: "manifest",
                installedSizeBytes: 0,
              },
            ],
          ],
          "assets.one": [{ ...asset, downloadSizeBytes: 152 }],
          "files.count": [4],
        },
      );
      await operation(
        "list-sandboxes-and-items",
        "{sandboxes(limit:105){elements{items(page:2,limit:1){elements{id} total page limit}} total limit}}",
        {
          "namespaces.many": [[{ _id: "ns" }]],
          "namespaces.count": [1],
          "items.many": [[item]],
          "items.count": [3],
        },
      );
      await operation(
        "project-fragment-and-alias",
        '{item(id:"i"){label:title ...Details}} fragment Details on Item {id}',
        { "items.one": [item] },
      );
      await operation(
        "items-batch-relationships",
        "{items(limit:2){elements{ id assets{platform} builds{_id}} total}}",
        {
          "items.many": [
            [item, { id: "j", releaseInfo: [{ appId: "missing" }] }],
          ],
          "items.count": [2],
          "assets.many": [[asset]],
          "builds.many": [[build]],
        },
      );
      await operation(
        "changelog-document-union",
        '{changelog(id:"64c000000000000000000001"){document{__typename ... on Offer{title}}}}',
        {
          "changelogs_v2.one": [{ document: primary }],
        },
      );
      await operation(
        "sparse-assets-without-timestamps",
        '{sandbox(id:"ns"){assets{elements{platform title updatedAt}}}}',
        {
          "namespaces.one": [{ _id: "ns" }],
          "items.many": [
            [{ releaseInfo: [{ appId: "other", platform: ["Linux"] }] }],
          ],
          "assets.many": [[{ artifactId: "existing", platform: "Windows" }]],
        },
      );
      await operation(
        "sandbox-generated-assets",
        '{sandbox(id:"ns"){assets(platform:"Linux"){count elements{artifactId platform installedSizeBytes updatedAt}}}}',
        {
          "namespaces.one": [{ _id: "ns" }],
          "items.many": [[item]],
          "assets.many": [[asset]],
        },
      );
      await operation(
        "sandbox-preorder-union",
        '{sandbox(id:"ns"){baseGame{__typename ... on Offer{id title} ... on Item{title}}}}',
        {
          "namespaces.one": [{ _id: "ns" }],
          "offers.one": [null, primary],
        },
      );
    } finally {
      await server.stop();
    }
    const path = fileURLToPath(
      new URL(
        "../rust/oracles/graphql-relationships-node.json",
        import.meta.url,
      ),
    );
    if (process.env.RUST_ORACLE_WRITE === "1")
      writeFileSync(path, JSON.stringify(cases, null, 2) + "\n");
    else expect(cases).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});
