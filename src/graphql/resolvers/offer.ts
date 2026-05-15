import {
  Offer,
  type OfferType,
  Item,
  Build,
  Franchise,
  FreeGames,
  Ratings,
  Hltb,
  GamePosition,
  TagModel,
  PriceEngine,
  PriceEngineHistorical,
  Tags,
  Sandbox,
  AchievementSet,
} from "../../models/index.js";
import type { IResolvers } from "@graphql-tools/utils";
import type { Context } from "../index.js";
import { buildProjection } from "../../utils/projection.js";
import { regions } from "../../utils/countries.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { db } from "../../db/index.js";
import { attributesToObject } from "../../utils/attributes-to-object.js";
import { getGameFeatures } from "../../utils/game-features.js";
import { getOfferSubItems } from "../../utils/get-offer-sub-items.js";
import { getImage } from "../../utils/get-image.js";
import { ageRatingsCountries } from "../../utils/age-ratings.js";

const resolvers: IResolvers<any, Context> = {
  Query: {
    offer: async (_, { id }, context, info) => {
      const projection = buildProjection(info, "Offer");
      return Offer.findOne({ id }, projection).lean();
    },
    offers: async (_, { limit = 10, page = 1, country = "US" }) => {
      const skip = (page - 1) * limit;
      const region =
        Object.keys(regions).find((r) =>
          regions[r].countries.includes(country),
        ) || "US";

      const elements = await Offer.find({}, undefined, {
        limit,
        skip,
        sort: { lastModifiedDate: -1 },
      }).lean();

      const prices = await PriceEngine.find({
        offerId: { $in: elements.map((o) => o.id) },
        region,
      }).lean();

      return {
        elements: elements.map((o) => {
          const price = prices.find((p) => p.offerId === o.id);
          return {
            ...orderOffersObject(o),
            price: price ?? null,
          };
        }),
        total: await Offer.countDocuments(),
        page,
        limit,
      };
    },
    upcoming: async (_, { limit = 15, page = 1, country = "US" }) => {
      const skip = (page - 1) * limit;
      const region =
        Object.keys(regions).find((r) =>
          regions[r].countries.includes(country),
        ) || "US";

      const elements = await Offer.aggregate([
        {
          $match: {
            releaseDate: {
              $gt: new Date(),
              $ne: null,
              $lt: new Date("2099-01-01"),
            },
            offerType: { $in: ["BASE_GAME", "DLC"] },
          },
        },
        { $sort: { releaseDate: 1 } },
        { $skip: skip },
        { $limit: limit },
      ]);

      return {
        elements: elements.map(orderOffersObject),
        total: await Offer.countDocuments({
          releaseDate: { $gt: new Date() },
        }),
        page,
        limit,
      };
    },
    latestReleased: async (_, { limit = 10, page = 1, country = "US" }) => {
      const skip = (page - 1) * limit;
      const elements = await Offer.find(
        {
          effectiveDate: { $lte: new Date() },
          offerType: { $in: ["BASE_GAME", "DLC"] },
          releaseDate: { $ne: null, $lte: new Date() },
        },
        undefined,
        { sort: { releaseDate: -1 }, limit, skip },
      ).lean();
      return {
        elements: elements.map(orderOffersObject),
        total: await Offer.countDocuments({
          releaseDate: { $ne: null },
          offerType: { $in: ["BASE_GAME"] },
        }),
        page,
        limit,
      };
    },
    topSellers: async (_, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const positions = await GamePosition.find({
        collectionId: "top-sellers",
        position: { $gt: 0 },
      })
        .sort({ position: 1 })
        .limit(limit)
        .skip(skip)
        .lean();
      const offers = await Offer.find({
        id: { $in: positions.map((p) => p.offerId) },
      }).lean();
      const elements = offers
        .map((o) => ({
          ...orderOffersObject(o),
          position: positions.find((p) => p.offerId === o.id)?.position,
        }))
        .sort((a, b) => a.position - b.position);
      return {
        elements,
        total: await GamePosition.countDocuments({
          collectionId: "top-sellers",
          position: { $gt: 0 },
        }),
        page,
        limit,
      };
    },
    topWishlisted: async (_, { limit = 10, page = 1 }) => {
      const skip = (page - 1) * limit;
      const positions = await GamePosition.find({
        collectionId: "top-wishlisted",
        position: { $gt: 0 },
      })
        .sort({ position: 1 })
        .limit(limit)
        .skip(skip)
        .lean();
      const offers = await Offer.find({
        id: { $in: positions.map((p) => p.offerId) },
      }).lean();
      const elements = offers
        .map((o) => ({
          ...orderOffersObject(o),
          position: positions.find((p) => p.offerId === o.id)?.position,
        }))
        .sort((a, b) => a.position - b.position);
      return {
        elements,
        total: await GamePosition.countDocuments({
          collectionId: "top-wishlisted",
          position: { $gt: 0 },
        }),
        page,
        limit,
      };
    },
    featuredDiscounts: async (_, { country = "US" }) => {
      const region =
        Object.keys(regions).find((r) =>
          regions[r].countries.includes(country),
        ) || "US";
      const featured = await GamePosition.find({ position: { $gt: 0 } })
        .sort({ position: 1 })
        .limit(200)
        .lean();
      const offerIds = featured.map((o) => o.offerId);
      const [offers, prices] = await Promise.all([
        Offer.find({
          id: { $in: offerIds },
          offerType: { $in: ["BASE_GAME", "DLC"] },
        }).lean(),
        PriceEngine.find({
          offerId: { $in: offerIds },
          region,
          "price.discount": { $gt: 0 },
        }).lean(),
      ]);
      return offers
        .filter((o) => prices.some((p) => p.offerId === o.id))
        .slice(0, 20)
        .map(orderOffersObject);
    },
    events: async () => {
      return Tags.find({ groupName: "event", status: "ACTIVE" }).lean();
    },
    event: async (_, { id, limit = 10, page = 1, country = "US" }) => {
      const skip = (page - 1) * limit;
      const region =
        Object.keys(regions).find((r) =>
          regions[r].countries.includes(country),
        ) || "US";

      const event = await Tags.findOne({ id: { $eq: id }, groupName: "event" }).lean();
      if (!event) return null;

      const elements = await Offer.aggregate([
        { $match: { tags: { $elemMatch: { id: { $eq: id } } } } },
        {
          $lookup: {
            from: "pricev2",
            let: { offerId: "$id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$offerId", "$$offerId"] },
                      { $eq: ["$region", region] },
                    ],
                  },
                },
              },
              { $sort: { updatedAt: -1 } },
              { $limit: 1 },
            ],
            as: "price",
          },
        },
        { $unwind: { path: "$price", preserveNullAndEmptyArrays: true } },
        { $sort: { "price.price.discount": -1 } },
        { $skip: skip },
        { $limit: limit },
      ]);

      return {
        elements: elements.map(orderOffersObject),
        total: await Offer.countDocuments({ tags: { $elemMatch: { id: { $eq: id } } } }),
        page,
        limit,
      };
    },
    genres: async () => {
      const genres = await Tags.find({
        groupName: "genre",
        status: "ACTIVE",
      }).lean();
      return Promise.all(
        genres.map(async (genre) => {
          const offers = await Offer.find(
            {
              tags: { $elemMatch: { id: genre.id } },
              offerType: "BASE_GAME",
              releaseDate: { $lte: new Date() },
            },
            undefined,
            { limit: 3, sort: { releaseDate: -1 } },
          ).lean();
          return {
            genre,
            offers: offers.map((o) => ({
              id: o.id,
              title: o.title,
              image: getImage(o.keyImages, [
                "OfferImageTall",
                "Thumbnail",
                "DieselGameBoxTall",
                "DieselStoreFrontTall",
              ]),
            })),
          };
        }),
      );
    },
    latestAchievements: async (_, { country = "US" }) => {
      const region =
        Object.keys(regions).find((r) =>
          regions[r].countries.includes(country),
        ) || "US";
      const limit = 15;
      let skip = 0;
      let result: any[] = [];
      while (result.length < 20) {
        const offers = await Offer.find({
          offerType: { $in: ["BASE_GAME"] },
          "tags.id": "19847",
          effectiveDate: { $lte: new Date() },
        })
          .sort({ effectiveDate: -1 })
          .skip(skip)
          .limit(limit)
          .lean();

        if (offers.length === 0) break;

        const [achievements, prices] = await Promise.all([
          AchievementSet.find({
            sandboxId: { $in: offers.map((o) => o.namespace) },
            isBase: true,
          }).lean(),
          PriceEngine.find({
            offerId: { $in: offers.map((o) => o.id) },
            region,
          }).lean(),
        ]);

        const pageResults = offers
          .map((o) => {
            const achievement = achievements.find(
              (a) => a.sandboxId === o.namespace,
            );
            if (!achievement) return null;
            return orderOffersObject(o);
          })
          .filter(Boolean);

        result = result.concat(pageResults);
        skip += limit;
        if (offers.length < limit) break;
      }
      return result.slice(0, 20);
    },
  },
  Offer: {
    items: async (parent, _, { loaders }) => {
      if (!parent.items || parent.items.length === 0) {
        const subItemsDoc = await loaders.offerSubItems.load(parent.id);
        if (!subItemsDoc || !subItemsDoc.subItems) return [];
        const subItemIds = subItemsDoc.subItems.map((s: any) => s.id);
        return loaders.item.loadMany(subItemIds);
      }
      return loaders.item.loadMany(parent.items.map((i: any) => i.id));
    },
    price: async (parent, { country }, { loaders }) => {
      const selectedCountry = country || "US";
      const region =
        Object.keys(regions).find((r) =>
          regions[r].countries.includes(selectedCountry),
        ) || "US";
      return loaders.price.load({ offerId: parent.id, region });
    },
    franchises: async (parent) => {
      return Franchise.find({ offers: parent.id }).lean();
    },
    giveaways: async (parent) => {
      return FreeGames.find({ id: parent.id }).sort({ startDate: -1 }).lean();
    },
    related: async (parent, { country }) => {
      const related = await Offer.find({
        namespace: parent.namespace,
        id: { $ne: parent.id },
      })
        .limit(25)
        .lean();
      return related.map(orderOffersObject);
    },
    suggestions: async (parent, { country }) => {
      const tagsIds = parent.tags?.map((t: any) => t.id) || [];
      if (tagsIds.length === 0) return [];
      const tagsInfo = await TagModel.find({
        id: { $in: tagsIds },
        groupName: "genre",
      }).lean();
      const genreIds = tagsInfo.map((t) => t.id);
      const suggestions = await Offer.find({
        tags: { $elemMatch: { id: { $in: genreIds } } },
        id: { $ne: parent.id },
        namespace: { $ne: parent.namespace },
        offerType: { $in: ["BASE_GAME", "DLC"] },
      })
        .sort({ lastModifiedDate: -1 })
        .limit(25)
        .lean();
      return suggestions.map(orderOffersObject);
    },
    ratings: async (parent) => {
      const sandbox = await Sandbox.findOne({ _id: parent.namespace }).lean();
      if (!sandbox || !sandbox.parent) return null;
      const product = await db.db
        .collection("products")
        .findOne({ _id: { $eq: sandbox.parent } });
      if (!product) return null;
      return Ratings.findOne({ _id: product.slug }).lean();
    },
    polls: async (parent) => {
      return db.db
        .collection("ratings_polls")
        .findOne({ _id: { $eq: parent.namespace } });
    },
    hltb: async (parent) => {
      return Hltb.findOne({ _id: { $eq: parent.id } }).lean();
    },
    sandbox: async (parent, _, { loaders }) => {
      return loaders.sandbox.load(parent.namespace);
    },
    positions: async (parent) => {
      const pos = await GamePosition.find({ offerId: parent.id }).lean();
      return Object.fromEntries(pos.map((p) => [p.collectionId, p.position]));
    },
    ageRating: async (parent, { country = "US" }) => {
      const sandbox = await Sandbox.findOne({ _id: { $eq: parent.namespace } }).lean();
      if (!sandbox || !sandbox.ageGatings) return null;

      const selectedRating =
        Object.entries(ageRatingsCountries).find(([, rating]) =>
          rating.includes(country),
        )?.[0] ?? "Generic";

      return sandbox.ageGatings[selectedRating] || null;
    },
    features: async (parent) => {
      const subItems = await getOfferSubItems({ _id: parent.id });
      const items = await Item.find({
        $or: [
          {
            id: {
              $in: [
                ...(parent.items?.map((i: any) => i.id) || []),
                ...subItems.flatMap((i) => i.subItems.map((s) => s.id)),
              ],
            },
          },
          { linkedOffers: parent.id },
        ],
      }).lean();

      const customAttributes = items.reduce((acc, item) => {
        return Object.assign(
          acc,
          attributesToObject(item.customAttributes as any),
        );
      }, attributesToObject([]));

      const tagsObject = (parent.tags || []).reduce((acc: any, tag: any) => {
        acc[tag.id] = tag;
        return acc;
      }, {});

      return getGameFeatures({
        attributes: customAttributes,
        tags: tagsObject,
      });
    },
  },
};

export default resolvers;
