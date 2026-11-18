import { Decimal128, ObjectId } from "mongodb";
import { expect, it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import collections from "../src/v1/routes/collections.js";

it("records ranked collection joins, cursor values and historical cache entries", async () => {
  const { cases, record } = recordMongoReads(collections);
  const oid = new ObjectId("507f1f77bcf86cd799439011");
  const decimal = Decimal128.fromString("349.8");
  const collection = {
    _id: "ranked",
    name: ["Weekly", 7],
    updatedAt: new Date("2025-07-18Z"),
  };
  for (const [name, path] of [
    ["current", "/v1/collections/ranked"],
    ["week", "/v1/collections/ranked/2025W29"],
  ]) {
    const countKey = name === "week" ? "game_positions.aggregateTotal" : "game_positions.count";
    const countResult = name === "week" ? [{ total: 37 }] : 37;
    const count = await record(name + "-matching-total", path + "?limit=1", 200, {
      collections_v2: collection, [countKey]: countResult,
    });
    expect(count.meta.pagination.total).toBe(37);
    const warmCount = await record(name + "-cached-zero-total", path, 200, {
      collections_v2: collection, [countKey]: "FAIL", __totalCachePayload: 0,
    });
    expect(warmCount.meta.pagination.total).toBe(0);
    await record(name + "-count-outage", path, 500, {
      collections_v2: collection, [countKey]: "FAIL",
    });
    for (const [kind, id, rank] of [
      ["integer", 17, "2"],
      ["decimal", decimal, decimal],
      ["object-id", oid, null],
      ["missing", undefined, undefined],
      ["array", ["game", null, 3], true],
    ] as const) {
      const row = {
        ...(id === undefined ? {} : { offerId: id }),
        ...(rank === undefined ? {} : { position: rank }),
        previous: decimal,
        timestamp: new Date("2025-07-15Z"),
        positions: [
          {
            ...(rank === undefined ? {} : { position: rank }),
            date: "2025-07-15",
            metadata: { source: "archive" },
          },
        ],
      };
      const page = path + "?limit=1&locale=fr";
      const result = await record(name + "-" + kind, page, 200, {
        collections_v2: collection,
        game_positions: [row, { position: 9 }],
        offers: [
          { id: String(id ?? ""), namespace: "ns", title: "superseded" },
          { id: id ?? "", namespace: "ns", title: "selected" },
          { id: "unmatched", customAttributes: [null] },
        ],
        pricev2: [
          {
            offerId: id ?? "",
            price: { discountPrice: decimal, currencyCode: "USD" },
          },
        ],
      });
      expect(result.data[0].title).toBe("selected");
      expect(result.data[0].id).toBe(String(id ?? ""));
      expect(result.data[0].price.offerId).toBe(String(id ?? ""));
      expect(result.data[0].price.price.discountPrice).toBe(350);
      await record(
        name + "-" + kind + "-continue",
        page + "&cursor=" + result.meta.pagination.nextCursor,
        200,
        {
          collections_v2: collection,
        },
      );
    }
    for (const [label, page] of Object.entries({
      absent: {},
      scalar: "cached",
      nullData: { data: null },
      extra: { start: 4, end: 5, title: false },
    }))
      await record(
        name + "-cache-" + label,
        path,
        200,
        { collections_v2: collection },
        page,
      );
    const rows = {
      collections_v2: collection,
      game_positions: [{ offerId: "a", position: 1 }],
    };
    await record(name + "-malformed-offer", path, 500, {
      ...rows,
      offers: [{ id: "a", customAttributes: [null] }],
    });
    await record(name + "-malformed-price", path, 500, {
      ...rows,
      offers: [{ id: "a" }],
      pricev2: [{ offerId: "a", currencyCode: 7 }],
    });
    await record(name + "-malformed-identifier", path, 500, {
      ...rows,
      game_positions: [{ offerId: { toString: "historical value" } }],
    });
    const invalidRank = { offerId: "a", position: { toString: false } };
    await record(name + "-rank-without-continuation", path, 200, {
      ...rows,
      game_positions: [invalidRank],
      offers: [{ id: "a" }],
    });
    await record(name + "-invalid-cursor-rank", path + "?limit=1", 500, {
      ...rows,
      game_positions: [invalidRank, { offerId: "b", position: 2 }],
    });
    for (const store of ["game_positions", "offers", "pricev2"]) {
      await record(name + "-" + store + "-unavailable", path, 500, {
        ...rows,
        [store]: "FAIL",
      });
    }
    await record(name + "-unavailable-localization", path + "?locale=fr", 500, {
      ...rows,
      offers: [{ id: "a", namespace: "base" }],
      egs_localizations: "FAIL",
    });
    await record(name + "-invalid-title", path, 500, {
      ...rows,
      collections_v2: { _id: "ranked", name: { toString: 2 } },
    });
    await record(
      name + "-cache-down",
      path,
      200,
      {
        ...rows,
        collections_v2: { _id: "ranked", updatedAt: 42 },
        offers: [{ id: "a" }],
      },
      undefined,
      true,
    );
  }
  assertOracle("collection-positions-http-node", cases);
});
