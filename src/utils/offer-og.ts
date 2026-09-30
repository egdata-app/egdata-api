import {
  type BuildDocument,
  buildSummary,
  effectiveBuildPlatform,
} from "./builds.js";
import {
  type DatabaseOgCard,
  databaseOgTree,
  renderDatabaseOg,
} from "./database-og.js";

export interface OfferOgAsset {
  artifactId: string;
  platform?: string;
  downloadSizeBytes?: number;
  updatedAt?: Date | string;
  createdAt?: Date | string;
}

export interface OfferOgCard {
  title: string;
  subtitle: string;
  price: string;
  priceDetail: string;
  lastUpdate: string;
  assetSize: string;
  assetDetail: string;
  releaseDate: string;
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatOgDate(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== "string")
    return "Not available";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? dateFormatter.format(date)
    : "Not available";
}

export function formatOgSize(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "Not available";
  }
  if (bytes > 0 && bytes < 10_000_000) return "< 0.01 GB";
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function latestOgDownload(
  assets: OfferOgAsset[],
  build?: BuildDocument | null,
): { bytes: number | null; platform?: string } {
  if (build) {
    const platform = effectiveBuildPlatform(build);
    const matching = assets.filter(
      (asset) => asset.artifactId === build.appName,
    );
    const asset =
      matching.find((asset) => asset.platform === platform) ??
      matching.find((asset) => !asset.platform) ??
      (platform === "Unknown" && matching.length === 1
        ? matching[0]
        : undefined);
    return {
      bytes: buildSummary(build, asset).downloadSizeBytes,
      platform: platform === "Unknown" ? asset?.platform : platform,
    };
  }
  const timestamp = (asset: OfferOgAsset) => {
    const value = new Date(asset.updatedAt ?? asset.createdAt ?? 0).getTime();
    return Number.isFinite(value) ? value : 0;
  };
  const asset = [...assets].sort((a, b) => timestamp(b) - timestamp(a))[0];
  return { bytes: asset?.downloadSizeBytes ?? null, platform: asset?.platform };
}

function offerDatabaseCard(card: OfferOgCard): DatabaseOgCard {
  return {
    title: card.title,
    subtitle: card.subtitle,
    metrics: [
      { label: "PRICE", value: card.price, detail: card.priceDetail },
      {
        label: "LAST UPDATE",
        value: card.lastUpdate,
        detail: "Catalog record",
      },
      { label: "ASSET SIZE", value: card.assetSize, detail: card.assetDetail },
    ],
    footer: { label: "Release date", value: card.releaseDate },
  };
}

export function offerOgTree(card: OfferOgCard, hasCover: boolean) {
  return databaseOgTree(offerDatabaseCard(card), hasCover);
}

export function renderOfferOg(
  card: OfferOgCard,
  format: "png" | "webp",
  cover?: Uint8Array,
) {
  return renderDatabaseOg(offerDatabaseCard(card), format, cover);
}
