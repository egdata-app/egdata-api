import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { createElement, type ReactNode } from "react";
import satori from "satori";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const fixtures = new URL(
  "../rust/crates/egdata-api/tests/fixtures/",
  import.meta.url,
);
const read = (name: string) => fs.readFileSync(new URL(name, fixtures));
const cover = `data:image/png;base64,${read("og-parity-cover.png").toString("base64")}`;
const light = fs.readFileSync(
  new URL("../src/static/Roboto-Light.ttf", import.meta.url),
);
const bold = fs.readFileSync(
  new URL("../src/static/Roboto-Bold.woff", import.meta.url),
);
const rootCases = JSON.parse(read("legacy-root-ops-http-node.json").toString());
const awardsCases = JSON.parse(
  read("legacy-og-editorial-http-node.json").toString(),
);

interface RecordedElement {
  type?: string;
  tag?: string;
  props: Record<string, unknown> & { children?: ElementContent };
}
type ElementContent =
  | RecordedElement
  | string
  | number
  | null
  | ElementContent[];

// The HTTP oracles record the JSX that the real Hono routes pass to Satori.
// Hono JSX serializes its tag separately; React JSX serializes a type.
function restoreTree(element: ElementContent): ReactNode {
  if (element === null || typeof element !== "object") return element;
  if (Array.isArray(element)) return element.map(restoreTree);
  const { children, ...props } = element.props;
  if (props.src) props.src = cover;
  const tag = element.type ?? element.tag;
  if (!tag) throw new Error("Expected a tag in the Node JSX record");
  return createElement(
    tag,
    props,
    children == null ? undefined : restoreTree(children),
  );
}

describe("legacy editorial OG renders", () => {
  it.each([
    {
      name: "free-games",
      caseName: "free-games-og-upload-success",
      layoutWidth: 1300,
      width: 1400,
    },
    {
      name: "collection",
      caseName: "collection-og-direct-png-hash",
      layoutWidth: 1200,
      width: 2800,
    },
    {
      name: "game-awards",
      caseName: "game-awards-og",
      layoutWidth: 1200,
      width: 1200,
    },
  ])("matches the dimensions and layout of the real Node $name image", async ({
    name,
    caseName,
    layoutWidth,
    width,
  }) => {
    const awards = name === "game-awards";
    const record = (awards ? awardsCases : rootCases).find(
      (c: { name: string }) => c.name === caseName,
    );
    const tree = restoreTree(
      JSON.parse(awards ? record.renderer.element : record.rendered),
    );
    const svg = await satori(tree, {
      width: layoutWidth,
      height: 630,
      fonts: awards
        ? [
            { name: "Roboto", data: light, weight: 300 },
            { name: "Roboto", data: bold, weight: 700 },
          ]
        : [{ name: "Roboto", data: light, weight: 400 }],
    });
    const nodePng = new Resvg(svg, {
      fitTo: { mode: "width", value: width },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng();
    const nativePng = read(`og-rust-${name}.png`);
    const [node, native] = await Promise.all(
      [nodePng, nativePng].map((png) =>
        sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
      ),
    );
    expect(native.info.width).toBe(node.info.width);
    expect(native.info.height).toBe(node.info.height);
    expect(node.info.width).toBe(width);
    if (name !== "collection") {
      // The fixture cover/logo is an opaque navy rectangle. Verify a pixel inside it
      // in both engines so a missing fetch cannot pass the overall image tolerance.
      const [x, y] = name === "free-games" ? [0.5, 0.55] : [0.66, 0.24];
      for (const { info, data } of [node, native]) {
        const offset =
          3 *
          (Math.floor(y * info.height) * info.width +
            Math.floor(x * info.width));
        expect([...data.subarray(offset, offset + 3)]).toEqual([16, 32, 64]);
      }
    }
    let error = 0;
    let changed = 0;
    for (let i = 0; i < node.data.length; i += 3) {
      const dr = Math.abs(node.data[i] - native.data[i]);
      const dg = Math.abs(node.data[i + 1] - native.data[i + 1]);
      const db = Math.abs(node.data[i + 2] - native.data[i + 2]);
      error += dr + dg + db;
      if (Math.max(dr, dg, db) > 24) changed++;
    }
    const mean = error / node.data.length;
    const ratio = (3 * changed) / node.data.length;
    console.info(
      `${name} mean RGB difference ${mean.toFixed(2)}, ${(ratio * 100).toFixed(1)}% of pixels over 24`,
    );
    expect(mean).toBeLessThan(name === "collection" ? 3 : 2);
    expect(ratio).toBeLessThan(name === "collection" ? 0.03 : 0.025);
  });
});
