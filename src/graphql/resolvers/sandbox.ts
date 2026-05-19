import type { IResolvers } from "@graphql-tools/utils";
import { ObjectId } from "mongodb";
import client from "../../clients/redis.js";
import { db } from "../../db/index.js";
import {
  AchievementSet,
  Asset,
  Build,
  Item,
  Namespace,
  Offer,
  PriceEngine,
  Sandbox as SandboxModel,
  Tags,
} from "../../models/index.js";
import { ageRatingsCountries } from "../../utils/age-ratings.js";
import { regions } from "../../utils/countries.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import type { Context } from "../index.js";

type Document = Record<string, any>;

const DEFAULT_COUNTRY = "US";
const DEFAULT_OFFER_LIMIT = 8;
const DEFAULT_UPDATE_LIMIT = 8;
const MAX_OFFER_LIMIT = 24;
const MAX_UPDATE_LIMIT = 24;
const SANDBOX_HUB_CACHE_TTL_SECONDS = 3600;

const offerTypeRank: Record<string, number> = {
  BASE_GAME: 0,
  EDITION: 1,
  BUNDLE: 2,
  DLC: 3,
  ADD_ON: 4,
  ADDON: 4,
  PASS: 5,
  SEASON: 6,
  DEMO: 7,
};

function clampLimit(value: number | undefined, fallback: number, max: number) {
  if (!value || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, 1), max);
}

function resolveRegion(country: string | undefined) {
  const selectedCountry = country || DEFAULT_COUNTRY;
  return (
    Object.keys(regions).find((region) =>
      regions[region].countries.includes(selectedCountry),
    ) || DEFAULT_COUNTRY
  );
}

function createSandboxHubCacheKey(
  id: string,
  country: string,
  offerLimit: number,
  updateLimit: number,
) {
  return `sandboxHub:${id}:${country}:${offerLimit}:${updateLimit}`;
}

async function findPrimaryContent(sandboxId: string) {
  const baseGameQuery = {
    namespace: { $eq: sandboxId },
    offerType: "BASE_GAME",
    prePurchase: { $ne: true },
    isCodeRedemptionOnly: false,
  };

  let offer = await Offer.findOne(baseGameQuery).lean();

  if (!offer) {
    offer = await Offer.findOne({
      namespace: { $eq: sandboxId },
      offerType: "BASE_GAME",
      prePurchase: true,
    }).lean();
  }

  if (offer) {
    return { kind: "offer", offer, item: null };
  }

  const item = await Item.findOne({
    namespace: { $eq: sandboxId },
    entitlementType: "EXECUTABLE",
    "releaseInfo.0": { $exists: true },
  }).lean();

  if (item) {
    return { kind: "item", offer: null, item };
  }

  return { kind: "none", offer: null, item: null };
}

function collectAppIds(items: Document[]) {
  return Array.from(
    new Set(
      items.flatMap((item) =>
        (item.releaseInfo || [])
          .map((releaseInfo: Document) => releaseInfo.appId)
          .filter(Boolean),
      ),
    ),
  );
}

function collectPlatforms(offer: Document | null, items: Document[]) {
  const itemPlatforms = items.flatMap((item) =>
    (item.releaseInfo || []).flatMap(
      (releaseInfo: Document) => releaseInfo.platform || [],
    ),
  );
  const offerPlatforms =
    offer?.tags
      ?.filter((tag: Document | null) => tag?.groupName === "platform")
      .map((tag: Document) => tag.name)
      .filter(Boolean) || [];

  return Array.from(new Set([...itemPlatforms, ...offerPlatforms]));
}

async function collectGenres(offers: Document[]) {
  const tagIds = Array.from(
    new Set(
      offers.flatMap((offer) =>
        (offer.tags || [])
          .map((tag: Document | null) => tag?.id)
          .filter(Boolean),
      ),
    ),
  );

  if (tagIds.length === 0) {
    return [];
  }

  return Tags.find({
    id: { $in: tagIds },
    groupName: "genre",
  }).lean();
}

function sortFeaturedOffers(offers: Document[]) {
  return [...offers].sort((a, b) => {
    const rankA = offerTypeRank[a.offerType] ?? 99;
    const rankB = offerTypeRank[b.offerType] ?? 99;

    if (rankA !== rankB) {
      return rankA - rankB;
    }

    const dateA = new Date(
      a.releaseDate || a.effectiveDate || a.creationDate || 0,
    ).getTime();
    const dateB = new Date(
      b.releaseDate || b.effectiveDate || b.creationDate || 0,
    ).getTime();

    return dateB - dateA;
  });
}

function getAgeRating(sandbox: Document, country: string | undefined) {
  if (!sandbox.ageGatings) {
    return null;
  }

  const selectedCountry = country || DEFAULT_COUNTRY;
  const selectedRating =
    Object.entries(ageRatingsCountries).find(([, countries]) =>
      countries.includes(selectedCountry),
    )?.[0] ?? "Generic";

  return (
    sandbox.ageGatings[selectedRating] || sandbox.ageGatings.Generic || null
  );
}

function getAchievementScore(achievement: Document) {
  const score = Number(achievement.score ?? achievement.xp ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function summarizeAchievements(sets: Document[]) {
  const achievements = sets.flatMap((set) => set.achievements || []);
  const baseAchievements = sets
    .filter((set) => set.isBase)
    .flatMap((set) => set.achievements || []);

  return {
    sets: sets.length,
    total: achievements.length,
    baseTotal: baseAchievements.length,
    xp: achievements.reduce(
      (sum, achievement) => sum + getAchievementScore(achievement),
      0,
    ),
  };
}

function countVirtualAssets(items: Document[], assets: Document[]) {
  const assetArtifactIds = new Set(
    assets.map((asset: Document) => asset.artifactId),
  );
  let virtualAssetsCount = 0;

  for (const item of items) {
    for (const releaseInfo of item.releaseInfo || []) {
      if (!assetArtifactIds.has(releaseInfo.appId)) {
        virtualAssetsCount += releaseInfo.platform?.length || 0;
      }
    }
  }

  return virtualAssetsCount;
}

async function getSandboxStats(
  sandboxId: string,
  items: Document[],
  achievements: Document[],
) {
  const [offers, assets] = await Promise.all([
    Offer.countDocuments({ namespace: sandboxId }),
    Asset.find({ namespace: sandboxId }).lean(),
  ]);

  const virtualAssetsCount = countVirtualAssets(items, assets);

  const builds = await Build.countDocuments({
    appName: {
      $in: collectAppIds(items),
    },
  });

  return {
    offers,
    items: items.length,
    assets: assets.length + virtualAssetsCount,
    builds,
    achievements: achievements.flatMap(
      (achievementSet) => achievementSet.achievements || [],
    ).length,
  };
}

const resolvers: IResolvers<any, Context> = {
  Query: {
    sandbox: async (_, { id }, context, info) => {
      // Namespace model uses _id for namespace string
      return Namespace.findOne({ _id: { $eq: id } }).lean();
    },
    sandboxHub: async (_, { id, country, offerLimit, updateLimit }) => {
      const resolvedOfferLimit = clampLimit(
        offerLimit,
        DEFAULT_OFFER_LIMIT,
        MAX_OFFER_LIMIT,
      );
      const resolvedUpdateLimit = clampLimit(
        updateLimit,
        DEFAULT_UPDATE_LIMIT,
        MAX_UPDATE_LIMIT,
      );
      const selectedCountry = country || DEFAULT_COUNTRY;
      const cacheKey = createSandboxHubCacheKey(
        id,
        selectedCountry,
        resolvedOfferLimit,
        resolvedUpdateLimit,
      );
      const cached = await client.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const sandbox = await SandboxModel.findOne({ _id: { $eq: id } }).lean();

      if (!sandbox) {
        await client.set(
          cacheKey,
          JSON.stringify(null),
          "EX",
          SANDBOX_HUB_CACHE_TTL_SECONDS,
        );
        return null;
      }

      const region = resolveRegion(selectedCountry);
      const primary = await findPrimaryContent(id);

      const [items, achievements, rawOffers] = await Promise.all([
        Item.find({ namespace: id }).lean(),
        AchievementSet.find({ sandboxId: id }).lean(),
        Offer.find({ namespace: id }, undefined, {
          limit: resolvedOfferLimit * 3,
          sort: { lastModifiedDate: -1 },
        }).lean(),
      ]);

      const appIds = collectAppIds(items);
      const featuredOffers = sortFeaturedOffers(rawOffers).slice(
        0,
        resolvedOfferLimit,
      );

      const [price, stats, recentBuilds, recentChanges, genres] =
        await Promise.all([
          primary.offer
            ? PriceEngine.findOne({
                offerId: { $eq: primary.offer.id },
                region: { $eq: region },
              }).lean()
            : null,
          getSandboxStats(id, items, achievements),
          appIds.length > 0
            ? Build.find({ appName: { $in: appIds } }, undefined, {
                limit: resolvedUpdateLimit,
                sort: { updatedAt: -1 },
              }).lean()
            : [],
          db.db
            .collection("changelogs_v2")
            .find({
              "metadata.contextId": {
                $in: [
                  id,
                  ...rawOffers.map((offer: Document) => offer.id),
                  ...items.map((item: Document) => item.id),
                  ...appIds,
                ],
              },
            })
            .sort({ timestamp: -1 })
            .limit(resolvedUpdateLimit)
            .toArray(),
          collectGenres(rawOffers),
        ]);

      const primaryOffer = (primary.offer ?? null) as Document | null;
      const primaryItem = (primary.item ?? null) as Document | null;
      const title =
        primaryOffer?.title ||
        primaryItem?.title ||
        sandbox.displayName ||
        sandbox.name ||
        id;
      const description =
        primaryOffer?.description ||
        primaryOffer?.longDescription ||
        primaryItem?.description ||
        sandbox.displayName ||
        "";

      const hub = {
        id,
        namespace: id,
        title,
        description,
        primaryKind: primary.kind,
        primaryOffer,
        primaryItem,
        sandbox,
        price,
        seller: primaryOffer?.seller ?? null,
        developer:
          primaryOffer?.developerDisplayName || primaryItem?.developer || null,
        publisher: primaryOffer?.publisherDisplayName || null,
        keyImages: primaryOffer?.keyImages || primaryItem?.keyImages || [],
        genres,
        platforms: collectPlatforms(primary.offer, items),
        stats,
        featuredOffers,
        recentBuilds,
        recentChanges,
        ageRating: getAgeRating(sandbox, selectedCountry),
        achievements: summarizeAchievements(achievements),
        created:
          sandbox.created ||
          sandbox.createdAt ||
          primaryOffer?.creationDate ||
          primaryItem?.creationDate,
        updated:
          sandbox.updated ||
          sandbox.updatedAt ||
          primaryOffer?.lastModifiedDate ||
          primaryItem?.lastModifiedDate,
      };

      await client.set(
        cacheKey,
        JSON.stringify(hub),
        "EX",
        SANDBOX_HUB_CACHE_TTL_SECONDS,
      );

      return hub;
    },
    sandboxes: async (_, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const elements = await Namespace.find({}, undefined, {
        skip,
        limit,
      }).lean();
      return { elements, total: await Namespace.countDocuments(), page, limit };
    },
  },
  Sandbox: {
    items: async (parent, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const query = { namespace: parent._id };
      const elements = await Item.find(query)
        .sort({ lastModifiedDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
      return { elements, total: await Item.countDocuments(query), page, limit };
    },
    offers: async (parent, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const query = { namespace: parent._id };
      const elements = await Offer.find(query)
        .sort({ lastModifiedDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
      return {
        elements: elements.map(orderOffersObject),
        total: await Offer.countDocuments(query),
        page,
        limit,
      };
    },
    assets: async (parent, { limit = 10, page = 1, platform }) => {
      const skip = (page - 1) * limit;
      const sandboxId = parent._id;

      // Logic from src/routes/sandbox.ts
      const items = await Item.find(
        { namespace: sandboxId },
        { id: 1, namespace: 1, releaseInfo: 1, title: 1 },
      ).lean();

      const realAssets = await Asset.find({ namespace: sandboxId })
        .sort({ updatedAt: -1 })
        .lean();
      const realAssetsMap = new Map(
        realAssets.map((a: any) => [a.artifactId, a]),
      );

      const virtualAssets = items.flatMap(
        (item: any) =>
          item.releaseInfo?.flatMap((releaseInfo: any) => {
            if (realAssetsMap.has(releaseInfo.appId)) return [];
            return (releaseInfo.platform || []).map((p: string) => ({
              artifactId: releaseInfo.appId,
              downloadSizeBytes: 0,
              installedSizeBytes: 0,
              itemId: item.id,
              namespace: item.namespace,
              platform: p,
              _id: new ObjectId().toString(),
              title: item.title,
              updatedAt: new Date(0),
            }));
          }) || [],
      );

      let allAssets = [...realAssets, ...virtualAssets].sort(
        (a: any, b: any) => {
          const dateA = a.updatedAt || new Date(0);
          const dateB = b.updatedAt || new Date(0);
          return dateB.getTime() - dateA.getTime();
        },
      );

      if (platform) {
        const platforms = platform.split(",");
        allAssets = allAssets.filter((a: any) =>
          platforms.includes(a.platform),
        );
      }

      const elements = allAssets.slice(skip, skip + limit);

      return {
        elements,
        total: allAssets.length,
        page,
        limit,
        count: allAssets.length,
      };
    },
    builds: async (parent, { limit = 10, page = 1, platform }) => {
      const skip = (page - 1) * limit;
      const platforms = platform?.split(",").filter(Boolean) ?? [];
      const itemQuery: Document = { namespace: parent._id };

      if (platforms.length > 0) {
        itemQuery.releaseInfo = {
          $elemMatch: { platform: { $in: platforms } },
        };
      }

      const items = await Item.find(itemQuery, { releaseInfo: 1 }).lean();
      const appIds = items.flatMap((i: any) =>
        (i.releaseInfo || [])
          .filter(
            (r: any) =>
              platforms.length === 0 ||
              (r.platform || []).some((p: string) => platforms.includes(p)),
          )
          .map((r: any) => r.appId),
      );
      const query: any = { appName: { $in: appIds } };
      const elements = await db.db
        .collection("builds")
        .find(query)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      return {
        elements,
        total: await db.db.collection("builds").countDocuments(query),
        page,
        limit,
      };
    },
    baseGame: async (parent) => {
      const primary = await findPrimaryContent(parent._id);

      if (primary.offer) {
        return orderOffersObject(primary.offer);
      }

      return primary.item;
    },
    achievements: async (parent, _, { loaders }) => {
      return loaders.achievementSet.load(parent._id);
    },
    stats: async (parent) => {
      const [offers, items, achievements, assets] = await Promise.all([
        Offer.countDocuments({ namespace: parent._id }),
        Item.find({ namespace: parent._id }).lean(),
        AchievementSet.find({ sandboxId: parent._id }).lean(),
        Asset.find({ namespace: parent._id }).lean(),
      ]);

      const virtualAssetsCount = countVirtualAssets(items, assets);

      const builds = await Build.countDocuments({
        appName: {
          $in: collectAppIds(items),
        },
      });

      return {
        offers,
        items: items.length,
        assets: assets.length + virtualAssetsCount,
        builds,
        achievements: achievements.flatMap((a: any) => a.achievements || [])
          .length,
      };
    },
    changelog: async (parent, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const sandboxId = parent._id;

      const offers = await db.db
        .collection("offers")
        .find({ namespace: sandboxId })
        .sort({ lastModifiedDate: -1 })
        .limit(100)
        .toArray();
      const items = await Item.find(
        {
          $or: [
            {
              id: {
                $in: offers.flatMap((o: any) => o.items.map((i: any) => i.id)),
              },
            },
            { namespace: sandboxId },
          ],
        },
        { id: 1, releaseInfo: 1 },
      )
        .limit(100)
        .lean();
      const assets = await Asset.find({
        itemId: { $in: items.map((i: any) => i.id) },
      }).lean();
      const buildAppIds = items.flatMap(
        (i: any) => i.releaseInfo?.map((r: any) => r.appId) || [],
      );
      const builds = await db.db
        .collection("builds")
        .find({ appName: { $in: buildAppIds } })
        .toArray();

      const allIds = [
        sandboxId,
        ...offers.map((o: any) => o.id),
        ...items.map((i: any) => i.id),
        ...assets.map((a: any) => a.artifactId),
        ...builds.map((b: any) => b._id.toString()),
      ];

      const matchQuery = { "metadata.contextId": { $in: allIds } };
      const totalCount = await db.db
        .collection("changelogs_v2")
        .countDocuments(matchQuery);
      const elements = await db.db
        .collection("changelogs_v2")
        .find(matchQuery)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      return {
        elements,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasNextPage: page * limit < totalCount,
        hasPreviousPage: page > 1,
      };
    },
  },
  BaseGameResult: {
    __resolveType(obj: any) {
      if (obj.offerType) return "Offer";
      if (obj.entitlementName) return "Item";
      return null;
    },
  },
};

export default resolvers;
