import { beforeEach, describe, expect, it, vi } from "vitest";
import offerResolvers from "../src/graphql/resolvers/offer.js";
import { typeDefs } from "../src/graphql/typedefs.js";

type QueryLike = {
  lean: ReturnType<typeof vi.fn>;
  limit?: ReturnType<typeof vi.fn>;
  sort?: ReturnType<typeof vi.fn>;
};

type Resolver = (
  parent: unknown,
  args: Record<string, unknown>,
  context: unknown,
  info: unknown,
) => Promise<unknown>;

const graphqlOfferResolvers = offerResolvers as unknown as {
  Offer: Record<string, Resolver>;
  Query: Record<string, Resolver>;
};

const mocks = vi.hoisted(() => ({
  achievementSetFind: vi.fn(),
  collection: vi.fn(),
  findLocalization: vi.fn(),
  gamePositionCountDocuments: vi.fn(),
  gamePositionFind: vi.fn(),
  hltbFindOne: vi.fn(),
  itemFind: vi.fn(),
  offerCountDocuments: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  priceFind: vi.fn(),
  ratingsFindOne: vi.fn(),
  sandboxFindOne: vi.fn(),
  tagFind: vi.fn(),
  tagModelFind: vi.fn(),
  tagsFind: vi.fn(),
  toArray: vi.fn(),
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
  Franchise: {
    find: vi.fn(),
  },
  FreeGames: {
    find: vi.fn(),
  },
  GamePosition: {
    countDocuments: mocks.gamePositionCountDocuments,
    find: mocks.gamePositionFind,
  },
  Hltb: {
    findOne: mocks.hltbFindOne,
  },
  Item: {
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
  PriceEngineHistorical: {},
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

vi.mock("../src/utils/countries.js", () => ({
  regions: {
    EURO: { countries: ["ES"] },
    US: { countries: ["US"] },
  },
}));

vi.mock("../src/utils/projection.js", () => ({
  buildProjection: vi.fn(() => ({ id: 1, title: 1 })),
}));

function lean<T>(value: T): QueryLike {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

function chain<T>(value: T): QueryLike {
  const query: QueryLike = {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn(),
    sort: vi.fn(),
  };

  query.limit?.mockReturnValue(query);
  query.sort?.mockReturnValue(query);

  return query;
}

const canonicalOffer = {
  id: "offer-1",
  namespace: "sandbox-1",
  title: "Canonical title",
  description: "Canonical description",
  longDescription: "Canonical long description",
  offerType: "BASE_GAME",
  price: {
    price: {
      discountPrice: 1999,
    },
  },
  countriesWhitelist: ["US"],
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.collection.mockReturnValue({
    find: mocks.findLocalization,
  });
  mocks.findLocalization.mockReturnValue({
    toArray: mocks.toArray,
  });
  mocks.toArray.mockResolvedValue([]);
  mocks.offerCountDocuments.mockResolvedValue(1);
  mocks.priceFind.mockReturnValue(
    lean([
      {
        offerId: "offer-1",
        region: "EURO",
        price: {
          discountPrice: 1999,
        },
      },
    ]),
  );
});

describe("GraphQL offer localization", () => {
  it("exposes locale arguments and offer localization metadata in the schema", () => {
    expect(typeDefs).toContain("offer(id: ID!, locale: String): Offer");
    expect(typeDefs).toContain(
      "offers(limit: Int, page: Int, country: String, locale: String): OfferConnection",
    );
    expect(typeDefs).toContain(
      "related(country: String, locale: String): [Offer]",
    );
    expect(typeDefs).toContain("type OfferLocalizationMetadata");
    expect(typeDefs).toContain("expiryDate: Date");
    expect(typeDefs).toContain("localeStatus: String");
  });

  it("localizes GraphQL offer list results with exact locale metadata", async () => {
    mocks.offerFind.mockReturnValue(lean([canonicalOffer]));
    mocks.toArray.mockResolvedValue([
      {
        entityType: "offer",
        entityId: "sandbox-1:offer-1",
        locale: "es-ES",
        source: "graphql.catalogOffer",
        fetchedAt: new Date("2026-07-01T08:41:42.413Z"),
        data: {
          title: "Titulo localizado",
          price: {
            price: {
              discountPrice: 1,
            },
          },
          countriesWhitelist: ["ES"],
        },
      },
    ]);

    const result = (await graphqlOfferResolvers.Query.offers(
      null,
      { country: "ES", limit: 1, locale: "es-ES", page: 1 },
      {},
      {},
    )) as { elements: Array<Record<string, unknown>> };

    expect(result.elements[0]).toMatchObject({
      title: "Titulo localizado",
      description: "Canonical description",
      price: {
        price: {
          discountPrice: 1999,
        },
      },
      countriesWhitelist: ["US"],
      locale: "es-ES",
      localeStatus: "localized",
      canonicalLocale: "en-US",
      localization: {
        source: "graphql.catalogOffer",
        fetchedAt: new Date("2026-07-01T08:41:42.413Z"),
      },
    });
    expect(mocks.collection).toHaveBeenCalledWith("egs_localizations");
    expect(mocks.findLocalization).toHaveBeenCalledWith({
      entityType: "offer",
      entityId: {
        $in: ["sandbox-1:offer-1"],
      },
      locale: "es-ES",
    });
  });

  it("propagates a localized parent offer locale to nested related offers", async () => {
    const relatedOffer = {
      ...canonicalOffer,
      id: "offer-2",
      title: "Related canonical title",
    };
    mocks.offerFind.mockReturnValue(chain([relatedOffer]));
    mocks.toArray.mockResolvedValue([
      {
        entityType: "offer",
        entityId: "sandbox-1:offer-2",
        locale: "es-ES",
        source: "graphql.catalogOffer",
        fetchedAt: new Date("2026-07-01T08:41:42.413Z"),
        data: {
          title: "Relacionado localizado",
        },
      },
    ]);

    const result = (await graphqlOfferResolvers.Offer.related(
      {
        id: "offer-1",
        namespace: "sandbox-1",
        locale: "es-ES",
      },
      {},
      {},
      {},
    )) as Array<Record<string, unknown>>;

    expect(result[0]).toMatchObject({
      id: "offer-2",
      title: "Relacionado localizado",
      locale: "es-ES",
      localeStatus: "localized",
    });
  });

  it("rejects invalid GraphQL locale arguments as bad user input", async () => {
    await expect(
      graphqlOfferResolvers.Query.offers(null, { locale: "en_US" }, {}, {}),
    ).rejects.toMatchObject({
      extensions: {
        code: "BAD_USER_INPUT",
        argumentName: "locale",
      },
    });
    expect(mocks.offerFind).not.toHaveBeenCalled();
  });
});
