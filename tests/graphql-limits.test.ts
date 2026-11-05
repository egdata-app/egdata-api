import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAGE_SIZE } from "../src/graphql/pagination.js";
import itemResolvers from "../src/graphql/resolvers/item.js";
import offerResolvers from "../src/graphql/resolvers/offer.js";

type QueryLike = {
  lean: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  skip: ReturnType<typeof vi.fn>;
  sort: ReturnType<typeof vi.fn>;
};

type Resolver = (
  parent: unknown,
  args: Record<string, unknown>,
  context: unknown,
  info: unknown,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  achievementSetFind: vi.fn(),
  assetFind: vi.fn(),
  collection: vi.fn(),
  franchiseFind: vi.fn(),
  freeGamesFind: vi.fn(),
  gamePositionCountDocuments: vi.fn(),
  gamePositionFind: vi.fn(),
  hltbFindOne: vi.fn(),
  itemCountDocuments: vi.fn(),
  itemFind: vi.fn(),
  offerCountDocuments: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  priceFind: vi.fn(),
  ratingsFindOne: vi.fn(),
  sandboxFindOne: vi.fn(),
  tagModelFind: vi.fn(),
  tagsFind: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: mocks.collection,
    },
  },
}));

vi.mock("../src/models/index.js", () => ({
  AchievementSet: {
    find: mocks.achievementSetFind,
  },
  Asset: {
    find: mocks.assetFind,
  },
  Franchise: {
    find: mocks.franchiseFind,
  },
  FreeGames: {
    find: mocks.freeGamesFind,
  },
  GamePosition: {
    countDocuments: mocks.gamePositionCountDocuments,
    find: mocks.gamePositionFind,
  },
  Hltb: {
    findOne: mocks.hltbFindOne,
  },
  Item: {
    countDocuments: mocks.itemCountDocuments,
    find: mocks.itemFind,
  },
  Offer: {
    countDocuments: mocks.offerCountDocuments,
    find: mocks.offerFind,
    findOne: mocks.offerFindOne,
  },
  PriceEngine: {
    find: mocks.priceFind,
  },
  Ratings: {
    findOne: mocks.ratingsFindOne,
  },
  Sandbox: {
    findOne: mocks.sandboxFindOne,
  },
  TagModel: {
    find: mocks.tagModelFind,
  },
  Tags: {
    find: mocks.tagsFind,
  },
}));

function chain<T>(value: T): QueryLike {
  const query = {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn(),
    skip: vi.fn(),
    sort: vi.fn(),
  } as QueryLike;

  query.limit.mockReturnValue(query);
  query.skip.mockReturnValue(query);
  query.sort.mockReturnValue(query);

  return query;
}

const queryResolvers = {
  ...(offerResolvers.Query as Record<string, Resolver>),
  ...(itemResolvers.Query as Record<string, Resolver>),
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.offerFind.mockReturnValue(chain([]));
  mocks.offerCountDocuments.mockResolvedValue(0);
  mocks.priceFind.mockReturnValue(chain([]));
  mocks.itemFind.mockReturnValue(chain([]));
  mocks.itemCountDocuments.mockResolvedValue(0);
});

describe("GraphQL resolver pagination caps", () => {
  it("caps offers(limit) at the maximum page size", async () => {
    const result = await queryResolvers.offers(
      null,
      { country: "US", limit: 2_000, page: 1 },
      {},
      {},
    );

    expect(mocks.offerFind).toHaveBeenCalledWith(
      {},
      undefined,
      expect.objectContaining({ limit: MAX_PAGE_SIZE, skip: 0 }),
    );
    expect(result).toMatchObject({ page: 1, limit: MAX_PAGE_SIZE });
  });

  it("normalizes invalid limits and pages for offers", async () => {
    const result = await queryResolvers.offers(
      null,
      { country: "US", limit: -10, page: -2 },
      {},
      {},
    );

    expect(mocks.offerFind).toHaveBeenCalledWith(
      {},
      undefined,
      expect.objectContaining({ limit: 1, skip: 0 }),
    );
    expect(result).toMatchObject({ page: 1, limit: 1 });
  });

  it("caps the page number used for offers", async () => {
    const result = await queryResolvers.offers(
      null,
      { country: "US", limit: 10, page: 1_000_000 },
      {},
      {},
    );

    expect(mocks.offerFind).toHaveBeenCalledWith(
      {},
      undefined,
      expect.objectContaining({ limit: 10, skip: 9_999 * 10 }),
    );
    expect(result).toMatchObject({ page: 10_000, limit: 10 });
  });

  it("caps items(limit) at the maximum page size", async () => {
    const result = await queryResolvers.items(
      null,
      { limit: 10_000, page: 1 },
      {},
      {},
    );

    expect(mocks.itemFind).toHaveBeenCalledWith(
      {},
      undefined,
      expect.objectContaining({ limit: MAX_PAGE_SIZE, skip: 0 }),
    );
    expect(result).toMatchObject({ page: 1, limit: MAX_PAGE_SIZE });
  });

  it("uses the default page size when limit is missing", async () => {
    await queryResolvers.items(null, {}, {}, {});

    expect(mocks.itemFind).toHaveBeenCalledWith(
      {},
      undefined,
      expect.objectContaining({ limit: 10, skip: 0 }),
    );
  });
});
