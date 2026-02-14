import { db as dbInstance } from '../db/index.js';
import { Offer, Sandbox } from '../models/index.js';

const { db } = dbInstance;

export const getProduct = async (offerId: string) => {
  const offer = await Offer.findOne({ id: offerId });

  if (!offer) {
    return null;
  }

  const sandbox = await Sandbox.findOne({ _id: offer.namespace });

  if (!sandbox) {
    return null;
  }

  const product = db.collection('products').findOne({ _id: sandbox.parent });

  return product;
};
