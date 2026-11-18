import { db as dbInstance } from '../db/index.js';
import { Offer, Sandbox } from '../models/index.js';

export const getProduct = async (offerId: string) => {
  const offer = await Offer.findOne({ id: { $eq: offerId } });

  if (!offer) {
    return null;
  }

  const sandbox = await Sandbox.findOne({ _id: { $eq: offer.namespace } });

  if (!sandbox) {
    return null;
  }

  return dbInstance.db.collection('products').findOne({ _id: { $eq: sandbox.parent } });
};
