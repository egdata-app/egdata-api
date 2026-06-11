import { type Document, type Filter, ObjectId } from "mongodb";
import { db } from "../db/index.js";
import { Asset, Item, Offer } from "../models/index.js";

type ContextDocument = Record<string, unknown> & {
  toObject?: () => Record<string, unknown>;
};

const toPlainContext = (document: ContextDocument | null) => {
  if (!document) {
    return null;
  }

  if (typeof document.toObject === "function") {
    return document.toObject();
  }

  return document;
};

const buildIdFilter = (contextId: string): Filter<Document> => {
  if (!ObjectId.isValid(contextId)) {
    return { _id: { $eq: contextId } } as unknown as Filter<Document>;
  }

  return {
    $or: [{ _id: new ObjectId(contextId) }, { _id: { $eq: contextId } }],
  } as unknown as Filter<Document>;
};

export const resolveChangelogContext = async (
  contextType?: string,
  contextId?: string,
) => {
  if (!contextType || !contextId) {
    return null;
  }

  switch (contextType) {
    case "offer":
      return toPlainContext(
        await Offer.findOne(
          { id: { $eq: contextId } },
          {
            id: 1,
            title: 1,
            keyImages: 1,
            offerType: 1,
            namespace: 1,
          },
        ),
      );
    case "item":
      return toPlainContext(
        await Item.findOne(
          { id: { $eq: contextId } },
          {
            id: 1,
            title: 1,
            keyImages: 1,
            namespace: 1,
          },
        ),
      );
    case "asset":
      return toPlainContext(
        await Asset.findOne(
          {
            // Changelog producers may store either asset.artifactId or asset.id.
            $or: [
              { artifactId: { $eq: contextId } },
              { id: { $eq: contextId } },
            ],
          },
          {
            id: 1,
            artifactId: 1,
            namespace: 1,
          },
        ),
      );
    case "build":
      return toPlainContext(
        await db.db.collection("builds").findOne(buildIdFilter(contextId), {
          projection: {
            _id: 1,
            appName: 1,
            buildVersion: 1,
          },
        }),
      );
    default:
      return null;
  }
};

export const resolveChangelogContextSafely = async (
  contextType?: string,
  contextId?: string,
) => {
  try {
    return await resolveChangelogContext(contextType, contextId);
  } catch {
    return null;
  }
};
