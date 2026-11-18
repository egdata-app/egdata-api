import { ObjectId } from "mongodb";
import { expect, it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import details from "../src/v1/routes/offer-details.js";

it("records offer changelog joins, date statistics, review hydration and cursor continuation", async () => {
  const { record, cases } = recordMongoReads(details);
  const base = "/v1/offers/game-a/";
  const id = new ObjectId("64c000000000000000000001");
  const stamp = new Date("2026-11-15T02:00:00Z");
  const graph = {
    offers: { id: "game-a", items: [{ id: "item-a" }] },
    offersubitems: [{ _id: "game-a", subItems: [{ id: "sub" }] }],
    items: [{ id: "item-a" }, { id: "sub" }],
    assets: [{ artifactId: "artifact" }],
  };
  const change = {
    _id: id,
    timestamp: stamp,
    metadata: { contextId: "sub", contextType: "item" },
    document: { id: "sub", __v: 0 },
  };
  const path =
    base + "changelog?query=%20car%20&type=UPDATE&field=title&limit=1";
  const page = await record("changelog-joined-page", path, 200, {
    ...graph,
    changelogs_v2: [change, change],
  });
  expect(page.meta.pagination.hasMore).toBe(true);
  await record(
    "changelog-continued",
    path + "&cursor=" + encodeURIComponent(page.meta.pagination.nextCursor),
    200,
    graph,
  );
  await record("changelog-missing", base + "changelog", 404);
  await record(
    "changelog-bad-cursor",
    base + "changelog?cursor=bad",
    400,
    graph,
  );
  await record(
    "changelog-grouped-errors",
    base +
      "changelog?query=" +
      "x".repeat(201) +
      "&type=" +
      "x".repeat(101) +
      "&field=" +
      "y".repeat(201) +
      "&extra=z",
    400,
  );
  await record(
    "changelog-cache",
    base + "changelog",
    200,
    {},
    {
      elements: [change],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    },
  );
  const stats = base + "changelog/stats";
  await record("stats-missing", stats, 400);
  await record("stats-empty", stats + "?from=&to=&extra=1", 400);
  await record("stats-invalid", stats + "?from=no&to=2026-11-17", 400);
  await record("stats-reversed", stats + "?from=2026-11-18&to=2026-11-17", 400);
  await record("stats-present", stats + "?from=2026-11-01&to=2026-11-17", 200, {
    offers: graph.offers,
    changelogs_v2: [
      {
        timestamp: "2026-11-16T00:00:00Z",
        metadata: {
          changes: [
            { changeType: "MODIFY", field: "10" },
            { changeType: 0, field: "2" },
          ],
        },
      },
      {
        timestamp: stamp.toISOString(),
        metadata: { changes: [{ changeType: "MODIFY", field: "title" }, null] },
      },
      { timestamp: stamp, metadata: { changes: [{ field: "10" }] } },
      { timestamp: stamp.toUTCString(), metadata: { changes: [] } },
    ],
  });
  const reviews = base + "reviews";
  const review = {
    _id: id,
    id: "game-a",
    userId: "u",
    rating: 3,
    createdAt: stamp,
    __v: 7,
  };
  const reviewPage = await record(
    "reviews-hydrate",
    reviews + "?verified=false&limit=3",
    200,
    {
      reviews: [
        review,
        { ...review, _id: "two", userId: "missing" },
        { ...review, _id: id },
        { ...review, userId: "extra" },
      ],
      epic: [{ accountId: "u", displayName: "Name", __v: 2 }],
    },
  );
  await record(
    "reviews-continued",
    reviews +
      "?verified=0&limit=3&cursor=" +
      encodeURIComponent(reviewPage.meta.pagination.nextCursor),
    200,
  );
  await record("reviews-unfiltered", reviews, 200, {
    reviews: [{ id: "game-a", rating: 1 }],
  });
  await record("reviews-invalid-verified", reviews + "?verified=some", 400);
  await record("reviews-over-limit", reviews + "?limit=26", 400);
  await record(
    "reviews-empty-js-whitespace-cursor",
    reviews + "?cursor=%EF%BB%BF",
    200,
  );
  const summary = base + "reviews-summary";
  await record("review-summary-verified", summary + "?verified=true", 200, {
    reviews: [{ _id: null, total: 3, recommended: 2, averageRating: 4.5 }],
  });
  await record("review-summary-empty", summary, 200);
  await record("review-summary-failed", summary, 500, { reviews: "FAIL" });
  assertOracle("offer-activity-http-node", cases);
});
