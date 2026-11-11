import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/index.js";
import { Offer, PriceEngine } from "../../models/index.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { ProblemError, problemResponse } from "../errors.js";
import { parseStrictQuery, regionalParams } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import { serializeOffer } from "../serialization.js";

type StorefrontModule = {
  eventSlug?: string;
  moduleIndex?: number;
  moduleType?: string;
  title?: string;
  offers?: Array<{ id?: string }>;
};

const app = new Hono<{ Variables: V1Variables }>();

const EVENT_SLUG = "the-game-awards";

app.get("/game-awards", async (c) => {
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    locale: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);

  const data = await cached(
    v1CacheKey("game-awards.modules", { region, locale }),
    60,
    async () => {
      const modules = await db.db
        .collection<StorefrontModule>("storefront-modules")
        .find({ eventSlug: EVENT_SLUG })
        .sort({ moduleIndex: 1 })
        .toArray();

      const offerIds = Array.from(
        new Set(
          modules.flatMap((module) =>
            (module.offers ?? [])
              .map((offer) => offer.id)
              .filter((id): id is string => typeof id === "string"),
          ),
        ),
      );

      const [offers, prices] = await Promise.all([
        Offer.find({ id: { $in: offerIds } }).lean(),
        PriceEngine.find({ offerId: { $in: offerIds }, region }).lean(),
      ]);
      const offerById = new Map(
        offers.map((offer) => [String(offer.id), offer]),
      );
      const priceByOfferId = new Map(
        prices.map((price) => [String(price.offerId), price]),
      );

      return Promise.all(
        modules
          .filter((module) => (module.offers ?? []).length > 0)
          .map(async (module) => {
            const moduleOffers = (module.offers ?? [])
              .map((offer) =>
                offer.id ? offerById.get(String(offer.id)) : undefined,
              )
              .filter((offer): offer is NonNullable<typeof offer> =>
                Boolean(offer),
              );

            const localized = await localizeOffers(
              moduleOffers.map((offer) => ({
                ...orderOffersObject(offer),
                price: priceByOfferId.get(String(offer.id)) ?? null,
              })),
              locale,
            );

            return {
              title: String(module.title ?? "").trim(),
              moduleIndex: module.moduleIndex ?? null,
              moduleType: module.moduleType ?? null,
              offers: localized.map((offer) =>
                serializeOffer(offer, { price: offer.price }),
              ),
            };
          }),
      );
    },
  );

  return jsonSuccess(c, data, {
    country,
    region,
    locale,
    eventSlug: EVENT_SLUG,
  });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
