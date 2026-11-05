import type { IResolvers } from "@graphql-tools/utils";
import { db } from "../../db/index.js";
import { Asset, Item, Offer } from "../../models/index.js";
import {
  localizeOffer,
  localizeOffers,
} from "../../utils/offer-localization.js";
import { buildProjection } from "../../utils/projection.js";
import type { Context } from "../index.js";
import { resolveGraphqlLocale } from "../locale.js";
import { clampPage, clampPageSize, MAX_PAGE_SIZE } from "../pagination.js";

const resolvers: IResolvers<any, Context> = {
  Query: {
    item: async (_, { id }, _context, info) => {
      const projection = buildProjection(info, "Item");
      return Item.findOne({ id: { $eq: id } }, projection).lean();
    },
    items: async (_, { limit, page }) => {
      const resolvedLimit = clampPageSize(limit);
      const resolvedPage = clampPage(page);
      const skip = (resolvedPage - 1) * resolvedLimit;
      const elements = await Item.find({}, undefined, {
        limit: resolvedLimit,
        skip,
        sort: { lastModifiedDate: -1 },
      }).lean();
      return {
        elements,
        total: await Item.countDocuments(),
        page: resolvedPage,
        limit: resolvedLimit,
      };
    },
  },
  Item: {
    assets: async (parent, _, { loaders }) => {
      return loaders.itemAssets.load(parent.id);
    },
    builds: async (parent, _, { loaders }) => {
      if (!parent.releaseInfo || parent.releaseInfo.length === 0) return [];
      const appIds = parent.releaseInfo
        .map((r: any) => r.appId)
        .filter(Boolean)
        .slice(0, MAX_PAGE_SIZE);
      if (appIds.length === 0) return [];
      return loaders.build.loadMany(appIds);
    },
    offers: async (parent, { locale: requestedLocale }) => {
      const locale = resolveGraphqlLocale({ locale: requestedLocale });
      // Find offers that contain this item
      const offers = await Offer.find({ "items.id": parent.id })
        .limit(MAX_PAGE_SIZE)
        .lean();
      return localizeOffers(offers, locale);
    },
    mainOffer: async (parent, { locale: requestedLocale }) => {
      const locale = resolveGraphqlLocale({ locale: requestedLocale });
      // Logic from /items/:id/offer
      const subItems = await db.db
        .collection<{ _id: string }>("offersubitems")
        .find({ "subItems.id": parent.id }, { projection: { _id: 1 } })
        .toArray();
      const offerIds = subItems.map((s) => s._id);
      const offers = await Offer.find({
        id: { $in: offerIds },
        offerType: "BASE_GAME",
      }).lean();
      if (offers.length === 0) return null;
      return localizeOffer(
        offers.find((o) => !o.prePurchase) || offers[0],
        locale,
      );
    },
    changelog: async (parent, { limit, page }) => {
      const resolvedLimit = clampPageSize(limit);
      const resolvedPage = clampPage(page);
      const skip = (resolvedPage - 1) * resolvedLimit;
      const assets = await Asset.find({ itemId: parent.id }).lean();
      const assetIds = assets.map((a: any) => a.artifactId);
      const builds = await db.db
        .collection("builds")
        .find({ appName: { $in: assetIds } })
        .toArray();
      const buildIds = builds.map((b) => b._id.toString());
      const allIds = [parent.id, ...assetIds, ...buildIds];

      const matchQuery = { "metadata.contextId": { $in: allIds } };
      const totalCount = await db.db
        .collection("changelogs_v2")
        .countDocuments(matchQuery);
      const elements = await db.db
        .collection("changelogs_v2")
        .find(matchQuery)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(resolvedLimit)
        .toArray();

      return {
        elements,
        totalCount,
        totalPages: Math.ceil(totalCount / resolvedLimit),
        hasNextPage: resolvedPage * resolvedLimit < totalCount,
        hasPreviousPage: resolvedPage > 1,
      };
    },
  },
};

export default resolvers;
