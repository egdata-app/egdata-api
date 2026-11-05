import type { Context } from "hono";
import type { OfferType, PriceEngineType } from "../models/index.js";
import {
  type LocalizedOfferMetadata,
  localizeOffers,
} from "./offer-localization.js";
import { orderOffersObject } from "./order-offers-object.js";

/**
 * Full offer representation returned by list endpoints.
 *
 * Kept under the old OfferCard name so route wiring stays stable. The compact
 * card experiment was reverted after the frontend relied on fields such as
 * `tags`, `items`, `offerMappings`, and the complete key image set.
 */
export type OfferCard = OfferType & {
  price?: PriceEngineType | null;
};

export const toOfferCard = (
  offer: OfferType,
  price?: PriceEngineType | null,
): OfferCard => ({
  ...orderOffersObject(offer),
  price: price ?? null,
});

export const toOfferCards = async <T extends OfferType>(
  offers: readonly T[],
  locale: string,
  priceByOfferId?: Map<string, PriceEngineType | null>,
) =>
  localizeOffers(
    offers.map((offer) =>
      toOfferCard(offer, priceByOfferId?.get(offer.id) ?? null),
    ),
    locale,
  ) as Promise<Array<OfferCard & LocalizedOfferMetadata>>;

/**
 * Escape hatch retained for clients that explicitly request the pre-card code
 * path. Both branches now return full offer documents.
 */
export const wantsExpandedOffers = (c: Context) => {
  const value = c.req.query("expand")?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "full";
};
