import { type Context, Hono } from "hono";
import { db } from "../db/index.js";
import { Asset, Item, Offer } from "../models/index.js";
import {
  type DatabaseOgCard,
  fetchOgCover,
  renderDatabaseOg,
} from "../utils/database-og.js";
import { getImage } from "../utils/get-image.js";
import { formatOgDate } from "../utils/offer-og.js";
import {
  countSandboxOgAssets,
  type SandboxOgItem,
} from "../utils/sandbox-og.js";

type SandboxOgDocument = {
  _id: string;
  title?: string;
  displayName?: string;
  updated?: Date;
  lastModifiedDate?: Date;
  updatedAt?: Date;
};
const app = new Hono();

async function sandboxOg(c: Context, format: "png" | "webp") {
  const sandboxId = c.req.param("sandboxId");
  const sandbox = await db.db
    .collection<SandboxOgDocument>("sandboxes")
    .findOne({ _id: { $eq: sandboxId } });
  if (!sandbox) return c.json({ message: "Sandbox not found" }, 404);

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
  // Match the base-game endpoint's preorder and executable-item fallbacks.
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
  return c.body(new Uint8Array(buffer), 200, {
    "Content-Type": `image/${format}`,
    "Cache-Control": "public, max-age=60",
  });
}

app.get("/og", (c) => sandboxOg(c, "png"));
app.get("/og.webp", (c) => sandboxOg(c, "webp"));

export default app;
