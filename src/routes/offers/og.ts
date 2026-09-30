import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { db } from "../../db/index.js";
import { Asset, Item, Offer, PriceEngine } from "../../models/index.js";
import type { BuildDocument } from "../../utils/builds.js";
import { regions } from "../../utils/countries.js";
import { fetchOgCover } from "../../utils/database-og.js";
import { getImage } from "../../utils/get-image.js";
import { getOfferSubItems } from "../../utils/get-offer-sub-items.js";
import {
  formatOgDate,
  formatOgSize,
  latestOgDownload,
  type OfferOgAsset,
  renderOfferOg,
} from "../../utils/offer-og.js";
import { isPriceCountryEligible } from "../../utils/price-eligibility.js";

const app = new Hono();

async function offerOg(c: Context, format: "png" | "webp") {
  const id = c.req.param("id");
  const country =
    c.req.query("country") ?? getCookie(c, "EGDATA_COUNTRY") ?? "US";
  const region = Object.keys(regions).find((key) =>
    regions[key].countries.includes(country),
  );
  if (!region) return c.json({ message: "Country not found" }, 404);

  const offer = await Offer.findOne({ id }).lean();
  if (!offer) return c.json({ message: "Offer not found" }, 404);

  const image = getImage(offer.keyImages ?? [], [
    "DieselGameBoxTall",
    "OfferImageTall",
    "DieselStoreFrontTall",
    "DieselStoreFrontWide",
    "OfferImageWide",
    "Featured",
    "DieselGameBoxWide",
  ]);
  const [price, subItems, cover] = await Promise.all([
    isPriceCountryEligible(offer, country)
      ? PriceEngine.findOne({ offerId: id, region }, undefined, {
          sort: { updatedAt: -1 },
        }).lean()
      : Promise.resolve(null),
    getOfferSubItems({ _id: id }),
    fetchOgCover(image?.url),
  ]);
  const directItemIds = (offer.items ?? []).map(
    (item: { id: string }) => item.id,
  );
  const items = await Item.find(
    {
      $or: [
        {
          id: {
            $in: [
              ...directItemIds,
              ...subItems.flatMap((item) => item.subItems.map((sub) => sub.id)),
            ],
          },
        },
        { linkedOffers: id },
      ],
    },
    { id: 1 },
  ).lean();
  const assets = await Asset.find({
    itemId: { $in: items.map((item) => item.id) },
  }).lean();
  // Use the offer's own assets before falling back to related subitems/DLC.
  const directAssets = assets.filter((asset) =>
    directItemIds.includes(asset.itemId),
  );
  const relevantAssets = directAssets.length ? directAssets : assets;
  const artifactIds = [
    ...new Set(relevantAssets.map((asset) => asset.artifactId)),
  ];
  const build = artifactIds.length
    ? await db.db
        .collection<BuildDocument>("builds")
        .find({ appName: { $in: artifactIds } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(1)
        .next()
    : null;
  const download = latestOgDownload(relevantAssets as OfferOgAsset[], build);
  const currency = price?.price?.currencyCode ?? regions[region].currencyCode;
  const amount = price?.price?.discountPrice;
  const publisher = offer.publisherDisplayName ?? offer.seller?.name ?? "";
  const type = String(offer.offerType ?? "Offer")
    .toLowerCase()
    .replaceAll("_", " ");
  const card = {
    title: offer.title ?? "Untitled offer",
    subtitle: [type.charAt(0).toUpperCase() + type.slice(1), publisher]
      .filter(Boolean)
      .join(" · "),
    price:
      typeof amount === "number" && Number.isFinite(amount) && amount >= 0
        ? amount === 0
          ? "Free"
          : new Intl.NumberFormat("en-US", {
              style: "currency",
              currency,
            }).format(amount / 100)
        : "Unavailable",
    priceDetail: `${currency} · ${country}`,
    lastUpdate: formatOgDate(offer.lastModifiedDate ?? offer.updatedAt),
    assetSize: formatOgSize(download.bytes),
    assetDetail: download.platform
      ? `${download.platform} download`
      : "Latest download",
    releaseDate: formatOgDate(
      offer.releaseDate ?? offer.effectiveDate ?? offer.viewableDate,
    ),
  };
  const buffer = await renderOfferOg(card, format, cover);
  return c.body(new Uint8Array(buffer), 200, {
    "Content-Type": `image/${format}`,
    "Cache-Control": "public, max-age=60",
    Vary: "Cookie",
  });
}

app.get("/og", (c) => offerOg(c, "png"));
app.get("/og.webp", (c) => offerOg(c, "webp"));

export default app;
