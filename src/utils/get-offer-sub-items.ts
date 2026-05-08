import { db } from "../db/index.js";

type OfferSubItemsDoc = {
  _id: string;
  subItems: Array<{ id: string }>;
};

export const getOfferSubItems = (query: Record<string, unknown>) =>
  db.db
    .collection<OfferSubItemsDoc>("offersubitems")
    .find(query, {
      projection: {
        _id: 1,
        subItems: 1,
      },
    })
    .toArray();
