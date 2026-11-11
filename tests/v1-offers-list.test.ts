import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemError } from "../src/v1/errors.js";
import { listOffers } from "../src/v1/services/offers.js";

const mocks = vi.hoisted(() => ({
  offerFind: vi.fn(),
  priceFind: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/models/index.js", () => ({
  Offer: { find: mocks.offerFind },
  PriceEngine: { find: mocks.priceFind },
}));

vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: mocks.cacheGet, set: mocks.cacheSet },
}));

const offer = (id: string, lastModifiedDate: string | null) => ({
  _id: id,
  id,
  namespace: "ns",
  title: id,
  offerType: "BASE_GAME",
  lastModifiedDate,
  keyImages: [],
  tags: [],
  items: [],
});

describe("v1 offer list keyset pagination", () => {
  beforeEach(() => {
    process.env.V1_CURSOR_SECRET =
      "test-cursor-secret-that-is-at-least-32-chars";
    mocks.cacheGet.mockReset().mockResolvedValue(null);
    mocks.cacheSet.mockReset().mockResolvedValue("OK");
    mocks.priceFind.mockReset().mockReturnValue({
      lean: vi.fn(async () => []),
    });
  });

  it("returns a forward page and advances with the opaque cursor", async () => {
    const rows = [
      offer("offer-3", "2026-05-01T00:00:00.000Z"),
      offer("offer-2", "2026-04-30T00:00:00.000Z"),
      offer("offer-1", null),
    ];
    mocks.offerFind.mockReturnValue({
      lean: vi.fn(async () => rows.slice(0, 3)),
    });

    const first = await listOffers({
      country: "US",
      region: "US",
      locale: "en-US",
      limit: 2,
      cursor: null,
    });
    expect(first.offers).toHaveLength(2);
    expect(first.offers[0].id).toBe("offer-3");
    expect(first.pagination).toMatchObject({ limit: 2, hasMore: true });
    expect(first.pagination.nextCursor).toBeTruthy();

    const firstFilter = mocks.offerFind.mock.calls[0][0];
    expect(firstFilter).toEqual({});
    expect(mocks.offerFind.mock.calls[0][2].limit).toBe(3);

    mocks.offerFind.mockReturnValue({
      lean: vi.fn(async () => rows.slice(2)),
    });
    const second = await listOffers({
      country: "US",
      region: "US",
      locale: "en-US",
      limit: 2,
      cursor: first.pagination.nextCursor,
    });
    expect(second.offers.map((entry) => entry.id)).toEqual(["offer-1"]);
    expect(second.pagination.hasMore).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
    expect(mocks.offerFind.mock.calls[1][0]).toEqual({
      $or: [
        { lastModifiedDate: { $lt: new Date("2026-04-30T00:00:00.000Z") } },
        { lastModifiedDate: null },
        {
          $and: [
            {
              lastModifiedDate: {
                $eq: new Date("2026-04-30T00:00:00.000Z"),
              },
            },
            { id: { $gt: "offer-2" } },
          ],
        },
        {
          $and: [
            {
              lastModifiedDate: {
                $eq: new Date("2026-04-30T00:00:00.000Z"),
              },
            },
            { id: null },
          ],
        },
      ],
    });
  });

  it("rejects a cursor reused with a different page size", async () => {
    mocks.offerFind.mockReturnValue({
      lean: vi.fn(async () => [
        offer("a", "2026-05-01T00:00:00.000Z"),
        offer("b", "2026-04-30T00:00:00.000Z"),
      ]),
    });
    const first = await listOffers({
      country: "US",
      region: "US",
      locale: "en-US",
      limit: 1,
      cursor: null,
    });
    try {
      await listOffers({
        country: "US",
        region: "US",
        locale: "en-US",
        limit: 5,
        cursor: first.pagination.nextCursor,
      });
      throw new Error("expected cursor mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).code).toBe("CURSOR_MISMATCH");
    }
  });
});
