import type { ObjectId } from "mongodb";

export type ManifestStatus =
  | "processing"
  | "verified"
  | "invalid"
  | "unavailable"
  | "failed"
  | "legacy_unverified";

export type BuildDocument = Record<string, unknown> & {
  _id: ObjectId;
  appName: string;
  buildVersion: string;
  labelName: string;
  platform?: string;
  hash: string;
  sourceManifestHash?: string;
  manifestId?: string;
  manifestStatus?: ManifestStatus;
  manifestParserVersion?: string;
  manifestProcessedAt?: Date;
  manifestFileCount?: number;
  manifestFileBytes?: number;
  manifestErrorCode?: string;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  previousObservedBuildId?: ObjectId;
  technologies?: Array<{ section: string; technology: string }>;
  downloadSizeBytes?: number;
  installedSizeBytes?: number;
  createdAt?: Date;
  updatedAt?: Date;
};

export function effectiveBuildPlatform(
  build: Pick<BuildDocument, "platform" | "labelName">,
): string {
  return build.platform ?? build.labelName.split("-").at(-1) ?? "Unknown";
}

export function buildManifestStatus(build: BuildDocument): ManifestStatus {
  return build.manifestStatus ?? "legacy_unverified";
}

export function buildSummary(build: BuildDocument, asset?: unknown) {
  const assetSizes = asset as
    | { downloadSizeBytes?: unknown; installedSizeBytes?: unknown }
    | null
    | undefined;
  const assetDownloadSize =
    typeof assetSizes?.downloadSizeBytes === "number"
      ? assetSizes.downloadSizeBytes
      : null;
  const assetInstalledSize =
    typeof assetSizes?.installedSizeBytes === "number"
      ? assetSizes.installedSizeBytes
      : null;
  return {
    id: build._id.toString(),
    _id: build._id.toString(),
    appName: build.appName,
    buildVersion: build.buildVersion,
    labelName: build.labelName,
    platform: effectiveBuildPlatform(build),
    hash: build.hash,
    firstSeenAt: build.firstSeenAt ?? build.createdAt ?? null,
    lastSeenAt: build.lastSeenAt ?? build.updatedAt ?? null,
    createdAt: build.createdAt ?? null,
    updatedAt: build.updatedAt ?? null,
    downloadSizeBytes: build.downloadSizeBytes ?? assetDownloadSize,
    installedSizeBytes: build.installedSizeBytes ?? assetInstalledSize,
    technologies: build.technologies ?? [],
    manifest: {
      status: buildManifestStatus(build),
      canonicalHash: build.manifestId ?? null,
      sourceHash: build.sourceManifestHash ?? build.hash,
      parserVersion: build.manifestParserVersion ?? null,
      processedAt: build.manifestProcessedAt ?? null,
      fileCount: build.manifestFileCount ?? null,
      fileBytes: build.manifestFileBytes ?? null,
      errorCode: build.manifestErrorCode ?? null,
    },
  };
}
