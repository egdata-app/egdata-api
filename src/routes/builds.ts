import { createHash } from "node:crypto";
import { Hono } from "hono";
import { type Filter, ObjectId, type Sort } from "mongodb";
import client from "../clients/redis.js";
import { db } from "../db/index.js";
import { Asset, Item } from "../models/index.js";
import {
  type BuildFileChangeStatus,
  type BuildFileSnapshot,
  compareBuildFileSnapshots,
} from "../utils/build-comparison.js";
import {
  buildPaginationOffset,
  MAX_BUILD_PAGE,
  parseBuildInteger,
} from "../utils/build-pagination.js";
import {
  type BuildDocument,
  buildManifestStatus,
  buildSummary,
  effectiveBuildPlatform,
} from "../utils/builds.js";

type AnyObject = Record<string, unknown>;

const app = new Hono();
const allowedStatuses = new Set<BuildFileChangeStatus>([
  "added",
  "removed",
  "modified",
  "unchanged",
]);
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function technologyChanges(base: BuildDocument, target: BuildDocument) {
  const key = (technology: { section: string; technology: string }) =>
    `${technology.section}\0${technology.technology}`;
  const baseMap = new Map(
    (base.technologies ?? []).map((technology) => [
      key(technology),
      technology,
    ]),
  );
  const targetMap = new Map(
    (target.technologies ?? []).map((technology) => [
      key(technology),
      technology,
    ]),
  );
  return {
    added: [...targetMap]
      .filter(([id]) => !baseMap.has(id))
      .map(([, technology]) => technology),
    removed: [...baseMap]
      .filter(([id]) => !targetMap.has(id))
      .map(([, technology]) => technology),
  };
}

function snapshotQuery(build: BuildDocument): Filter<AnyObject> {
  return build.manifestId
    ? { manifestId: build.manifestId }
    : { manifestHash: build.hash };
}

function comparable(build: BuildDocument): boolean {
  return (
    ["verified", "legacy_unverified"].includes(buildManifestStatus(build)) &&
    typeof build.manifestId === "string"
  );
}

app.get("/", async (c) => {
  const sortBy = c.req.query("sortBy") || "createdAt";
  const sortDir = c.req.query("sortDir") || "desc";
  const limit = parseBuildInteger(c.req.query("limit"), 10);
  const page = parseBuildInteger(c.req.query("page"), 1, MAX_BUILD_PAGE);
  const offset = limit && page ? buildPaginationOffset(page, limit) : null;
  if (
    !limit ||
    !page ||
    offset === null ||
    !["createdAt", "updatedAt", "firstSeenAt"].includes(sortBy)
  ) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid pagination or sort field",
        },
      },
      400,
    );
  }
  if (!(["asc", "desc"] as const).includes(sortDir as "asc" | "desc")) {
    return c.json(
      {
        error: { code: "VALIDATION_ERROR", message: "Invalid sort direction" },
      },
      400,
    );
  }

  const cacheKey = `builds:v2:${sortBy}:${sortDir}:${limit}:${page}`;
  const cached = await client.get(cacheKey).catch(() => null);
  if (cached) return c.json(JSON.parse(cached));

  const sort: Sort = { [sortBy]: sortDir === "asc" ? 1 : -1 };
  const builds = await db.db
    .collection<BuildDocument>("builds")
    .find()
    .sort(sort)
    .skip(offset)
    .limit(limit)
    .toArray();
  const items = await Item.find({
    "releaseInfo.appId": { $in: builds.map((build) => build.appName) },
    entitlementType: "EXECUTABLE",
  });
  const results = builds.map((build) => ({
    ...buildSummary(build),
    item:
      items.find((item) =>
        item.releaseInfo?.some(
          (release: AnyObject) => release.appId === build.appName,
        ),
      ) ?? null,
  }));
  await client
    .set(cacheKey, JSON.stringify(results), "EX", 600)
    .catch(() => undefined);
  return c.json(results);
});

app.get("/:id/history", async (c) => {
  const { id } = c.req.param();
  if (!ObjectId.isValid(id))
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid build ID" } },
      400,
    );
  const limit = parseBuildInteger(c.req.query("limit"), 50);
  const page = parseBuildInteger(c.req.query("page"), 1, MAX_BUILD_PAGE);
  const offset = limit && page ? buildPaginationOffset(page, limit) : null;
  const scope = c.req.query("scope") ?? "stream";
  if (
    !limit ||
    !page ||
    offset === null ||
    !["stream", "platform"].includes(scope)
  ) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid history query" } },
      400,
    );
  }

  const build = await db.db
    .collection<BuildDocument>("builds")
    .findOne({ _id: new ObjectId(id) });
  if (!build)
    return c.json(
      { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
      404,
    );

  const platform = effectiveBuildPlatform(build);
  const filter: Filter<BuildDocument> = { appName: build.appName };
  if (scope === "stream") filter.labelName = build.labelName;
  else {
    filter.$or = [
      { platform },
      {
        platform: { $exists: false },
        labelName: { $regex: new RegExp(`-${escapeRegex(platform)}$`, "i") },
      },
    ];
  }

  const collection = db.db.collection<BuildDocument>("builds");
  const [builds, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ firstSeenAt: -1, createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  let previousComparableBuildId: string | null = null;
  if (build.previousObservedBuildId) {
    const observed = await collection.findOne({
      _id: build.previousObservedBuildId,
      appName: build.appName,
      labelName: build.labelName,
      manifestStatus: { $in: ["verified", "legacy_unverified"] },
      manifestId: { $type: "string" },
    });
    if (
      observed &&
      comparable(observed) &&
      effectiveBuildPlatform(observed) === platform
    ) {
      previousComparableBuildId = observed._id.toString();
    }
  }
  if (!previousComparableBuildId) {
    const previous = await collection.findOne(
      {
        appName: build.appName,
        labelName: build.labelName,
        _id: { $ne: build._id },
        manifestStatus: { $in: ["verified", "legacy_unverified"] },
        manifestId: { $type: "string" },
        createdAt: { $lt: build.createdAt ?? new Date() },
        $or: [{ platform }, { platform: { $exists: false } }],
      },
      { sort: { firstSeenAt: -1, createdAt: -1 } },
    );
    previousComparableBuildId = previous?._id.toString() ?? null;
  }

  return c.json({
    data: builds.map((entry) => ({
      ...buildSummary(entry),
      comparable: comparable(entry),
      sameStream: entry.labelName === build.labelName,
    })),
    previousComparableBuildId,
    page,
    limit,
    total,
  });
});

app.get("/:targetId/compare/:baseId", async (c) => {
  const { targetId, baseId } = c.req.param();
  if (!ObjectId.isValid(targetId) || !ObjectId.isValid(baseId)) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid build ID" } },
      400,
    );
  }
  const limit = parseBuildInteger(c.req.query("limit"), 50);
  const page = parseBuildInteger(c.req.query("page"), 1, MAX_BUILD_PAGE);
  const offset = limit && page ? buildPaginationOffset(page, limit) : null;
  const direction = c.req.query("dir") ?? "asc";
  const query = c.req.query("q")?.trim();
  const statuses = new Set(
    (c.req.query("status") ?? "added,modified,removed").split(","),
  );
  const extensions = new Set(
    (c.req.query("extension") ?? "")
      .split(",")
      .map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean),
  );
  if (
    !limit ||
    !page ||
    offset === null ||
    !["asc", "desc"].includes(direction) ||
    (query?.length ?? 0) > 200 ||
    extensions.size > 20 ||
    statuses.size === 0 ||
    [...statuses].some(
      (status) => !allowedStatuses.has(status as BuildFileChangeStatus),
    )
  ) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid comparison query",
        },
      },
      400,
    );
  }

  const collection = db.db.collection<BuildDocument>("builds");
  const [target, base] = await Promise.all([
    collection.findOne({ _id: new ObjectId(targetId) }),
    collection.findOne({ _id: new ObjectId(baseId) }),
  ]);
  if (!target || !base)
    return c.json(
      { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
      404,
    );
  if (
    target.appName !== base.appName ||
    effectiveBuildPlatform(target) !== effectiveBuildPlatform(base)
  ) {
    return c.json(
      {
        error: {
          code: "INCOMPATIBLE_BUILDS",
          message: "Builds must use the same app and platform",
        },
      },
      400,
    );
  }
  if (!comparable(target) || !comparable(base)) {
    return c.json(
      {
        error: {
          code: "MANIFEST_NOT_COMPARABLE",
          message:
            "Both builds must have stored file snapshots before comparison",
          baseStatus: buildManifestStatus(base),
          targetStatus: buildManifestStatus(target),
        },
      },
      409,
    );
  }

  const normalizedFilters = {
    page,
    limit,
    direction,
    query: query?.toLocaleLowerCase() ?? "",
    statuses: [...statuses].sort(),
    extensions: [...extensions].sort(),
  };
  const cacheHash = createHash("sha256")
    .update(JSON.stringify(normalizedFilters))
    .digest("hex")
    .slice(0, 20);
  const cacheKey = `build-compare:v2:${baseId}:${targetId}:${base.updatedAt?.valueOf() ?? 0}:${target.updatedAt?.valueOf() ?? 0}:${cacheHash}`;
  const cached = await client.get(cacheKey).catch(() => null);
  if (cached) return c.json(JSON.parse(cached));

  const fileSort: Sort = { fileName: direction === "asc" ? 1 : -1 };
  const projection = {
    _id: 0,
    fileName: 1,
    fileHash: 1,
    fileSize: 1,
    mimeType: 1,
    installTags: 1,
    symlinkTarget: 1,
    fileMetaFlags: 1,
  };
  const baseFiles = db.db
    .collection<BuildFileSnapshot>("files")
    .find(snapshotQuery(base), { projection })
    .sort(fileSort);
  const targetFiles = db.db
    .collection<BuildFileSnapshot>("files")
    .find(snapshotQuery(target), { projection })
    .sort(fileSort);
  const comparison = await compareBuildFileSnapshots(baseFiles, targetFiles, {
    statuses: statuses as Set<BuildFileChangeStatus>,
    query,
    extensions: extensions.size ? extensions : undefined,
    page,
    limit,
    direction: direction as "asc" | "desc",
  });

  const response = {
    base: buildSummary(base),
    target: buildSummary(target),
    comparisonScope:
      base.labelName === target.labelName ? "same_stream" : "cross_stream",
    summary: {
      files: comparison.files,
      fileBytes: comparison.fileBytes,
      installedSizeBytes: {
        base: base.installedSizeBytes ?? null,
        target: target.installedSizeBytes ?? null,
        delta:
          typeof base.installedSizeBytes === "number" &&
          typeof target.installedSizeBytes === "number"
            ? target.installedSizeBytes - base.installedSizeBytes
            : null,
      },
      fullDownloadSizeBytes: {
        base: base.downloadSizeBytes ?? null,
        target: target.downloadSizeBytes ?? null,
        delta:
          typeof base.downloadSizeBytes === "number" &&
          typeof target.downloadSizeBytes === "number"
            ? target.downloadSizeBytes - base.downloadSizeBytes
            : null,
      },
      technologies: technologyChanges(base, target),
      installTags: comparison.installTags,
      topFiles: comparison.topFiles,
      topDirectories: comparison.topDirectories,
    },
    changes: comparison.changes,
    warnings: [
      ...(base.labelName === target.labelName
        ? []
        : ["CROSS_STREAM_COMPARISON"]),
      ...(buildManifestStatus(base) === "legacy_unverified" ||
      buildManifestStatus(target) === "legacy_unverified"
        ? ["LEGACY_UNVERIFIED_SNAPSHOT"]
        : []),
    ],
    page,
    limit,
    total: comparison.total,
  };
  await client
    .set(cacheKey, JSON.stringify(response), "EX", 600)
    .catch(() => undefined);
  return c.json(response);
});

app.get("/:id", async (c) => {
  const { id } = c.req.param();
  if (!ObjectId.isValid(id))
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid build ID" } },
      400,
    );
  const build = await db.db
    .collection<BuildDocument>("builds")
    .findOne({ _id: new ObjectId(id) });
  if (!build)
    return c.json(
      { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
      404,
    );
  const asset = await Asset.findOne({
    artifactId: build.appName,
    platform: effectiveBuildPlatform(build),
  });
  return c.json(buildSummary(build, asset));
});

app.get("/:id/files", async (c) => {
  const { id } = c.req.param();
  if (!ObjectId.isValid(id))
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid build ID" } },
      400,
    );
  const limit = parseBuildInteger(c.req.query("limit"), 25);
  const page = parseBuildInteger(c.req.query("page"), 1, MAX_BUILD_PAGE);
  const offset = limit && page ? buildPaginationOffset(page, limit) : null;
  const sort = c.req.query("sort") || "depth";
  const direction = c.req.query("dir") || "asc";
  const filename = c.req.query("q")?.trim();
  const extensions = (c.req.query("extension") ?? "")
    .split(",")
    .map((extension) => extension.trim().replace(/^\./, ""))
    .filter(Boolean);
  if (
    !limit ||
    !page ||
    offset === null ||
    !["depth", "fileName", "fileSize"].includes(sort) ||
    !["asc", "desc"].includes(direction) ||
    (filename?.length ?? 0) > 200 ||
    extensions.length > 20
  ) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid files query" } },
      400,
    );
  }
  const build = await db.db
    .collection<BuildDocument>("builds")
    .findOne({ _id: new ObjectId(id) });
  if (!build)
    return c.json(
      { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
      404,
    );

  const queryFilter: Filter<AnyObject> = snapshotQuery(build);
  const pathFilters: Filter<AnyObject>[] = [];
  if (filename)
    pathFilters.push({
      fileName: { $regex: new RegExp(escapeRegex(filename), "i") },
    });
  if (extensions.length) {
    pathFilters.push({
      fileName: {
        $regex: new RegExp(
          `\\.(${extensions.map(escapeRegex).join("|")})$`,
          "i",
        ),
      },
    });
  }
  if (pathFilters.length) queryFilter.$and = pathFilters;
  const sortQuery: Sort =
    sort === "depth"
      ? {
          depth: direction === "asc" ? 1 : -1,
          fileName: direction === "asc" ? 1 : -1,
        }
      : { [sort]: direction === "asc" ? 1 : -1 };
  const [files, total] = await Promise.all([
    db.db
      .collection("files")
      .find(queryFilter)
      .sort(sortQuery)
      .skip(offset)
      .limit(limit)
      .toArray(),
    db.db.collection("files").countDocuments(queryFilter),
  ]);
  return c.json({
    files,
    manifestStatus: buildManifestStatus(build),
    page,
    limit,
    total,
  });
});

app.get("/:id/items", async (c) => {
  const { id } = c.req.param();
  if (!ObjectId.isValid(id))
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid build ID" } },
      400,
    );
  const limit = parseBuildInteger(c.req.query("limit"), 25);
  const page = parseBuildInteger(c.req.query("page"), 1, MAX_BUILD_PAGE);
  const offset = limit && page ? buildPaginationOffset(page, limit) : null;
  if (!limit || !page || offset === null)
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid pagination" } },
      400,
    );
  const build = await db.db
    .collection<BuildDocument>("builds")
    .findOne({ _id: new ObjectId(id) });
  if (!build)
    return c.json(
      { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
      404,
    );
  const itemFilter = { "releaseInfo.appId": build.appName };
  const [items, total] = await Promise.all([
    Item.find(itemFilter).skip(offset).limit(limit),
    Item.countDocuments(itemFilter),
  ]);
  return c.json({ data: items, page, limit, total });
});

app.get("/:id/install-options", async (c) => {
  const { id } = c.req.param();
  if (!ObjectId.isValid(id))
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid build ID" } },
      400,
    );
  const build = await db.db
    .collection<BuildDocument>("builds")
    .findOne({ _id: new ObjectId(id) });
  if (!build)
    return c.json(
      { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
      404,
    );
  const installOptions = await db.db
    .collection("files")
    .aggregate<{ _id: string; files: number; size: number }>([
      {
        $match: {
          ...snapshotQuery(build),
          installTags: { $exists: true, $not: { $size: 0 } },
        },
      },
      { $unwind: "$installTags" },
      {
        $group: {
          _id: "$installTags",
          files: { $sum: 1 },
          size: { $sum: { $ifNull: ["$fileSize", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return c.json(
    Object.fromEntries(
      installOptions.map(({ _id, files, size }) => [_id, { files, size }]),
    ),
  );
});

export default app;
