import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ContainerNode, type Node, Renderer } from "@takumi-rs/core";

export interface DatabaseOgMetric {
  label: string;
  value: string;
  detail: string;
}

export interface DatabaseOgCard {
  title: string;
  subtitle: string;
  metrics: [DatabaseOgMetric, DatabaseOgMetric, DatabaseOgMetric];
  footer: { label: string; value: string };
}

export async function fetchOgCover(
  url?: string,
): Promise<Uint8Array | undefined> {
  if (!url) return undefined;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

type Style = NonNullable<ContainerNode["style"]>;
const text = (value: string, style: Style = {}): Node => ({
  type: "text",
  text: value,
  style: { color: "#FFFFFF", lineHeight: 1.2, flexShrink: 0, ...style },
});
const container = (style: Style, children: Node[] = []): ContainerNode => ({
  type: "container",
  style,
  children,
});

export function databaseOgTree(card: DatabaseOgCard, hasCover: boolean): Node {
  const left = hasCover ? 298 : 48;
  const width = 1152 - left;
  const title = card.title.slice(0, 160);
  const titleSize = title.length > 60 ? 36 : title.length > 30 ? 44 : 64;
  const metric = (
    label: string,
    value: string,
    detail: string,
    index: number,
  ) =>
    container(
      {
        width: width / 3,
        paddingLeft: index ? 40 : 0,
        paddingRight: 12,
        borderLeft: index ? "1px solid #235B80" : undefined,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      },
      [
        text(label, { fontSize: 20, color: "#92B0D0", letterSpacing: 0.7 }),
        text(value, {
          fontSize: value.length > 14 ? 24 : value.length > 11 ? 28 : 32,
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }),
        text(detail, { fontSize: 22, color: "#92B0D0" }),
      ],
    );

  return container(
    {
      width: 1200,
      height: 630,
      position: "relative",
      overflow: "hidden",
      backgroundColor: "#00162D",
      fontFamily: "Roboto",
    },
    [
      ...(hasCover
        ? [
            {
              type: "image",
              src: "cover",
              style: {
                position: "absolute",
                right: 0,
                top: 0,
                width: 1200,
                height: 630,
                objectFit: "cover",
                opacity: 0.04,
              },
            } as Node,
          ]
        : []),
      container({ position: "absolute", left: 48, top: 48, display: "flex" }, [
        text("egdata", { fontSize: 34, fontWeight: 700 }),
        text(".app", { fontSize: 34, fontWeight: 700, color: "#0078F2" }),
      ]),
      text("Epic Games Store Database", {
        position: "absolute",
        top: 57,
        right: 48,
        fontSize: 24,
        color: "#92B0D0",
      }),
      ...(hasCover
        ? [
            {
              type: "image",
              src: "cover",
              style: {
                position: "absolute",
                left: 48,
                top: 132,
                width: 224,
                height: 280,
                objectFit: "cover",
                borderRadius: 8,
                border: "1px solid #235B80",
              },
            } as Node,
          ]
        : []),
      container(
        {
          position: "absolute",
          left,
          top: 166,
          width,
          height: 168,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 12,
        },
        [
          text(title, {
            fontSize: titleSize,
            fontWeight: 700,
            lineHeight: 1.08,
            lineClamp: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            wordBreak: "break-word",
          }),
          text(card.subtitle, {
            fontSize: 24,
            color: "#92B0D0",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }),
        ],
      ),
      container(
        {
          position: "absolute",
          left,
          top: 348,
          width,
          height: 132,
          paddingTop: 22,
          borderTop: "1px solid #235B80",
          display: "flex",
        },
        [
          ...card.metrics.map((item, index) =>
            metric(item.label, item.value, item.detail, index),
          ),
        ],
      ),
      container(
        {
          position: "absolute",
          left: 48,
          top: 496,
          width: 1104,
          paddingTop: 32,
          borderTop: "1px solid #235B80",
          display: "flex",
          alignItems: "center",
        },
        [
          text(card.footer.label, {
            fontSize: 24,
            color: "#92B0D0",
            paddingRight: 38,
          }),
          text(card.footer.value, {
            fontSize: 32,
            fontWeight: 700,
            borderLeft: "1px solid #235B80",
            paddingLeft: 40,
          }),
        ],
      ),
    ],
  );
}

let rendererPromise: Promise<Renderer> | undefined;
function getRenderer(): Promise<Renderer> {
  rendererPromise ??= (async () => {
    const renderer = new Renderer({ cacheMaxBytes: 32 * 1024 * 1024 });
    const fonts = await Promise.all([
      readFile(resolve("src/static/Roboto.ttf")),
      readFile(resolve("src/static/Roboto-Bold.woff")),
    ]);
    await Promise.all(
      fonts.map((data, index) =>
        renderer.registerFont({
          name: "Roboto",
          data,
          weight: index ? 700 : 400,
        }),
      ),
    );
    return renderer;
  })().catch((error) => {
    rendererPromise = undefined;
    throw error;
  });
  return rendererPromise;
}

export async function renderDatabaseOg(
  card: DatabaseOgCard,
  format: "png" | "webp",
  cover?: Uint8Array,
): Promise<Buffer> {
  const renderer = await getRenderer();
  const options = {
    width: 1200,
    height: 630,
    format,
    quality: 90,
  };
  try {
    return await renderer.render(databaseOgTree(card, Boolean(cover)), {
      ...options,
      images: cover ? [{ src: "cover", data: cover }] : [],
    });
  } catch (error) {
    if (!cover) throw error;
    // A broken upstream image must not prevent the database summary rendering.
    return renderer.render(databaseOgTree(card, false), options);
  }
}
