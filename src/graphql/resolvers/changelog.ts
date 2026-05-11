import { Changelog, Offer, Item, Asset } from "../../models/index.js";
import type { IResolvers } from "@graphql-tools/utils";
import type { Context } from "../index.js";
import { db } from "../../db/index.js";
import { consola } from "../../utils/logger.js";

import { ObjectId } from "mongodb";

const resolvers: IResolvers<any, Context> = {
  Query: {
    changelog: async (_, { id }) => {
      return db.db.collection("changelogs_v2").findOne({ _id: new ObjectId(id) });
    },
  },
  Changelog: {
    document: async (parent) => {
      // parent.document is already populated in some cases or we can use metadata
      if (parent.document) return parent.document;

      const { contextId, contextType } = parent.metadata;
      switch (contextType) {
        case "offer":
          return Offer.findOne({ id: contextId }).lean();
        case "item":
          return Item.findOne({ id: contextId }).lean();
        case "asset":
          return Asset.findOne({ artifactId: contextId }).lean();
        default:
          return null;
      }
    },
  },
  ChangelogDocument: {
    __resolveType(obj: any) {
      if (obj.offerType) return "Offer";
      if (obj.entitlementName) return "Item";
      if (obj.artifactId) return "Asset";
      return null;
    },
  },
  Offer: {
    changelog: async (parent, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const offerId = parent.id || parent._id;

      // Logic from src/routes/offers/data.ts
      const subItems = await db.db.collection("offersubitems").find({ _id: offerId }).toArray();
      const items = await Item.find({
        $or: [
          { id: { $in: [...(parent.items?.map((i: any) => i.id) || []), ...subItems.flatMap((si: any) => si.subItems.map((s: any) => s.id))] } },
          { linkedOffers: offerId }
        ]
      }).lean();

      const assets = await Asset.find({ itemId: { $in: items.map((i: any) => i.id) } }).lean();

      const allIds = [
        offerId,
        ...items.map((i: any) => i.id),
        ...assets.map((a: any) => a.artifactId)
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
};

export default resolvers;
