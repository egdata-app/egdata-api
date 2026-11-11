import { Hono } from "hono";
import { db } from "../../db/index.js";
import { Asset, Item, Offer, PriceEngine } from "../../models/index.js";
import { regions } from "../../utils/countries.js";
import {
  type DatabaseOgCard,
  fetchOgCover,
  renderDatabaseOg,
} from "../../utils/database-og.js";
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
import {
  countSandboxOgAssets,
  type SandboxOgItem,
} from "../../utils/sandbox-og.js";
import { countryAndRegion } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { nativeResponse, responseHeaders } from "../response.js";

const app = new Hono<{ Variables: V1Variables }>();

const IMAGE_CACHE = "private, no-cache";
const IMAGE_CDN = "no-store";

async function offerOg(
  c: Parameters<typeof nativeResponse>[0],
  format: "png" | "webp",
) {
  const id = c.req.param("id") ?? "";
  const { country, region } = countryAndRegion(c.req.query("country"));

  const offer = (await Offer.findOne({ id }).lean()) as Record<
    string,
    any
  > | null;
  if (!offer) {
    const headers = responseHeaders(c);
    headers.set("Content-Type", "application/problem+json");
    return new Response(
      JSON.stringify({
        type: "https://api.egdata.app/problems/offer-not-found",
        title: "Not Found",
        status: 404,
        detail: "No offer exists with this ID.",
        code: "OFFER_NOT_FOUND",
        requestId: c.get("requestId") as string,
      }),
      { status: 404, headers },
    );
  }

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
  const directAssets = assets.filter((asset) =>
    directItemIds.includes(asset.itemId),
  );
  const relevantAssets = directAssets.length ? directAssets : assets;
  const artifactIds = [
    ...new Set(relevantAssets.map((asset) => asset.artifactId)),
  ];
  const build = artifactIds.length
    ? await db.db
        .collection<Record<string, any>>("builds")
        .find({ appName: { $in: artifactIds } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(1)
        .next()
    : null;
  const download = latestOgDownload(
    relevantAssets as OfferOgAsset[],
    build as never,
  );
  const currency =
    price?.price?.currencyCode ??
    (regions[region] as { currencyCode?: string }).currencyCode ??
    "USD";
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
  return nativeResponse(c, new Uint8Array(buffer), {
    contentType: `image/${format}`,
    cacheControl: IMAGE_CACHE,
    cdnCacheControl: IMAGE_CDN,
  });
}

app.get("/offers/:id/og", (c) => offerOg(c, "png"));
app.get("/offers/:id/og.webp", (c) => offerOg(c, "webp"));

async function sandboxOg(
  c: Parameters<typeof nativeResponse>[0],
  format: "png" | "webp",
) {
  const sandboxId = c.req.param("sandboxId") ?? "";
  const sandbox = await db.db
    .collection<Record<string, any>>("sandboxes")
    .findOne({ _id: { $eq: sandboxId } } as never);
  if (!sandbox) {
    const headers = responseHeaders(c);
    headers.set("Content-Type", "application/problem+json");
    return new Response(
      JSON.stringify({
        type: "https://api.egdata.app/problems/sandbox-not-found",
        title: "Not Found",
        status: 404,
        detail: "No sandbox exists with this ID.",
        code: "SANDBOX_NOT_FOUND",
        requestId: c.get("requestId") as string,
      }),
      { status: 404, headers },
    );
  }

  const [offers, items, assets, releasedOffer] = await Promise.all([
    Offer.countDocuments({ namespace: sandboxId }),
    Item.find({ namespace: sandboxId }, { releaseInfo: 1 }).lean(),
    Asset.find({ namespace: sandboxId }, { artifactId: 1 }).lean(),
    Offer.findOne(
      {
        namespace: { $eq: sandboxId },
        offerType: "BASE_GAME",
        prePurchase: { $ne: true },
        isCodeRedemptionOnly: false,
      },
      undefined,
      { sort: { creationDate: 1, id: 1 } },
    ).lean(),
  ]);
  let identity =
    releasedOffer ??
    (await Offer.findOne(
      {
        namespace: { $eq: sandboxId },
        offerType: "BASE_GAME",
        prePurchase: true,
      },
      undefined,
      { sort: { creationDate: 1, id: 1 } },
    ).lean());
  identity ??= await Item.findOne(
    {
      namespace: { $eq: sandboxId },
      entitlementType: "EXECUTABLE",
      "releaseInfo.0": { $exists: true },
    },
    undefined,
    { sort: { creationDate: 1, id: 1 } },
  ).lean();

  const image = getImage(identity?.keyImages ?? [], [
    "DieselGameBoxTall",
    "OfferImageTall",
    "DieselStoreFrontTall",
    "DieselStoreFrontWide",
    "OfferImageWide",
    "Featured",
    "DieselGameBoxWide",
  ]);
  const cover = await fetchOgCover(image?.url);
  const publisher = identity?.publisherDisplayName ?? identity?.seller?.name;
  const card: DatabaseOgCard = {
    title: identity?.title ?? sandbox.title ?? sandbox.displayName ?? "Sandbox",
    subtitle: ["Sandbox", publisher].filter(Boolean).join(" · "),
    metrics: [
      {
        label: "OFFERS",
        value: offers.toLocaleString("en-US"),
        detail: "Store entries",
      },
      {
        label: "ITEMS",
        value: items.length.toLocaleString("en-US"),
        detail: "Catalog items",
      },
      {
        label: "ASSETS",
        value: countSandboxOgAssets(
          assets as Array<{ artifactId: string }>,
          items as SandboxOgItem[],
        ).toLocaleString("en-US"),
        detail: "Distribution records",
      },
    ],
    footer: {
      label: "Last update",
      value: formatOgDate(
        sandbox.updated ?? sandbox.lastModifiedDate ?? sandbox.updatedAt,
      ),
    },
  };
  const buffer = await renderDatabaseOg(card, format, cover);
  return nativeResponse(c, new Uint8Array(buffer), {
    contentType: `image/${format}`,
    cacheControl: IMAGE_CACHE,
    cdnCacheControl: IMAGE_CDN,
  });
}

app.get("/sandboxes/:sandboxId/og", (c) => sandboxOg(c, "png"));
app.get("/sandboxes/:sandboxId/og.webp", (c) => sandboxOg(c, "webp"));

function redirectToLegacyImage(
  c: Parameters<typeof nativeResponse>[0],
  path: string,
) {
  const source = new URL(c.req.url);
  const target = new URL(path, "https://api.egdata.app");
  target.search = source.search;
  const headers = responseHeaders(c);
  headers.set("Location", target.toString());
  headers.set("Cache-Control", "private, no-cache");
  headers.set("CDN-Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

app.get("/free-games/og", (c) => redirectToLegacyImage(c, "/free-games/og"));
app.get("/game-awards/og", (c) => redirectToLegacyImage(c, "/game-awards/og"));
app.get("/collections/:slug/:week/og", (c) =>
  redirectToLegacyImage(
    c,
    `/collections/${encodeURIComponent(c.req.param("slug") ?? "")}/${encodeURIComponent(
      c.req.param("week") ?? "",
    )}/og`,
  ),
);

export default app;
