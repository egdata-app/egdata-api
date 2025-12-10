import { Offer, type OfferType } from "@egdata/core.schemas.offers";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { PriceEngine, type PriceEngineType } from "@egdata/core.schemas.price";
import { getCookie } from "hono/cookie";
import { regions } from "../utils/countries.js";

const app = new Hono();

export interface Root {
  _id: string
  eventSlug: string
  moduleIndex: number
  moduleType: string
  title: string
  data: Data
  offers: Offer2[]
  lastUpdated: LastUpdated
  __v: number
}

export interface Data {
  __typename: string
  type: string
  title: string
  offerPresentation: string
  offerType: string
  titleIcon: string
  groupStyle: string
  hideTitle: boolean
  cardType: string
  link: string
  offers: IOffer[]
}

export interface IOffer {
  namespace: string
  id: string
}

export interface Offer2 {
  namespace: string
  id: string
  _id: Id
}

export interface Id {
  $oid: string
}

export interface LastUpdated {
  $date: string
}

const collection = db.db.collection<Root>('storefront-modules');

app.get("/", async (c) => {
    const country = c.req.query("country");
    const cookieCountry = getCookie(c, "EGDATA_COUNTRY");
  
    const selectedCountry = country ?? cookieCountry ?? "US";
  
    // Get the region for the selected country
    const region = Object.keys(regions).find((r) =>
      regions[r].countries.includes(selectedCountry)
    );
  
    if (!region) {
      c.status(404);
      return c.json({
        message: "Country not found",
      });
    }

    const modules = await collection.find({
        eventSlug: "the-game-awards"
    }).toArray();

    const offers = await Offer.find({
        id: {
          $in: modules.flatMap((x) => x.offers.map((y) => y.id))
        }
    });

    const offersMap = new Map(offers.map((x) => [x.id, x]));

    type OfferWithPrice = OfferType & {
        price: PriceEngineType
    };

    const result: {
      title: string,
      offers: OfferWithPrice[]
    }[] = [];

    await Promise.all(modules.map(async (module) => {
      const offers: OfferWithPrice[] = [];

      if (!module.offers.length) {
        return;
      }

      for (const offerId of module.offers) {
        const offer = offersMap.get(offerId.id);
        if (!offer) {
            return;
        }

        const price = await PriceEngine.findOne({
            offerId: offer.id,
            region
        });

        if (!price) {
            return;
        }

        offers.push({
            ...offer.toObject(),
            price: price.toObject()
        });
      }

      result.push({
        title: module.title,
        offers
      });
    }));

    return c.json(result);
});

export default app;
