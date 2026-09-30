import { ObjectId } from "mongodb";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { BuildDocument } from "../../src/utils/builds.js";
import {
  formatOgDate,
  formatOgSize,
  latestOgDownload,
  type OfferOgCard,
  renderOfferOg,
} from "../../src/utils/offer-og.js";

const card: OfferOgCard = {
  title: "BURIED STARS",
  subtitle: "Base game · LINE Games Corporation",
  price: "$39.99",
  priceDetail: "USD · US",
  lastUpdate: "24 Sep 2026",
  assetSize: "Not available",
  assetDetail: "Latest download",
  releaseDate: "26 Aug 2026",
};
const build = (extra: Partial<BuildDocument> = {}): BuildDocument => ({
  _id: new ObjectId(),
  appName: "game",
  buildVersion: "1",
  labelName: "Live-Windows",
  hash: "hash",
  ...extra,
});

describe("offer OG metadata", () => {
  it("uses UTC and leaves missing dates explicit", () => {
    expect(formatOgDate("2026-09-24T23:30:00-03:00")).toBe("25 Sept 2026");
    expect(formatOgDate(null)).toBe("Not available");
    expect(formatOgDate("invalid")).toBe("Not available");
  });

  it("formats decimal GB without confusing missing, zero, and tiny values", () => {
    expect(formatOgSize(12_340_000_000)).toBe("12.34 GB");
    expect(formatOgSize(0)).toBe("0.00 GB");
    expect(formatOgSize(5000)).toBe("< 0.01 GB");
    for (const value of [
      null,
      undefined,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(formatOgSize(value)).toBe("Not available");
    }
  });

  it("uses the build's own size rather than a larger current asset size", () => {
    expect(
      latestOgDownload(
        [{ artifactId: "game", platform: "Windows", downloadSizeBytes: 20e9 }],
        build({ downloadSizeBytes: 3e9 }),
      ),
    ).toEqual({ bytes: 3e9, platform: "Windows" });
  });

  it("falls back only to the matching asset and platform", () => {
    const assets = [
      { artifactId: "game", platform: "Mac", downloadSizeBytes: 9e9 },
      { artifactId: "game", platform: "Windows", downloadSizeBytes: 4e9 },
    ];
    expect(latestOgDownload(assets, build())).toEqual({
      bytes: 4e9,
      platform: "Windows",
    });
    expect(
      latestOgDownload(assets, build({ platform: "Linux" })).bytes,
    ).toBeNull();
    expect(
      latestOgDownload(assets, build({ appName: "other" })).bytes,
    ).toBeNull();
    expect(latestOgDownload([assets[0]], build()).bytes).toBeNull();
  });

  it("selects the latest asset without adding together unrelated downloads", () => {
    expect(
      latestOgDownload([
        { artifactId: "old", updatedAt: "2026-08-01", downloadSizeBytes: 10e9 },
        {
          artifactId: "new",
          updatedAt: "2026-09-01",
          downloadSizeBytes: 2e9,
          platform: "Mac",
        },
      ]),
    ).toEqual({ bytes: 2e9, platform: "Mac" });
    expect(latestOgDownload([]).bytes).toBeNull();
  });
});

describe("native offer OG rendering", () => {
  it.each([
    "png",
    "webp",
  ] as const)("produces a real 1200 × 630 %s image", async (format) => {
    const output = await renderOfferOg(card, format);
    expect(await sharp(output).metadata()).toMatchObject({
      format,
      width: 1200,
      height: 630,
    });
  });

  it("handles long titles and unusable artwork without breaking the image", async () => {
    const output = await renderOfferOg(
      {
        ...card,
        title:
          "A very long game title with a complete edition and additional downloadable content ".repeat(
            3,
          ),
      },
      "webp",
      Buffer.from("broken image"),
    );
    expect(await sharp(output).metadata()).toMatchObject({
      format: "webp",
      width: 1200,
      height: 630,
    });
  });
});
