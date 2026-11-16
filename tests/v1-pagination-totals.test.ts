import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  opensearchSearch: vi.fn(),
  offerFind: vi.fn(),
  offerCountDocuments: vi.fn(),
  itemFind: vi.fn(),
  itemCountDocuments: vi.fn(),
  priceFind: vi.fn(),
  franchiseFindById: vi.fn(),
  achievementSetFind: vi.fn(),
  igdbFind: vi.fn(),
  sandboxFindOne: vi.fn(),
  assetFind: vi.fn(),
  assetCountDocuments: vi.fn(),
}));

vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: mocks.cacheGet, set: mocks.cacheSet },
}));

vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: { search: mocks.opensearchSearch },
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: vi.fn(() => ({
        findOne: mocks.sandboxFindOne,
      })),
    },
  },
}));

vi.mock("../src/models/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/models/index.js")>();
  return {
    ...original,
    AchievementSet: { find: mocks.achievementSetFind },
    Asset: {
      find: mocks.assetFind,
      countDocuments: mocks.assetCountDocuments,
    },
    Franchise: { findById: mocks.franchiseFindById },
    Igdb: { find: mocks.igdbFind },
    Item: {
      find: mocks.itemFind,
      countDocuments: mocks.itemCountDocuments,
    },
    Offer: {
      find: mocks.offerFind,
      countDocuments: mocks.offerCountDocuments,
    },
    PriceEngine: { find: mocks.priceFind },
  };
});

import v1Router from "../src/v1/router.js";

const app = new Hono().route("/v1", v1Router);
const keyHeaders = {
  "x-egdata-key-id": "key_test_pagination_1",
  "x-egdata-key-tier": "free",
};

const offerRow = (id: string, lastModifiedDate: string) => ({
  _id: id,
  id,
  namespace: "ns",
  title: id,
  offerType: "BASE_GAME",
  lastModifiedDate,
  releaseDate: lastModifiedDate,
  keyImages: [],
  tags: [],
  items: [],
});

type JsonRecord = Record<string, any>;

const jsonBody = async (response: Response): Promise<JsonRecord> =>
  (await response.json()) as JsonRecord;

describe("v1 pagination total counts and random-page prevention", () => {
  beforeEach(() => {
    process.env.V1_CURSOR_SECRET =
      "test-cursor-secret-that-is-at-least-32-chars";
    mocks.cacheGet.mockReset().mockResolvedValue(null);
    mocks.cacheSet.mockReset().mockResolvedValue("OK");
    mocks.opensearchSearch.mockReset();
    mocks.offerFind.mockReset();
    mocks.offerCountDocuments.mockReset();
    mocks.itemFind.mockReset();
    mocks.itemCountDocuments.mockReset();
    mocks.priceFind.mockReset().mockReturnValue({
      lean: vi.fn(async () => []),
    });
    mocks.franchiseFindById.mockReset();
    mocks.achievementSetFind.mockReset().mockReturnValue({
      lean: vi.fn(async () => []),
    });
    mocks.igdbFind.mockReset().mockReturnValue({
      lean: vi.fn(async () => []),
    });
    mocks.sandboxFindOne.mockReset();
    mocks.assetFind.mockReset();
    mocks.assetCountDocuments.mockReset();
  });

  it("includes exact OpenSearch totals on /v1/search and /v1/multisearch/offers while rejecting page/offset", async () => {
    mocks.opensearchSearch.mockResolvedValue({
      body: {
        took: 5,
        timed_out: false,
        hits: {
          total: { value: 25432, relation: "eq" },
          hits: [
            {
              _source: offerRow("offer-1", "2026-05-01T00:00:00.000Z"),
              sort: ["2026-05-01T00:00:00.000Z", "offer-1"],
            },
            {
              _source: offerRow("offer-2", "2026-04-30T00:00:00.000Z"),
              sort: ["2026-04-30T00:00:00.000Z", "offer-2"],
            },
          ],
        },
        aggregations: {},
      },
    });

    const res = await app.request("/v1/search?limit=1", { headers: keyHeaders });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.meta.pagination).toMatchObject({
      limit: 1,
      hasMore: true,
      total: 25432,
    });
    expect(body.meta.pagination.nextCursor).toBeTruthy();
    expect(mocks.opensearchSearch.mock.calls[0][0].body.track_total_hits).toBe(
      true,
    );

    const multiRes = await app.request("/v1/multisearch/offers?limit=1", {
      headers: keyHeaders,
    });
    expect(multiRes.status).toBe(200);
    const multiBody = await jsonBody(multiRes);
    expect(multiBody.meta.pagination.total).toBe(25432);
    expect(mocks.opensearchSearch.mock.calls[1][0].body.track_total_hits).toBe(
      true,
    );

    // Random page / offset jumping is strictly rejected
    for (const badUrl of [
      "/v1/search?page=50",
      "/v1/search?offset=100",
      "/v1/offers?page=50",
      "/v1/items?offset=20",
      "/v1/multisearch/offers?page=10",
    ]) {
      const bad = await app.request(badUrl, { headers: keyHeaders });
      expect(bad.status).toBe(400);
      expect((await jsonBody(bad)).code).toBe("INVALID_QUERY");
    }
  });

  it("rejects forged or mismatched cursors even when total is known", async () => {
    mocks.offerCountDocuments.mockResolvedValue(500);
    mocks.offerFind.mockReturnValue({
      lean: vi.fn(async () => [
        offerRow("offer-1", "2026-05-01T00:00:00.000Z"),
        offerRow("offer-2", "2026-04-30T00:00:00.000Z"),
      ]),
    });

    const first = await app.request("/v1/offers?limit=1", {
      headers: keyHeaders,
    });
    expect(first.status).toBe(200);
    const firstBody = await jsonBody(first);
    expect(firstBody.meta.pagination.total).toBe(500);
    const cursor = firstBody.meta.pagination.nextCursor as string;

    const forged = await app.request("/v1/offers?limit=1&cursor=ZmFrZQ.ZmFrZQ", {
      headers: keyHeaders,
    });
    expect(forged.status).toBe(400);
    expect((await jsonBody(forged)).code).toBe("INVALID_CURSOR");

    const changedLimit = await app.request(
      `/v1/offers?limit=50&cursor=${encodeURIComponent(cursor)}`,
      { headers: keyHeaders },
    );
    expect(changedLimit.status).toBe(400);
    expect((await jsonBody(changedLimit)).code).toBe("CURSOR_MISMATCH");
  });

  it("returns total for franchises and sandbox assets", async () => {
    mocks.franchiseFindById.mockReturnValue({
      lean: vi.fn(async () => ({
        _id: "hades",
        name: "Hades",
        offers: ["o1", "o2", "o3"],
      })),
    });
    mocks.offerFind.mockImplementation((_q: unknown, projection?: unknown) => ({
      lean: vi.fn(async () =>
        projection
          ? [
              { id: "o1", namespace: "ns1" },
              { id: "o2", namespace: "ns1" },
              { id: "o3", namespace: "ns1" },
            ]
          : [
              offerRow("o1", "2026-05-03T00:00:00.000Z"),
              offerRow("o2", "2026-05-02T00:00:00.000Z"),
            ],
      ),
    }));

    const franchiseRes = await app.request("/v1/franchises/hades?limit=1", {
      headers: keyHeaders,
    });
    expect(franchiseRes.status).toBe(200);
    const franchiseBody = await jsonBody(franchiseRes);
    expect(franchiseBody.meta.pagination).toMatchObject({
      limit: 1,
      hasMore: true,
      total: 3,
    });

    mocks.sandboxFindOne.mockResolvedValue({ _id: "sbx-1" });
    mocks.itemFind.mockReturnValue({
      lean: vi.fn(async () => []),
    });
    mocks.assetFind.mockReturnValue({
      lean: vi.fn(async () => [
        { artifactId: "a1", platform: "Windows", updatedAt: new Date() },
        { artifactId: "a2", platform: "Mac", updatedAt: new Date() },
      ]),
    });

    const assetsRes = await app.request("/v1/sandboxes/sbx-1/assets?limit=1", {
      headers: keyHeaders,
    });
    expect(assetsRes.status).toBe(200);
    const assetsBody = await jsonBody(assetsRes);
    expect(assetsBody.meta.pagination).toMatchObject({
      limit: 1,
      hasMore: true,
      total: 2,
    });
  });

  it("documents pagination.total in /v1/open-api.json", async () => {
    const res = await app.request("/v1/open-api.json");
    expect(res.status).toBe(200);
    const spec = await jsonBody(res);
    expect(spec.components.schemas.Pagination.required).toContain("total");
    expect(spec.components.schemas.Pagination.properties.total).toEqual({
      type: "integer",
      minimum: 0,
      nullable: true,
    });
  });
});
