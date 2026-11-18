import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  type DatabaseOgCard,
  renderDatabaseOg,
} from "../src/utils/database-og.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../rust/crates/egdata-api/tests/fixtures",
);
const cards: Record<string, DatabaseOgCard> = {
  offer: {
    title: "Operation Parity: A Long Title for OG",
    subtitle: "Base game · Parity Studio",
    metrics: [
      { label: "PRICE", value: "€19.99", detail: "EUR · ES" },
      { label: "LAST UPDATE", value: "12 Dec 2026", detail: "Catalog record" },
      { label: "ASSET SIZE", value: "23.45 GB", detail: "Windows download" },
    ],
    footer: { label: "Release date", value: "14 Jan 2027" },
  },
  sandbox: {
    title: "Project Ω Sandbox",
    subtitle: "Sandbox · Parity Studio",
    metrics: [
      { label: "OFFERS", value: "1,234", detail: "Store entries" },
      { label: "ITEMS", value: "56", detail: "Catalog items" },
      { label: "ASSETS", value: "78", detail: "Distribution records" },
    ],
    footer: { label: "Last update", value: "12 Dec 2026" },
  },
};

async function rawRgba(bytes: Buffer) {
  return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe("real OG template render parity", () => {
  it.each([
    "offer",
    "sandbox",
  ] as const)("matches the Rust %s cover and fallback renders within pixel tolerance", async (scenario) => {
    const card = cards[scenario];
    const cover = fs.readFileSync(path.join(fixtureDir, "og-parity-cover.png"));
    for (const withCover of [false, true]) {
      const variant = withCover ? "-cover" : "";
      for (const format of ["png", "webp"] as const) {
        const nodeBytes = await renderDatabaseOg(
          card,
          format,
          withCover ? cover : undefined,
        );
        const rustPath = path.join(
          fixtureDir,
          `og-rust-${scenario}${variant}.${format}`,
        );
        expect(
          fs.existsSync(rustPath),
          `missing ${rustPath}; run OG_RENDER_WRITE=1 cargo test -p egdata-api real_rust_og_template_render_references`,
        ).toBe(true);
        const rustBytes = fs.readFileSync(rustPath);
        const nodeImage = await rawRgba(nodeBytes);
        const rustImage = await rawRgba(rustBytes);
        expect([nodeImage.info.width, nodeImage.info.height]).toEqual([
          1200, 630,
        ]);
        expect([rustImage.info.width, rustImage.info.height]).toEqual([
          1200, 630,
        ]);
        expect(nodeImage.info.channels).toBe(4);
        expect(rustImage.info.channels).toBe(4);
        let absoluteError = 0;
        let materiallyDifferentPixels = 0;
        const pixelCount = 1200 * 630;
        for (let offset = 0; offset < nodeImage.data.length; offset += 4) {
          let pixelMaximum = 0;
          for (let channel = 0; channel < 3; channel++) {
            const difference = Math.abs(
              nodeImage.data[offset + channel] -
                rustImage.data[offset + channel],
            );
            absoluteError += difference;
            pixelMaximum = Math.max(pixelMaximum, difference);
          }
          if (pixelMaximum > 24) materiallyDifferentPixels++;
        }
        const meanChannelError = absoluteError / (pixelCount * 3);
        const materialPixelRatio = materiallyDifferentPixels / pixelCount;
        console.info(
          `OG ${scenario}${variant}/${format}: mean RGB error ${meanChannelError.toFixed(3)}, pixels >24 ${(materialPixelRatio * 100).toFixed(2)}%`,
        );
        expect(
          meanChannelError,
          `${scenario}${variant} ${format}: mean channel error ${meanChannelError}`,
        ).toBeLessThanOrEqual(format === "png" ? 2.0 : 6.0);
        expect(
          materialPixelRatio,
          `${scenario}${variant} ${format}: materially different pixel ratio ${materialPixelRatio}`,
        ).toBeLessThanOrEqual(format === "png" ? 0.025 : 0.06);
      }
    }
  });
});
