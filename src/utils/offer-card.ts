import type { Context } from "hono";
import type { OfferType, PriceEngineType } from "../models/index.js";
import { getImage } from "./get-image.js";
import {
  type LocalizedOfferMetadata,
  localizeOffers,
} from "./offer-localization.js";

export type OfferCardKeyImage = {
  type?: string;
  url?: string;
  md5?: string;
};

export type OfferCard = {
  id?: string;
  namespace?: string;
  title?: string;
  offerType?: string;
  productSlug?: string | null;
  urlSlug?: string | null;
  keyImages: OfferCardKeyImage[];
  seller?: { id?: string; name?: string } | null;
  developerDisplayName?: string | null;
  publisherDisplayName?: string | null;
  releaseDate?: Date | null;
  effectiveDate?: Date | null;
  lastModifiedDate?: Date | null;
  prePurchase?: boolean | null;
  price?: PriceEngineType | null;
};

const CARD_IMAGE_TYPES = [
  "OfferImageTall",
  "Thumbnail",
  "DieselGameBoxTall",
  "DieselStoreFrontTall",
  "OfferImageWide",
  "DieselStoreFrontWide",
  "DieselGameBoxWide",
  "Featured",
];

const MAX_CARD_IMAGES = 4;

const pickCardImages = (keyImages: unknown): OfferCardKeyImage[] => {
  const images = Array.isArray(keyImages)
    ? (keyImages as OfferCardKeyImage[]).filter((image) => image?.url)
    : [];
  if (images.length === 0) {
    return [];
  }

  const picked: OfferCardKeyImage[] = [];
  const seen = new Set<string>();

  const add = (image: OfferCardKeyImage | undefined) => {
    if (
      !image?.url ||
      seen.has(image.url) ||
      picked.length >= MAX_CARD_IMAGES
    ) {
      return;
    }
    seen.add(image.url);
    picked.push(image);
  };

  for (const type of CARD_IMAGE_TYPES) {
    add(images.find((image) => image.type === type));
  }

  const primary = getImage(images as never, ["OfferImageTall", "Thumbnail"]);
  add(primary);

  for (const image of images) {
    add(image);
  }

  return picked;
};

/**
 * Compact list/card representation of an offer.
 *
 * List endpoints intentionally omit longDescription, customAttributes, items,
 * tags, offerMappings, country lists, and the full key image set. Detail
 * endpoints (GET /offers/{id}) keep returning the complete document.
 */
export const toOfferCard = (
  offer: OfferType,
  price?: PriceEngineType | null,
): OfferCard => ({
  id: offer.id,
  namespace: offer.namespace,
  title: offer.title,
  offerType: offer.offerType,
  productSlug: offer.productSlug ?? null,
  urlSlug: offer.urlSlug ?? null,
  keyImages: pickCardImages(offer.keyImages),
  seller: offer.seller
    ? {
        id: offer.seller.id,
        name: offer.seller.name,
      }
    : null,
  developerDisplayName: offer.developerDisplayName ?? null,
  publisherDisplayName: offer.publisherDisplayName ?? null,
  releaseDate: offer.releaseDate ?? null,
  effectiveDate: offer.effectiveDate ?? null,
  lastModifiedDate: offer.lastModifiedDate ?? null,
  prePurchase: offer.prePurchase ?? null,
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
 * Escape hatch for clients that still need the full offer documents from a
 * list endpoint: `?expand=true` (or `expand=full`).
 */
export const wantsExpandedOffers = (c: Context) => {
  const value = c.req.query("expand")?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "full";
};
