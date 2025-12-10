import { Offer, type OfferType } from "@egdata/core.schemas.offers";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { PriceEngine, type PriceEngineType } from "@egdata/core.schemas.price";
import { getCookie } from "hono/cookie";
import { regions } from "../utils/countries.js";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";

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

app.get("/og", async (c) => {
  const svg = await satori(
    React.createElement(
      "div",
      {
        style: {
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#001B3D",
          fontFamily: "Roboto, sans-serif",
          position: "relative",
          overflow: "hidden",
          padding: "48px",
        },
      },
      [
        React.createElement("div", {
          key: "bg-gradient",
          style: {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background:
              "linear-gradient(135deg, rgba(0, 27, 61, 1) 0%, rgba(0, 9, 19, 1) 100%)",
          },
        }),
        // Header Row: TGA Icon ON Egdata Icon
        React.createElement(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "32px",
              marginBottom: "48px",
            },
          },
          [
            // TGA Icon
            React.createElement(
              "svg",
              {
                width: "360",
                viewBox: "0 0 200 68",
                style: {
                  color: "#FF9F59",
                },
              },
              [
                "M49.9535 48.3579L62.8789 35.425L66.2507 24.179L49.9535 40.4857V48.3579Z",
                "M3.87183 11.246L33.0943 40.4857V48.3579L37.0281 44.4218L41.5239 48.9202V56.7924L45.4577 52.8563L53.6288 61.0322L55.8542 55.3867L0.5 0L3.87183 11.246Z",
                "M11.1775 35.425L24.6648 48.9202L18.2021 55.3867L20.4275 61.0322L28.5986 52.8563L33.0944 57.3547L22.9789 67.4762H30.8465L37.0282 61.2909L43.2098 67.4762H51.0774L7.80564 24.179L11.1775 35.425Z",
                "M41.5239 32.0512V39.9234L70.1845 11.246L73.5563 0L41.5239 32.0512Z",
                "M95.9004 20.1356V4.08465H101.765V0H85.7523V4.08465H91.6457V20.1356H95.9004Z",
                "M93.8351 44.0946C99.5272 44.0946 103.782 40.1825 103.782 34.4007C103.782 33.6528 103.724 32.6461 103.609 32.0708H93.8126V36.1842H99.3835C98.7223 38.4566 96.7386 39.9524 94.1513 39.9524C90.529 39.9524 88.0279 37.2772 88.0279 33.7391C88.0279 30.201 90.529 27.5259 93.8351 27.5259C95.9337 27.5259 97.9461 28.6189 98.5785 30.3449H103.408C102.805 26.6629 98.636 23.3837 93.8351 23.3837C88.0279 23.3837 83.6582 27.8423 83.6582 33.7391C83.6582 39.636 88.0279 44.0946 93.8351 44.0946Z",
                "M115.124 23.6714H111.674L103.711 43.8069H108.224L109.518 40.4414H117.251L118.516 43.8069H123.144L115.124 23.6714ZM110.955 36.7307L113.399 30.3449L115.814 36.7307H110.955Z",
                "M95.4252 47.3427H91.9754L84.0121 67.4783H88.5256L89.8193 64.1128H97.5526L98.8175 67.4783H103.446L95.4252 47.3427ZM91.2567 60.4021L93.7003 54.0162L96.1151 60.4021H91.2567Z",
                "M126.137 47.3427L120.954 60.287L116.785 47.3427H113.364L109.196 60.287L103.954 47.3427H99.4122L107.384 67.4782H110.834L115.031 54.5339L119.257 67.4782H122.679L130.593 47.3427H126.137Z",
                "M138.059 47.3427H134.609L126.646 67.4783H131.16L132.453 64.1128H140.186L141.451 67.4783H146.08L138.059 47.3427ZM133.891 60.4021L136.334 54.0162L138.749 60.4021H133.891Z",
                "M147.849 67.4783H152.104V59.798H154.289L158.831 67.4783H164.006L158.716 59.1364C160.729 58.1584 161.936 56.1736 161.936 53.556C161.936 50.1042 158.975 47.3427 155.583 47.3427H147.849V67.4783ZM152.104 55.7134V51.4561H155.468C156.704 51.4561 157.652 52.3479 157.652 53.556C157.652 54.7641 156.704 55.7134 155.468 55.7134H152.104Z",
                "M172.492 47.3427H165.592V67.4783H172.492C178.27 67.4783 182.669 63.1635 182.669 57.3242C182.669 51.6 178.27 47.3427 172.492 47.3427ZM169.847 63.3937V51.4274H172.779C175.999 51.4274 178.299 53.9012 178.299 57.3242C178.299 60.8048 175.97 63.3937 172.779 63.3937H169.847Z",
                "M192.169 67.766C196.424 67.766 199.558 65.1196 199.558 61.5527C199.558 53.8724 188.921 56.3174 188.921 52.9807C188.921 51.8013 189.927 51.0822 191.537 51.0822C193.377 51.0822 194.498 52.2328 194.527 53.7573H198.925C198.925 50.2192 196.654 47.0551 191.681 47.0551C187.713 47.0551 184.752 49.5576 184.752 53.0095C184.752 60.3733 195.332 57.9858 195.332 61.5527C195.332 62.8759 194.038 63.7388 192.169 63.7388C190.157 63.7388 188.748 62.5882 188.748 60.8048H184.551C184.551 64.8319 187.771 67.766 192.169 67.766Z",
                "M149.768 23.6714V43.8069H162.072V39.7223H154.023V35.465H161.21V31.3804H154.023V27.756H162.072V23.6714H149.768Z",
                "M117.557 0V7.68028H108.99V0H104.735V20.1356H108.99V11.7649H117.557V20.1356H121.812V0H117.557Z",
                "M124.865 43.8069H129.12V31.9845L134.122 43.8069H137.227L142.344 31.9845V43.8069H146.628V23.6714H142.258L135.991 37.5361L130.04 23.6714H124.865V43.8069Z",
                "M124.865 0V20.1356H137.169V16.0509H129.12V11.7937H136.307V7.70905H129.12V4.08465H137.169V0H124.865Z",
              ].map((d) =>
                React.createElement("path", {
                  d,
                  fill: "#FF9F59",
                })
              )
            ),
            // Egdata Icon
            React.createElement(
              "img",
              {
                src: "https://cdn.egdata.app/logo_simple_white_clean.png",
                width: 160,
                height: 160,
              }
            ),
          ]
        ),
        // Subtitle
        React.createElement(
          "div",
          {
            key: "subtitle",
            style: {
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0px",
            },
          },
          [
            React.createElement(
              "div",
              {
                style: {
                  fontSize: "48px",
                  color: "#FFFFFF",
                  textAlign: "center",
                  lineHeight: "1.3",
                  maxWidth: "900px",
                  fontWeight: 300,
                },
              },
              `Explore all the ${
                new Date() < new Date("2025-12-11")
                  ? "Nominees"
                  : "Announcements and winners"
              } for`
            ),
            React.createElement(
              "div",
              {
                style: {
                  fontSize: "56px",
                  fontWeight: 700, // Bold
                  color: "#FFFFFF",
                  textAlign: "center",
                  lineHeight: "1.1",
                  marginTop: "8px",
                },
              },
              "The Game Awards 2025"
            ),
          ]
        ),
        // Link
        React.createElement(
          "div",
          {
            key: "url",
            style: {
              marginTop: "64px",
              fontSize: "24px",
              color: "rgba(255, 255, 255, 0.5)",
              fontWeight: 300,
              letterSpacing: "0.05em",
            },
          },
          "egdata.app/the-game-awards"
        ),
      ]
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: "Roboto",
          data: readFileSync(resolve("./src/static/Roboto-Light.ttf")),
          weight: 300,
          style: "normal",
        },
        {
          name: "Roboto",
          data: readFileSync(resolve("./src/static/Roboto-Bold.woff")),
          weight: 700,
          style: "normal",
        },
      ],
    }
  );

  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [
        resolve("./src/static/Roboto-Light.ttf"),
        resolve("./src/static/Roboto-Bold.woff"),
      ],
      loadSystemFonts: false,
    },
    fitTo: { mode: "width", value: 1200 },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return c.body(pngBuffer as any, 200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=60",
  });
});

export default app;
