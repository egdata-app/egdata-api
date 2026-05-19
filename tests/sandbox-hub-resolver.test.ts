import { beforeEach, describe, expect, it, vi } from "vitest";
import sandboxResolvers from "../src/graphql/resolvers/sandbox.js";

type QueryLike = {
  lean: ReturnType<typeof vi.fn>;
  sort?: ReturnType<typeof vi.fn>;
  skip?: ReturnType<typeof vi.fn>;
  limit?: ReturnType<typeof vi.fn>;
};

type SandboxHubResult = {
  achievements: unknown;
  ageRating: unknown;
  description: string;
  developer: string | null;
  featuredOffers: Array<{ id: string }>;
  id: string;
  platforms: string[];
  price: unknown | null;
  primaryItem: { id: string } | null;
  primaryKind: string;
  primaryOffer: { id: string } | null;
  publisher: string | null;
  recentBuilds: unknown[];
  recentChanges: unknown[];
  stats: unknown;
  title: string;
};

type SandboxHubResolver = (
  parent: unknown,
  args: Record<string, unknown>,
  context: unknown,
  info: unknown,
) => Promise<SandboxHubResult | null>;

type OfferFindOneQuery = {
  isCodeRedemptionOnly?: boolean;
  namespace?: { $eq?: string } | string;
  offerType?: string;
  prePurchase?: boolean | { $ne?: boolean };
};

const mocks = vi.hoisted(() => ({
  achievementSetFind: vi.fn(),
  assetFind: vi.fn(),
  buildCountDocuments: vi.fn(),
  buildFind: vi.fn(),
  collection: vi.fn(),
  itemFind: vi.fn(),
  itemFindOne: vi.fn(),
  offerCountDocuments: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  priceFindOne: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  sandboxFindOne: vi.fn(),
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
  Build: {
    countDocuments: mocks.buildCountDocuments,
    find: mocks.buildFind,
  },
  Item: {
    find: mocks.itemFind,
    findOne: mocks.itemFindOne,
  },
  Namespace: {
    find: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
  },
  Offer: {
    countDocuments: mocks.offerCountDocuments,
    find: mocks.offerFind,
    findOne: mocks.offerFindOne,
  },
  PriceEngine: {
    findOne: mocks.priceFindOne,
  },
  Sandbox: {
    findOne: mocks.sandboxFindOne,
  },
  Tags: {
    find: mocks.tagsFind,
  },
}));

vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

vi.mock("../src/utils/age-ratings.js", () => ({
  ageRatingsCountries: {
    ESRB: ["US"],
    PEGI: ["ES"],
  },
}));

vi.mock("../src/utils/countries.js", () => ({
  regions: {
    EURO: { countries: ["ES", "FR"] },
    US: { countries: ["US"] },
  },
}));

const sandbox = {
  _id: "sandbox-1",
  displayName: "Fallback Sandbox Name",
  name: "Fallback Namespace Name",
  ageGatings: {
    ESRB: { rating: "Teen" },
    Generic: { rating: "General" },
  },
  created: "2024-01-01T00:00:00.000Z",
  updated: "2024-02-01T00:00:00.000Z",
};

const baseOffer = {
  _id: "base-offer-object",
  id: "base-offer",
  namespace: "sandbox-1",
  title: "Base Game",
  description: "Base game description",
  offerType: "BASE_GAME",
  seller: { id: "seller-1", name: "Seller" },
  developerDisplayName: "Developer",
  publisherDisplayName: "Publisher",
  prePurchase: false,
  keyImages: [{ type: "OfferImageWide", url: "https://example.test/base.jpg" }],
  tags: [{ id: "genre-action", name: "Action", groupName: "genre" }],
  releaseDate: "2024-03-01T00:00:00.000Z",
  creationDate: "2024-01-10T00:00:00.000Z",
  lastModifiedDate: "2024-03-02T00:00:00.000Z",
  customAttributes: [{ key: "CanRunOffline", type: "STRING", value: "true" }],
  items: [{ id: "item-1", namespace: "sandbox-1" }],
};

const prepurchaseOffer = {
  ...baseOffer,
  id: "prepurchase-offer",
  title: "Future Base Game",
  prePurchase: true,
};

const executableItem = {
  _id: "item-object",
  id: "item-1",
  namespace: "sandbox-1",
  title: "Executable Item",
  description: "Executable item description",
  entitlementType: "EXECUTABLE",
  developer: "Item Developer",
  keyImages: [{ type: "OfferImageWide", url: "https://example.test/item.jpg" }],
  creationDate: "2024-01-05T00:00:00.000Z",
  lastModifiedDate: "2024-02-05T00:00:00.000Z",
  releaseInfo: [{ appId: "app-1", platform: ["Windows"] }],
};

const featuredDlc = {
  ...baseOffer,
  id: "dlc-offer",
  title: "DLC",
  offerType: "DLC",
  releaseDate: "2024-04-01T00:00:00.000Z",
};

function lean<T>(value: T): QueryLike {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

function chain<T>(value: T): QueryLike {
  const query: QueryLike = {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn(),
    skip: vi.fn(),
    sort: vi.fn(),
  };

  query.limit?.mockReturnValue(query);
  query.skip?.mockReturnValue(query);
  query.sort?.mockReturnValue(query);

  return query;
}

function mockRecentChanges(changes: unknown[]) {
  const query = {
    sort: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue(changes),
  };

  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);

  mocks.collection.mockReturnValue({
    find: vi.fn().mockReturnValue(query),
  });
}

function isReleasedBaseGameQuery(query: OfferFindOneQuery) {
  return (
    query.namespace &&
    typeof query.namespace === "object" &&
    query.namespace.$eq === "sandbox-1" &&
    query.offerType === "BASE_GAME" &&
    typeof query.prePurchase === "object" &&
    query.prePurchase.$ne === true &&
    query.isCodeRedemptionOnly === false
  );
}

function isPrepurchaseBaseGameQuery(query: OfferFindOneQuery) {
  return (
    query.namespace &&
    typeof query.namespace === "object" &&
    query.namespace.$eq === "sandbox-1" &&
    query.offerType === "BASE_GAME" &&
    query.prePurchase === true
  );
}

function mockPrimaryOffers(
  releasedBaseGame: typeof baseOffer | null,
  prepurchaseBaseGame: typeof baseOffer | null,
) {
  mocks.offerFindOne.mockImplementation((query: OfferFindOneQuery) => {
    if (isReleasedBaseGameQuery(query)) {
      return lean(releasedBaseGame);
    }

    if (isPrepurchaseBaseGameQuery(query)) {
      return lean(prepurchaseBaseGame);
    }

    throw new Error(`Unexpected Offer.findOne query: ${JSON.stringify(query)}`);
  });
}

async function sandboxHub(args: Record<string, unknown> = {}) {
  const resolver = (sandboxResolvers.Query as Record<string, unknown>)
    .sandboxHub as SandboxHubResolver;

  return resolver(
    null,
    { id: "sandbox-1", country: "US", offerLimit: 4, updateLimit: 3, ...args },
    {},
    {},
  );
}

async function requireSandboxHub(args: Record<string, unknown> = {}) {
  const hub = await sandboxHub(args);

  if (!hub) {
    throw new Error("Expected sandboxHub to return hub data");
  }

  return hub;
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSet.mockResolvedValue("OK");
  mocks.sandboxFindOne.mockReturnValue(lean(sandbox));
  mockPrimaryOffers(baseOffer, null);
  mocks.itemFindOne.mockReturnValue(lean(null));
  mocks.itemFind.mockReturnValue(chain([executableItem]));
  mocks.achievementSetFind.mockReturnValue(
    chain([
      {
        sandboxId: "sandbox-1",
        isBase: true,
        achievements: [
          { id: "ach-1", score: 10 },
          { id: "ach-2", score: 15 },
        ],
      },
    ]),
  );
  mocks.offerFind.mockReturnValue(chain([featuredDlc, baseOffer]));
  mocks.offerCountDocuments.mockResolvedValue(2);
  mocks.assetFind.mockReturnValue(chain([]));
  mocks.buildCountDocuments.mockResolvedValue(1);
  mocks.buildFind.mockReturnValue(
    chain([
      {
        _id: "build-1",
        appName: "app-1",
        labelName: "Live",
        updatedAt: "2024-05-01T00:00:00.000Z",
      },
    ]),
  );
  mocks.priceFindOne.mockReturnValue(
    lean({
      offerId: "base-offer",
      region: "US",
      price: { currencyCode: "USD", discountPrice: 1999, originalPrice: 1999 },
    }),
  );
  mocks.tagsFind.mockReturnValue(
    chain([{ id: "genre-action", name: "Action", groupName: "genre" }]),
  );
  mockRecentChanges([
    {
      _id: "change-1",
      metadata: { contextId: "base-offer", contextType: "Offer", changes: [] },
      timestamp: "2024-05-02T00:00:00.000Z",
    },
  ]);
});

describe("sandboxHub GraphQL resolver", () => {
  it("returns cached hub data before running database work", async () => {
    const cachedHub: SandboxHubResult = {
      achievements: {},
      ageRating: null,
      description: "Cached description",
      developer: null,
      featuredOffers: [],
      id: "sandbox-1",
      platforms: [],
      price: null,
      primaryItem: null,
      primaryKind: "offer",
      primaryOffer: null,
      publisher: null,
      recentBuilds: [],
      recentChanges: [],
      stats: {},
      title: "Cached Hub",
    };
    mocks.redisGet.mockResolvedValue(JSON.stringify(cachedHub));

    await expect(sandboxHub()).resolves.toEqual(cachedHub);
    expect(mocks.redisGet).toHaveBeenCalledWith("sandboxHub:sandbox-1:US:4:3");
    expect(mocks.sandboxFindOne).not.toHaveBeenCalled();
    expect(mocks.offerFindOne).not.toHaveBeenCalled();
  });

  it("uses a non-prepurchase base game as the primary product", async () => {
    const hub = await requireSandboxHub();

    expect(hub).toMatchObject({
      id: "sandbox-1",
      primaryKind: "offer",
      title: "Base Game",
      description: "Base game description",
      developer: "Developer",
      publisher: "Publisher",
      price: {
        offerId: "base-offer",
        region: "US",
      },
      ageRating: { rating: "Teen" },
      stats: {
        offers: 2,
        items: 1,
        assets: 1,
        builds: 1,
        achievements: 2,
      },
      achievements: {
        sets: 1,
        total: 2,
        baseTotal: 2,
        xp: 25,
      },
    });
    expect(hub.featuredOffers.map((offer) => offer.id)).toEqual([
      "base-offer",
      "dlc-offer",
    ]);
    expect(hub.recentBuilds).toHaveLength(1);
    expect(hub.recentChanges).toHaveLength(1);
  });

  it("falls back to a prepurchase base game when no released base game exists", async () => {
    mockPrimaryOffers(null, prepurchaseOffer);
    mocks.priceFindOne.mockReturnValue(
      lean({
        offerId: "prepurchase-offer",
        region: "US",
        price: {
          currencyCode: "USD",
          discountPrice: 4999,
          originalPrice: 4999,
        },
      }),
    );

    const hub = await requireSandboxHub();

    expect(hub.primaryKind).toBe("offer");
    expect(hub.primaryOffer?.id).toBe("prepurchase-offer");
    expect(hub.title).toBe("Future Base Game");
    expect(mocks.itemFindOne).not.toHaveBeenCalled();
  });

  it("falls back to an executable item when no base game offer exists", async () => {
    mockPrimaryOffers(null, null);
    mocks.itemFindOne.mockReturnValue(lean(executableItem));

    const hub = await requireSandboxHub();

    expect(hub.primaryKind).toBe("item");
    expect(hub.primaryItem?.id).toBe("item-1");
    expect(hub.title).toBe("Executable Item");
    expect(hub.price).toBeNull();
    expect(hub.platforms).toEqual(["Windows"]);
  });

  it("returns a sparse hub for an empty sandbox", async () => {
    mockPrimaryOffers(null, null);
    mocks.itemFindOne.mockReturnValue(lean(null));
    mocks.itemFind.mockReturnValue(chain([]));
    mocks.achievementSetFind.mockReturnValue(chain([]));
    mocks.offerFind.mockReturnValue(chain([]));
    mocks.offerCountDocuments.mockResolvedValue(0);
    mocks.assetFind.mockReturnValue(chain([]));
    mocks.buildCountDocuments.mockResolvedValue(0);
    mocks.tagsFind.mockReturnValue(chain([]));
    mockRecentChanges([]);

    const hub = await requireSandboxHub();

    expect(hub).toMatchObject({
      primaryKind: "none",
      title: "Fallback Sandbox Name",
      description: "Fallback Sandbox Name",
      featuredOffers: [],
      recentBuilds: [],
      recentChanges: [],
      stats: {
        offers: 0,
        items: 0,
        assets: 0,
        builds: 0,
        achievements: 0,
      },
    });
    expect(hub.price).toBeNull();
    expect(hub.primaryOffer).toBeNull();
    expect(hub.primaryItem).toBeNull();
  });

  it("returns null for a missing sandbox", async () => {
    mocks.sandboxFindOne.mockReturnValue(lean(null));

    await expect(sandboxHub()).resolves.toBeNull();
    expect(mocks.offerFindOne).not.toHaveBeenCalled();
    expect(mocks.itemFind).not.toHaveBeenCalled();
    expect(mocks.itemFindOne).not.toHaveBeenCalled();
    expect(mocks.priceFindOne).not.toHaveBeenCalled();
  });
});
