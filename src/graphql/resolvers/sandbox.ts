import { Namespace, Item, Offer, Asset, AchievementSet, Build } from '../../models/index.js';
import type { IResolvers } from '@graphql-tools/utils';
import type { Context } from '../index.js';
import { buildProjection } from '../../utils/projection.js';
import { db } from '../../db/index.js';
import { orderOffersObject } from '../../utils/order-offers-object.js';
import { regions } from '../../utils/countries.js';
import { ObjectId } from 'mongodb';

const resolvers: IResolvers<any, Context> = {
    Query: {
        sandbox: async (_, { id }, context, info) => {
            // Namespace model uses _id for namespace string
            return Namespace.findOne({ _id: { $eq: id } }).lean();
        },
        sandboxes: async (_, { limit = 10, page = 1 }) => {
            const skip = (page - 1) * limit;
            const elements = await Namespace.find({}, undefined, { skip, limit }).lean();
            return { elements, total: await Namespace.countDocuments(), page, limit };
        }
    },
    Sandbox: {
        items: async (parent, { limit = 10, page = 1 }) => {
            const skip = (page - 1) * limit;
            const query = { namespace: parent._id };
            const elements = await Item.find(query).sort({ lastModified: -1 }).skip(skip).limit(limit).lean();
            return { elements, total: await Item.countDocuments(query), page, limit };
        },
        offers: async (parent, { limit = 10, page = 1 }) => {
            const skip = (page - 1) * limit;
            const query = { namespace: parent._id };
            const elements = await Offer.find(query).sort({ lastModified: -1 }).skip(skip).limit(limit).lean();
            return { elements: elements.map(orderOffersObject), total: await Offer.countDocuments(query), page, limit };
        },
        assets: async (parent, { limit = 10, page = 1, platform }) => {
            const skip = (page - 1) * limit;
            const sandboxId = parent._id;

            // Logic from src/routes/sandbox.ts
            const items = await Item.find(
                { namespace: sandboxId },
                { id: 1, namespace: 1, releaseInfo: 1, title: 1 }
            ).lean();

            const realAssets = await Asset.find({ namespace: sandboxId }).sort({ updatedAt: -1 }).lean();
            const realAssetsMap = new Map(realAssets.map((a: any) => [a.artifactId, a]));

            const virtualAssets = items.flatMap((item: any) =>
                item.releaseInfo?.flatMap((releaseInfo: any) => {
                    if (realAssetsMap.has(releaseInfo.appId)) return [];
                    return releaseInfo.platform.map((p: string) => ({
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
                }) || []
            );

            let allAssets = [...realAssets, ...virtualAssets].sort((a: any, b: any) => {
                const dateA = a.updatedAt || new Date(0);
                const dateB = b.updatedAt || new Date(0);
                return dateB.getTime() - dateA.getTime();
            });

            if (platform) {
                const platforms = platform.split(",");
                allAssets = allAssets.filter((a: any) => platforms.includes(a.platform));
            }

            const elements = allAssets.slice(skip, skip + limit);

            return { elements, total: allAssets.length, page, limit, count: allAssets.length };
        },
        builds: async (parent, { limit = 10, page = 1, platform }) => {
            const skip = (page - 1) * limit;
            const items = await Item.find({ namespace: parent._id }, { releaseInfo: 1 }).lean();
            const appIds = items.flatMap((i: any) => i.releaseInfo.map((r: any) => r.appId));
            const query: any = { appName: { $in: appIds } };
            // Platform filter for builds might need mapping appId to builds
            const elements = await db.db.collection("builds").find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray();
            return { elements, total: await db.db.collection("builds").countDocuments(query), page, limit };
        },
        baseGame: async (parent, { country = 'US' }) => {
            const region = Object.keys(regions).find(r => regions[r].countries.includes(country)) || 'US';
            let baseGame = await Offer.findOne({ namespace: parent._id, offerType: "BASE_GAME", prePurchase: { $ne: true }, isCodeRedemptionOnly: false }).lean();
            if (!baseGame) baseGame = await Offer.findOne({ namespace: parent._id, offerType: "BASE_GAME", prePurchase: true }).lean();
            if (!baseGame) {
                const executable = await Item.findOne({ namespace: parent._id, entitlementType: "EXECUTABLE", "releaseInfo.0": { $exists: true } }).lean();
                return executable;
            }
            return orderOffersObject(baseGame);
        },
        achievements: async (parent, _, { loaders }) => {
            return loaders.achievementSet.load(parent._id);
        },
        stats: async (parent) => {
            const [offers, items, achievements, assets] = await Promise.all([
                Offer.countDocuments({ namespace: parent._id }),
                Item.find({ namespace: parent._id }).lean(),
                AchievementSet.find({ sandboxId: parent._id }).lean(),
                Asset.find({ namespace: parent._id }).lean()
            ]);

            const assetsMap = new Map(assets.map((a: any) => [a.artifactId, a]));
            let virtualAssetsCount = 0;
            for (const item of items as any[]) {
                for (const releaseInfo of item.releaseInfo || []) {
                    if (!assetsMap.has(releaseInfo.appId)) {
                        virtualAssetsCount += releaseInfo.platform?.length || 0;
                    }
                }
            }

            return {
                offers,
                items: items.length,
                assets: assets.length + virtualAssetsCount,
                achievements: achievements.flatMap((a: any) => a.achievements || []).length
            };
        },
        changelog: async (parent, { limit = 10, page = 1 }) => {
            const skip = (page - 1) * limit;
            const sandboxId = parent._id;

            const offers = await db.db.collection("offers").find({ namespace: sandboxId }).sort({ lastModifiedDate: -1 }).limit(100).toArray();
            const items = await Item.find({ $or: [{ id: { $in: offers.flatMap((o: any) => o.items.map((i: any) => i.id)) } }, { namespace: sandboxId }] }, { id: 1, releaseInfo: 1 }).limit(100).lean();
            const assets = await Asset.find({ itemId: { $in: items.map((i: any) => i.id) } }).lean();
            const buildAppIds = items.flatMap((i: any) => i.releaseInfo?.map((r: any) => r.appId) || []);
            const builds = await db.db.collection("builds").find({ appName: { $in: buildAppIds } }).toArray();

            const allIds = [
                sandboxId,
                ...offers.map((o: any) => o.id),
                ...items.map((i: any) => i.id),
                ...assets.map((a: any) => a.artifactId),
                ...builds.map((b: any) => b._id.toString())
            ];

            const matchQuery = { "metadata.contextId": { $in: allIds } };
            const totalCount = await db.db.collection("changelogs_v2").countDocuments(matchQuery);
            const elements = await db.db.collection("changelogs_v2").find(matchQuery).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray();

            return {
                elements,
                totalCount,
                totalPages: Math.ceil(totalCount / limit),
                hasNextPage: page * limit < totalCount,
                hasPreviousPage: page > 1
            };
        }
    },
    BaseGameResult: {
        __resolveType(obj: any) {
            if (obj.offerType) return 'Offer';
            if (obj.entitlementName) return 'Item';
            return null;
        }
    }
};

export default resolvers;
