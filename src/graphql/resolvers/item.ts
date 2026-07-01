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

const resolvers: IResolvers<any, Context> = {
  Query: {
    item: async (_, { id }, _context, info) => {
      const projection = buildProjection(info, "Item");
      return Item.findOne({ id: { $eq: id } }, projection).lean();
    },
    items: async (_, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const elements = await Item.find({}, undefined, {
        limit,
        skip,
        sort: { lastModifiedDate: -1 },
      }).lean();
      return { elements, total: await Item.countDocuments(), page, limit };
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
        .filter(Boolean);
      if (appIds.length === 0) return [];
      return loaders.build.loadMany(appIds);
    },
    offers: async (parent, { locale: requestedLocale }) => {
      const locale = resolveGraphqlLocale({ locale: requestedLocale });
      // Find offers that contain this item
      const offers = await Offer.find({ "items.id": parent.id }).lean();
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
    changelog: async (parent, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
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
};

export default resolvers;
