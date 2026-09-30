export interface SandboxOgItem {
  releaseInfo?: Array<{ appId?: string; platform?: string[] }>;
}

/** Include virtual release assets using the same convention as sandbox stats. */
export function countSandboxOgAssets(
  assets: Array<{ artifactId: string }>,
  items: SandboxOgItem[],
): number {
  const known = new Set(assets.map((asset) => asset.artifactId));
  return (
    assets.length +
    items.reduce(
      (count, item) =>
        count +
        (item.releaseInfo ?? []).reduce(
          (total, release) =>
            total +
            (release.appId && !known.has(release.appId)
              ? (release.platform?.length ?? 0)
              : 0),
          0,
        ),
      0,
    )
  );
}
