import { Decimal128, Long, ObjectId } from "mongodb";
import { expect, it, vi } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import { encodeCursor } from "../src/v1/cursor.js";
import details from "../src/v1/routes/offer-details.js";

it("records grouped history, regional date bounds and typed Mongo keyset cursors", async () => {
  const { record, cases } = recordMongoReads(details);
  const path = "/v1/offers/game-a/price-history";
  const offer = { id: "game-a" };
  const row = {
    offerId: "game-a",
    region: "US",
    date: new Date("2026-06-01T03:00:00.000Z"),
    updatedAt: new Date("2026-06-02T11:00:00.000Z"),
    price: { discountPrice: 300, currencyCode: "USD" },
  };
  const id = new ObjectId("64c000000000000000000001");
  await record("history-grouped", path + "?since=2026-05-31&limit=1", 200, {
    offers: offer,
    pricev2_historical: [
      { ...row, _id: id },
      { ...row, region: "EU" },
      { ...row, region: "US" },
      { ...row, region: "" },
    ],
  });
  await record("history-grouped-cache", path, 200, {}, { US: [] });
  await record("history-grouped-invalid-limit", path + "?limit=0", 400);
  await record("history-grouped-missing-offer", path, 404);
  await record("history-invalid-since", path + "?since=tomorrow", 400);
  await record("history-invalid-region", path + "?region=NO-SUCH-REGION", 400);
  await record("history-invalid-country", path + "?country=XYZ", 400);
  await record(
    "history-timestamp-at-midnight",
    path + "?region=US&since=2024-02-29T24:00:00Z",
    200,
    { offers: offer },
  );
  await record(
    "history-malformed-cursor",
    path + "?region=US&cursor=bad",
    400,
    { offers: offer },
  );
  for (const [label, storedId] of [
    ["object-id", id],
    ["string-id", id.toHexString()],
    ["numeric-id", 15],
    ["compound-id", { store: "epic", revision: 2 }],
  ] as const) {
    const page =
      path +
      "?region=us&country=XYZ&locale=fr&limit=1&since=2026-05-31T13%3A00%3A00%2B02%3A00";
    const initial = await record("history-" + label, page, 200, {
      offers: offer,
      pricev2_historical: [
        { ...row, _id: storedId },
        { ...row, _id: "second" },
      ],
    });
    const token = initial.meta.pagination.nextCursor;
    expect(token).toEqual(expect.any(String));
    await record(
      "history-" + label + "-continue",
      page + "&cursor=" + encodeURIComponent(token),
      200,
      { offers: offer },
    );
  }
  for (const [name, resource] of [
    ["grouped", path],
    ["regional", path + "?country=US"],
  ]) {
    await record(name + "-offer-read-failure", resource, 500, {
      "offers.one": "FAIL",
    });
    await record(name + "-history-read-failure", resource, 500, {
      offers: offer,
      "pricev2_historical.many": "FAIL",
    });
    await record(
      name + "-redis-offline",
      resource,
      200,
      { offers: offer, pricev2_historical: [row] },
      undefined,
      true,
    );
    await record(name + "-unusable-currency", resource, 500, {
      offers: offer,
      pricev2_historical: [{ ...row, price: { currencyCode: 3 } }],
    });
  }
  await record("history-country-derived-region", path + "?country=DE", 200, {
    offers: offer,
  });
  await record(
    "history-region-cache-hit",
    path + "?region=US",
    200,
    {},
    {
      elements: [row],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    },
  );
  await record(
    "history-invalid-locale-before-database",
    path + "?locale=x/y",
    400,
  );
  await record("history-unknown-parameter", path + "?unknown=1", 400);
  for (const [since, status] of [
    ["2023-02-29", 200],
    ["2024-04-31T12:05:03.4-03:30", 200],
    ["2024-04-01T12:05:03.04Z", 200],
    ["2024-00-01", 400],
    ["2024-01-00", 400],
    ["2024-01-32", 400],
    ["2024-01-01T25:00Z", 400],
    ["2024-01-01T12:60Z", 400],
    ["2024-01-01T12:05:60Z", 400],
    ["2024-01-01T24:01Z", 400],
    ["2024-01-01T24:00:01Z", 400],
    ["2024-01-01T24:00:00.001Z", 400],
    ["2024-01-01T00:00:00+24:00", 400],
    ["2024-01-01T00:00:00-00:60", 400],
  ] as const) {
    await record(
      "history ISO timestamp " + since,
      path + "?region=US&since=" + encodeURIComponent(since),
      status,
      { offers: offer },
    );
  }
  const pagePath = path + "?region=US&limit=1";
  for (const tuple of [[null], [1, 15, "extra"], [123, null]] as (
    | string
    | number
    | null
  )[][]) {
    const token = encodeCursor(
      {
        operation: "offer-details.price-history",
        filters: { offerId: "game-a", region: "US", since: null },
        ordering: "date:desc,_id:desc",
        country: "US",
        locale: "en-US",
        limit: 1,
      },
      tuple,
    );
    await record(
      "history cursor tuple " + JSON.stringify(tuple),
      pagePath + "&cursor=" + encodeURIComponent(token),
      tuple.length === 2 ? 200 : 400,
      { offers: offer },
    );
  }
  for (const [name, date, storedId] of [
    ["missing", undefined, undefined],
    ["explicit-null", null, null],
    ["unknown-date", "upstream unknown", "oid:not-an-objectid"],
    ["rollover-date", "2024-02-30T12:05:01.040Z", "legacy"],
    ["compact-offset", "2023-06-20T12:30:00+0230", "legacy"],
    ["local-string-midnight", "2024-05-31T23:59:59+02:00", "store"],
    ["large-number-id", row.date, Long.fromString("9223372036854775807")],
    ["decimal-id", row.date, 1.25],
    ["bson-decimal-id", row.date, Decimal128.fromString("102.00")],
    ["nondate-object-id", id, "legacy-record"],
    ["array-id", row.date, ["shop", 5]],
  ] as const) {
    const stored = { ...row, date, _id: storedId };
    const first = await record("history-date-and-id-" + name, pagePath, 200, {
      offers: offer,
      pricev2_historical: [
        Object.fromEntries(
          Object.entries(stored).filter(([, value]) => value !== undefined),
        ),
        { ...row, _id: "next" },
      ],
    });
    await record(
      "history-date-and-id-continue-" + name,
      pagePath +
        "&cursor=" +
        encodeURIComponent(first.meta.pagination.nextCursor),
      200,
      { offers: offer },
    );
  }
  await record("history-array-region-multi-key", path, 200, {
    offers: offer,
    pricev2_historical: [
      { ...row, region: ["US", "EU"] },
      { ...row, region: ["US", "EU"], date: "previous" },
      { ...row, region: null },
      { ...row, region: "" },
    ],
  });
  await record("history-stored-price-types", pagePath, 200, {
    offers: offer,
    pricev2_historical: [
      {
        ...row,
        price: {
          currencyCode: "jpy",
          originalPrice: "0x10",
          discountPrice: 0.49999999999999994,
          basePrice: "",
          minPrice: [15],
          amount: [],
          maxPrice: true,
        },
        extra: { id: 2 },
      },
    ],
  });
  await record("history-array-price", pagePath, 200, {
    offers: offer,
    pricev2_historical: [{ ...row, price: [25], currencyCode: "KWD" }],
  });
  await record("history-bson-decimal-and-long-minor-units", pagePath, 200, {
    offers: offer,
    pricev2_historical: [
      {
        ...row,
        amount: Decimal128.fromString("124.51"),
        updatedAt: "2024-02-30T12:05:01Z",
        price: {
          currencyCode: "JOD",
          originalPrice: Decimal128.fromString("1451.49"),
          discountPrice: Long.fromString("9007199254740993"),
        },
      },
    ],
  });
  await record("history-falsy-currency", pagePath, 200, {
    offers: offer,
    pricev2_historical: [
      { ...row, price: { currencyCode: false }, currencyCode: "JPY" },
    ],
  });
  for (const price of [
    Decimal128.fromString("99.00"),
    Long.fromString("9007199254740993"),
  ]) {
    await record(
      "history-top-level-bson-price-" + price._bsontype,
      pagePath,
      200,
      {
        offers: offer,
        pricev2_historical: [{ ...row, price, currencyCode: "JPY" }],
      },
    );
  }
  vi.stubEnv("V1_CURSOR_SECRET", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
  await record("history-page-without-signing-key", pagePath, 503, {
    offers: offer,
    pricev2_historical: [row, row],
  });
  (cases.at(-1) as { cursorSecret?: boolean }).cursorSecret = false;
  await record(
    "history-invalid-stored-price-precedes-unavailable-signer",
    pagePath,
    500,
    {
      offers: offer,
      pricev2_historical: [{ ...row, price: { currencyCode: 3 } }, row],
    },
  );
  (cases.at(-1) as { cursorSecret?: boolean }).cursorSecret = false;
  assertOracle("offer-price-history-http-node", cases);
});
