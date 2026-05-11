import { Build, Asset, Item } from '../../models/index.js';
import type { IResolvers } from '@graphql-tools/utils';
import type { Context } from '../index.js';
import { db } from '../../db/index.js';
import { ObjectId } from 'mongodb';

const resolvers: IResolvers<any, Context> = {
    Query: {
        build: async (_, { id }) => {
            return db.db.collection("builds").findOne({ _id: new ObjectId(id) });
        },
        builds: async (_, { limit = 10, page = 1, sortBy = "createdAt", sortDir = "desc" }) => {
            const skip = (page - 1) * limit;
            const sort: any = { [sortBy]: sortDir === "asc" ? 1 : -1 };
            return db.db.collection("builds").find().sort(sort).skip(skip).limit(limit).toArray();
        }
    },
    Build: {
        downloadSizeBytes: async (parent) => {
            if (parent.downloadSizeBytes !== undefined) return parent.downloadSizeBytes;
            const platform = parent.labelName?.split("-")[1];
            if (!platform) return null;
            const asset = await Asset.findOne({ artifactId: parent.appName, platform }).lean();
            return asset?.downloadSizeBytes || null;
        },
        installedSizeBytes: async (parent) => {
            if (parent.installedSizeBytes !== undefined) return parent.installedSizeBytes;
            const platform = parent.labelName?.split("-")[1];
            if (!platform) return null;
            const asset = await Asset.findOne({ artifactId: parent.appName, platform }).lean();
            return asset?.installedSizeBytes || null;
        },
        items: async (parent) => {
            return Item.find({ "releaseInfo.appId": parent.appName }).lean();
        },
        files: async (parent, { limit = 25, page = 1, sort = "depth", dir = "asc", q, extension }) => {
            const skip = (page - 1) * limit;
            const query: any = { manifestHash: parent.hash };
            const sortQuery: any = {};

            if (q && extension) {
                const extensions = extension.split(",");
                query.$and = [
                    { fileName: { $regex: new RegExp(q, "i") } },
                    { fileName: { $regex: new RegExp(`\\.(${extensions.join("|")})$`, "i") } },
                ];
            } else if (q) {
                query.fileName = { $regex: new RegExp(q, "i") };
            } else if (extension) {
                const extensions = extension.split(",");
                query.fileName = { $regex: new RegExp(`\\.(${extensions.join("|")})$`, "i") };
            }

            if (sort === "depth") {
                sortQuery.depth = dir === "asc" ? 1 : -1;
                sortQuery.fileName = dir === "asc" ? 1 : -1;
            } else if (sort === "fileName") {
                sortQuery.fileName = dir === "asc" ? 1 : -1;
            } else if (sort === "fileSize") {
                sortQuery.fileSize = dir === "asc" ? 1 : -1;
            }

            const elements = await db.db.collection("files").find(query).sort(sortQuery).skip(skip).limit(limit).toArray();
            const total = await db.db.collection("files").countDocuments(query);

            return { elements, total, page, limit };
        },
        installOptions: async (parent) => {
            const filesWithInstallOptions = await db.db
                .collection<{
                    manifestHash: string;
                    installTags: string[];
                    fileHash: string;
                    fileSize: number;
                }>("files")
                .find({
                    manifestHash: parent.hash,
                    installTags: {
                        $exists: true,
                        $not: { $size: 0 },
                    },
                })
                .toArray();

            const result: Record<string, { files: number; size: number }> = {};

            for (const file of filesWithInstallOptions) {
                for (const installOption of file.installTags) {
                    if (!result[installOption]) {
                        result[installOption] = { files: 0, size: 0 };
                    }
                    result[installOption].files++;
                    result[installOption].size += file.fileSize;
                }
            }

            return result;
        }
    }
};

export default resolvers;
