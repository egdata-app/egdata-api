import DataLoader from 'dataloader';
import { PriceEngine, Item, Build, Sandbox, Franchise, AchievementSet, Asset } from '../models/index.js';

export const createLoaders = (db: any) => {
    return {
        // Load Price by OfferID and Region
        price: new DataLoader(async (keys: readonly { offerId: string; region: string }[]) => {
            const offerIds = keys.map(k => k.offerId);
            const regions = [...new Set(keys.map(k => k.region))];
            
            const prices = await PriceEngine.find({
                offerId: { $in: offerIds },
                region: { $in: regions }
            }).lean();

            return keys.map(key => 
                prices.find(p => p.offerId === key.offerId && p.region === key.region) || null
            );
        }),

        // Load Items by ID
        item: new DataLoader(async (ids: readonly string[]) => {
            const items = await Item.find({ id: { $in: ids } }).lean();
            const itemMap = new Map(items.map(i => [i.id, i]));
            return ids.map(id => itemMap.get(id) || null);
        }),

        // Load OfferSubItems by OfferID
        offerSubItems: new DataLoader(async (offerIds: readonly string[]) => {
            const subItems = await db.collection("offersubitems").find({ _id: { $in: offerIds } }).toArray();
            const subItemsMap = new Map(subItems.map(si => [si._id, si]));
            return offerIds.map(id => subItemsMap.get(id) || null);
        }),

        // Load Builds by appName (often used as contextId/appId in relationships)
        build: new DataLoader(async (appNames: readonly string[]) => {
            const builds = await db.collection("builds").find({ appName: { $in: appNames } }).toArray();
            const buildMap = new Map();
            builds.forEach(b => {
                if (!buildMap.has(b.appName) || new Date(b.updatedAt) > new Date(buildMap.get(b.appName).updatedAt)) {
                    buildMap.set(b.appName, b);
                }
            });
            return appNames.map(name => buildMap.get(name) || null);
        }),

        // Load Sandboxes by namespace
        sandbox: new DataLoader(async (namespaces: readonly string[]) => {
            const sandboxes = await db.collection("sandboxes").find({ _id: { $in: namespaces } }).toArray();
            const sandboxMap = new Map(sandboxes.map(s => [s._id, s]));
            return namespaces.map(ns => sandboxMap.get(ns) || null);
        }),

        // Load AchievementSets by sandboxId
        achievementSet: new DataLoader(async (sandboxIds: readonly string[]) => {
            const sets = await AchievementSet.find({ sandboxId: { $in: sandboxIds } }).lean();
            const setsMap = new Map();
            sets.forEach(s => {
                if (!setsMap.has(s.sandboxId)) setsMap.set(s.sandboxId, []);
                setsMap.get(s.sandboxId).push(s);
            });
            return sandboxIds.map(id => setsMap.get(id) || []);
        }),

        // Load Assets by itemId
        itemAssets: new DataLoader(async (itemIds: readonly string[]) => {
            const assets = await Asset.find({ itemId: { $in: itemIds } }).lean();
            const assetsMap = new Map();
            assets.forEach(a => {
                if (!assetsMap.has(a.itemId)) assetsMap.set(a.itemId, []);
                assetsMap.get(a.itemId).push(a);
            });
            return itemIds.map(id => assetsMap.get(id) || []);
        })
    };
};
