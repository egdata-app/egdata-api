import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { db } from "../../db/index.js";
import { Asset, Item } from "../../models/index.js";
import {
  type LauncherRecordResolveResult,
  launcherRecordResolveRequestSchema,
  resolveLauncherRecord,
} from "../../routes/build-launcher-records.js";
import type {
  BuildFileChange,
  BuildFileChangeStatus,
  BuildFileSnapshot,
} from "../../utils/build-comparison.js";
import { normalizeBuildTreePath } from "../../utils/build-file-tree.js";
import {
  type BuildDocument,
  buildManifestStatus,
  buildSnapshotQuery,
  buildSummary,
  effectiveBuildPlatform,
} from "../../utils/builds.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import {
  badRequest,
  issuesToProblemIssues,
  notFound,
  ProblemError,
  problemResponse,
} from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  parseCsv,
  parseStrictQuery,
  querySchema,
  readJsonBody,
  requireIdParam,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import { isoOrNull, serializeItem, serializeValue } from "../serialization.js";

type AnyRecord = Record<string, any>;
/** MongoDB query document; field conditions are assembled per operation. */
type MongoFilter = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const LIST_TTL_SECONDS = 60;
const DETAIL_TTL_SECONDS = 120;
const SNAPSHOT_TTL_SECONDS = 300;
const INSTALL_OPTIONS_TTL_SECONDS = 300;
const INSTALL_OPTION_LIMIT = 200;
const MAX_FILTERED_EXTENSIONS = 20;
const TOP_ENTRIES_LIMIT = 10;

// Builds are global catalog data, so their cursors bind no region or locale.
// The empty values still participate in the signed cursor binding for
// consistency with the other v1 operations.
const GLOBAL_CURSOR_SCOPE = { country: "", locale: "" };

const BUILD_SORT_FIELDS = ["createdAt", "updatedAt", "firstSeenAt"] as const;
type BuildSortField = (typeof BUILD_SORT_FIELDS)[number];

const BUILD_FILE_SORT_FIELDS = ["depth", "fileName", "fileSize"] as const;
type BuildFileSortField = (typeof BUILD_FILE_SORT_FIELDS)[number];

const BUILD_CHANGE_STATUSES: readonly BuildFileChangeStatus[] = [
  "added",
  "removed",
  "modified",
  "unchanged",
];

const DEFAULT_COMPARE_STATUSES: readonly BuildFileChangeStatus[] = [
  "added",
  "modified",
  "removed",
];

const BUILD_HISTORY_SORT: MongoSortField[] = [
  { field: "firstSeenAt", direction: -1, nulls: "last" },
  { field: "createdAt", direction: -1, nulls: "last" },
  { field: "_id", direction: -1, nulls: "last" },
];

const BUILD_ITEM_SORT: MongoSortField[] = [
  { field: "id", direction: 1, nulls: "first" },
];

const BUILD_TREE_SORT: MongoSortField[] = [
  { field: "_id.type", direction: 1, nulls: "first" },
  { field: "_id.name", direction: 1, nulls: "first" },
];

const BUILD_HISTORY_ORDERING = "firstSeenAt:desc,createdAt:desc,_id:desc";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const uniqueStrings = (values: unknown[]): string[] => [
  ...new Set(values.filter(isString)),
];

/**
 * `mongoKeysetFilter` accepts MongoDB scalars such as `Date` and `ObjectId`
 * even though its tuple type is declared for JSON cursor values.
 */
const keysetFilter = (sort: MongoSortField[], tuple: unknown[]): MongoFilter =>
  mongoKeysetFilter(sort, tuple as Array<string | number | null>);

const cursorDate = (value: string | number | null): Date | null => {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const cursorObjectId = (
  value: string | number | null,
): ObjectId | string | number | null => {
  if (typeof value !== "string") return value;
  return /^[0-9a-fA-F]{24}$/.test(value) ? new ObjectId(value) : value;
};

const buildObjectId = (value: string): ObjectId => {
  if (!/^[0-9a-fA-F]{24}$/.test(value)) {
    throw badRequest(
      "INVALID_BUILD_ID",
      `The build identifier '${value}' is not a valid build id.`,
      [
        {
          parameter: "id",
          code: "INVALID",
          message: "Expected a 24-character hexadecimal build id.",
        },
      ],
    );
  }
  return new ObjectId(value);
};

const buildsCollection = () => db.db.collection<BuildDocument>("builds");

async function loadBuild(
  id: string,
): Promise<{ objectId: ObjectId; build: BuildDocument }> {
  const objectId = buildObjectId(id);
  const build = await buildsCollection().findOne({ _id: objectId });
  if (!build) {
    throw notFound("BUILD_NOT_FOUND", `No build matches '${id}'.`);
  }
  return { objectId, build };
}

function isComparable(build: BuildDocument): boolean {
  return (
    ["verified", "legacy_unverified"].includes(buildManifestStatus(build)) &&
    typeof build.manifestId === "string"
  );
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

const buildSortValue = (
  build: AnyRecord,
  field: BuildSortField,
): string | null => isoOrNull(build[field]);

const buildListTuple = (
  build: AnyRecord,
  field: BuildSortField,
): Array<string | number | null> => [
  buildSortValue(build, field),
  String(build._id),
];

async function listBuildsDescending(
  field: BuildSortField,
  limit: number,
  last: Array<string | number | null> | null,
): Promise<BuildDocument[]> {
  const sort: MongoSortField[] = [
    { field, direction: -1, nulls: "last" },
    { field: "_id", direction: -1, nulls: "last" },
  ];
  const filter: MongoFilter = {};
  if (last) {
    filter.$and = [
      keysetFilter(sort, [
        cursorDate(last[0] ?? null),
        cursorObjectId(last[1] ?? null),
      ]),
    ];
  }
  return buildsCollection()
    .find(filter)
    .sort(mongoSortSpec(sort))
    .limit(limit + 1)
    .toArray();
}

/**
 * Ascending pages keep missing timestamps last, matching the descending order.
 * MongoDB sorts missing values first in ascending order, so the null group is
 * appended after the non-null stream instead of relying on the index sort.
 */
async function listBuildsAscending(
  field: BuildSortField,
  limit: number,
  last: Array<string | number | null> | null,
): Promise<BuildDocument[]> {
  const collection = buildsCollection();
  const nullPhase = last !== null && last[0] === null;
  if (nullPhase) {
    const filter: MongoFilter = { [field]: null };
    if (last[1] !== null && last[1] !== undefined) {
      filter._id = { $gt: cursorObjectId(last[1]) };
    }
    return collection
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();
  }

  const valueSort: MongoSortField[] = [
    { field, direction: 1, nulls: "first" },
    { field: "_id", direction: 1, nulls: "first" },
  ];
  const valueFilter: MongoFilter = { [field]: { $ne: null } };
  if (last) {
    valueFilter.$and = [
      keysetFilter(valueSort, [
        cursorDate(last[0] ?? null),
        cursorObjectId(last[1] ?? null),
      ]),
    ];
  }
  const valueRows = await collection
    .find(valueFilter)
    .sort(mongoSortSpec(valueSort))
    .limit(limit + 1)
    .toArray();
  if (valueRows.length > limit) return valueRows;

  const remaining = limit - valueRows.length;
  const nullRows = await collection
    .find({ [field]: null })
    .sort({ _id: 1 })
    .limit(remaining + 1)
    .toArray();
  if (remaining === 0) {
    // The page is full of non-null rows. A null row only proves there is
    // another page, so keep the full value page and let `trimPage` report it.
    return nullRows.length > 0 ? [...valueRows, nullRows[0]] : valueRows;
  }
  return [...valueRows, ...nullRows];
}

async function findPreviousComparableBuildId(
  build: BuildDocument,
  platform: string,
): Promise<string | null> {
  const collection = buildsCollection();
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
      isComparable(observed) &&
      effectiveBuildPlatform(observed) === platform
    ) {
      return observed._id.toString();
    }
  }

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
  return previous ? previous._id.toString() : null;
}

const parseExtensions = (value: string | undefined): Set<string> | null => {
  const entries = parseCsv(value);
  if (!entries) return null;
  const normalized = entries
    .map((entry) => entry.replace(/^\./, "").toLowerCase())
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0) return null;
  if (normalized.length > MAX_FILTERED_EXTENSIONS) {
    throw badRequest(
      "INVALID_QUERY",
      `At most ${MAX_FILTERED_EXTENSIONS} distinct extensions can be filtered at once.`,
      [
        {
          parameter: "extension",
          code: "TOO_MANY",
          message: `The parameter contains ${normalized.length} distinct extensions.`,
        },
      ],
    );
  }
  return new Set(normalized);
};

// --------------------------------------------------------------------------
// Snapshot comparison
// --------------------------------------------------------------------------

type ComparisonFilters = {
  statuses: Set<BuildFileChangeStatus>;
  query: string | null;
  extensions: Set<string> | null;
  afterPath: string | null;
  direction: "asc" | "desc";
  limit: number;
};

type ComparisonBytes = {
  base: number;
  target: number;
  delta: number;
  added: number;
  removed: number;
  modifiedBase: number;
  modifiedTarget: number;
};

type ComparisonResult = {
  changes: BuildFileChange[];
  hasMore: boolean;
  files: Record<BuildFileChangeStatus, number> & { total: number };
  fileBytes: ComparisonBytes;
  installTags: { added: string[]; removed: string[] };
  topFiles: BuildFileChange[];
  topDirectories: Array<{ path: string; sizeDeltaBytes: number }>;
};

const canonicalTags = (tags: string[] | undefined): string[] =>
  [...new Set(tags ?? [])].sort();

const sameTags = (left: string[], right: string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const snapshotContentChanged = (
  before: BuildFileSnapshot,
  after: BuildFileSnapshot,
): boolean =>
  before.fileHash !== after.fileHash ||
  before.fileSize !== after.fileSize ||
  (before.symlinkTarget ?? "") !== (after.symlinkTarget ?? "") ||
  (before.fileMetaFlags ?? 0) !== (after.fileMetaFlags ?? 0) ||
  !sameTags(
    canonicalTags(before.installTags),
    canonicalTags(after.installTags),
  );

const changeFor = (
  before: BuildFileSnapshot | null,
  after: BuildFileSnapshot | null,
): BuildFileChange => {
  const status: BuildFileChangeStatus = !before
    ? "added"
    : !after
      ? "removed"
      : snapshotContentChanged(before, after)
        ? "modified"
        : "unchanged";
  return {
    path: after?.fileName ?? before?.fileName ?? "",
    status,
    before,
    after,
    sizeDeltaBytes: (after?.fileSize ?? 0) - (before?.fileSize ?? 0),
  };
};

const fileExtensionOf = (path: string): string => {
  const fileName = path.split(/[\\/]/).at(-1) ?? path;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
};

const parentDirectoryOf = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "/" : normalized.slice(0, separator) || "/";
};

/**
 * Both snapshots are stored in MongoDB binary string order, so the merge join
 * can be streamed without buffering either side.
 */
const compareMongoStrings = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

const matchesComparisonFilters = (
  change: BuildFileChange,
  filters: ComparisonFilters,
): boolean => {
  if (!filters.statuses.has(change.status)) return false;
  if (
    filters.query &&
    !change.path.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())
  ) {
    return false;
  }
  if (
    filters.extensions &&
    filters.extensions.size > 0 &&
    !filters.extensions.has(fileExtensionOf(change.path))
  ) {
    return false;
  }
  return true;
};

const isAfterComparisonCursor = (
  path: string,
  filters: ComparisonFilters,
): boolean => {
  if (!filters.afterPath) return true;
  const order = compareMongoStrings(path, filters.afterPath);
  return filters.direction === "asc" ? order > 0 : order < 0;
};

async function nextSnapshot(
  iterator: AsyncIterator<BuildFileSnapshot>,
): Promise<BuildFileSnapshot | null> {
  const result = await iterator.next();
  return result.done ? null : result.value;
}

/**
 * Streams both snapshots once, collecting the complete comparison summary and
 * one cursor page of changes. Memory stays bounded by the page size plus the
 * top-file and top-directory caps, independent of the snapshot size.
 */
async function compareSnapshotPage(
  baseFiles: AsyncIterable<BuildFileSnapshot>,
  targetFiles: AsyncIterable<BuildFileSnapshot>,
  filters: ComparisonFilters,
): Promise<ComparisonResult> {
  const baseIterator = baseFiles[Symbol.asyncIterator]();
  const targetIterator = targetFiles[Symbol.asyncIterator]();
  let before = await nextSnapshot(baseIterator);
  let after = await nextSnapshot(targetIterator);

  const files: Record<BuildFileChangeStatus, number> & { total: number } = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
    total: 0,
  };
  const fileBytes: ComparisonBytes = {
    base: 0,
    target: 0,
    delta: 0,
    added: 0,
    removed: 0,
    modifiedBase: 0,
    modifiedTarget: 0,
  };
  const baseTags = new Set<string>();
  const targetTags = new Set<string>();
  const topFiles: BuildFileChange[] = [];
  const directoryDeltas = new Map<string, number>();
  const changes: BuildFileChange[] = [];
  let hasMore = false;

  const record = (change: BuildFileChange) => {
    files[change.status] += 1;
    files.total += 1;
    fileBytes.base += change.before?.fileSize ?? 0;
    fileBytes.target += change.after?.fileSize ?? 0;
    for (const tag of change.before?.installTags ?? []) baseTags.add(tag);
    for (const tag of change.after?.installTags ?? []) targetTags.add(tag);

    if (change.status === "added") {
      fileBytes.added += change.after?.fileSize ?? 0;
    }
    if (change.status === "removed") {
      fileBytes.removed += change.before?.fileSize ?? 0;
    }
    if (change.status === "modified") {
      fileBytes.modifiedBase += change.before?.fileSize ?? 0;
      fileBytes.modifiedTarget += change.after?.fileSize ?? 0;
    }
    if (change.status !== "unchanged") {
      topFiles.push(change);
      topFiles.sort(
        (left, right) =>
          Math.abs(right.sizeDeltaBytes) - Math.abs(left.sizeDeltaBytes),
      );
      if (topFiles.length > TOP_ENTRIES_LIMIT) {
        topFiles.length = TOP_ENTRIES_LIMIT;
      }
      const directory = parentDirectoryOf(change.path);
      directoryDeltas.set(
        directory,
        (directoryDeltas.get(directory) ?? 0) + change.sizeDeltaBytes,
      );
    }

    if (!matchesComparisonFilters(change, filters)) return;
    if (!isAfterComparisonCursor(change.path, filters)) return;
    if (changes.length < filters.limit) {
      changes.push(change);
    } else {
      hasMore = true;
    }
  };

  while (before || after) {
    if (!before) {
      record(changeFor(null, after));
      after = await nextSnapshot(targetIterator);
      continue;
    }
    if (!after) {
      record(changeFor(before, null));
      before = await nextSnapshot(baseIterator);
      continue;
    }

    const order = compareMongoStrings(before.fileName, after.fileName);
    if (order === 0) {
      record(changeFor(before, after));
      before = await nextSnapshot(baseIterator);
      after = await nextSnapshot(targetIterator);
    } else if (
      (filters.direction === "asc" && order < 0) ||
      (filters.direction === "desc" && order > 0)
    ) {
      record(changeFor(before, null));
      before = await nextSnapshot(baseIterator);
    } else {
      record(changeFor(null, after));
      after = await nextSnapshot(targetIterator);
    }
  }

  fileBytes.delta = fileBytes.target - fileBytes.base;
  const topDirectories = [...directoryDeltas]
    .map(([path, sizeDeltaBytes]) => ({ path, sizeDeltaBytes }))
    .sort(
      (left, right) =>
        Math.abs(right.sizeDeltaBytes) - Math.abs(left.sizeDeltaBytes),
    )
    .slice(0, TOP_ENTRIES_LIMIT);

  return {
    changes,
    hasMore,
    files,
    fileBytes,
    installTags: {
      added: [...targetTags].filter((tag) => !baseTags.has(tag)).sort(),
      removed: [...baseTags].filter((tag) => !targetTags.has(tag)).sort(),
    },
    topFiles,
    topDirectories,
  };
}

const fileSortTuple = (
  sort: BuildFileSortField,
  row: AnyRecord,
): Array<string | number | null> => {
  const fileName = isString(row.fileName) ? row.fileName : null;
  if (sort === "fileName") return [fileName];
  const value = sort === "depth" ? row.depth : row.fileSize;
  return [typeof value === "number" ? value : null, fileName];
};

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

app.get("/builds", async (c) => {
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    sortBy: z.enum(BUILD_SORT_FIELDS).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const sortBy: BuildSortField = query.sortBy ?? "createdAt";
  const sortDir = query.sortDir ?? "desc";
  const cursorBinding = {
    operation: "builds.list",
    filters: {},
    ordering: `${sortBy}:${sortDir},_id:${sortDir}`,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("builds.list", { sortBy, sortDir, limit, cursor }),
    LIST_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const rows =
        sortDir === "asc"
          ? await listBuildsAscending(sortBy, limit, last)
          : await listBuildsDescending(sortBy, limit, last);
      const { items, hasMore } = trimPage(rows, limit);
      const appNames = uniqueStrings(items.map((build) => build.appName));
      const catalogItems =
        appNames.length === 0
          ? []
          : await Item.find({
              "releaseInfo.appId": { $in: appNames },
              entitlementType: "EXECUTABLE",
            }).lean();

      const data = items.map((build) => {
        const item = catalogItems.find(
          (candidate) =>
            Array.isArray(candidate.releaseInfo) &&
            candidate.releaseInfo.some(
              (release: AnyRecord) => release?.appId === build.appName,
            ),
        );
        return {
          ...(serializeValue(buildSummary(build)) as AnyRecord),
          item: item ? serializeItem(item) : null,
        };
      });
      const lastBuild = items.at(-1);

      return {
        data,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastBuild
            ? encodeCursor(cursorBinding, buildListTuple(lastBuild, sortBy))
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    sortBy,
    sortDir,
    pagination: result.pagination,
  });
});

app.get("/builds/:id", async (c) => {
  parseStrictQuery(c, {});
  const id = requireIdParam(c);

  const result = await cached<unknown>(
    v1CacheKey("builds.detail", { id }),
    DETAIL_TTL_SECONDS,
    async () => {
      const build = await buildsCollection().findOne({
        _id: buildObjectId(id),
      });
      if (!build) return null;
      const asset = await Asset.findOne({
        artifactId: { $eq: build.appName },
        platform: { $eq: effectiveBuildPlatform(build) },
      }).lean();
      return serializeValue(buildSummary(build, asset));
    },
  );

  if (result === null) {
    throw notFound("BUILD_NOT_FOUND", `No build matches '${id}'.`);
  }

  return jsonSuccess(c, result);
});

app.get("/builds/:id/history", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    scope: z.enum(["stream", "platform"]).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const scope = query.scope ?? "stream";
  const { build } = await loadBuild(id);
  const platform = effectiveBuildPlatform(build);
  const cursorBinding = {
    operation: "builds.history",
    filters: { id, scope },
    ordering: BUILD_HISTORY_ORDERING,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("builds.history", { id, scope, limit, cursor }),
    LIST_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const filter: MongoFilter = { appName: build.appName };
      if (scope === "stream") {
        filter.labelName = build.labelName;
      } else {
        filter.$or = [
          { platform },
          {
            platform: { $exists: false },
            labelName: {
              $regex: new RegExp(`-${escapeRegex(platform)}$`, "i"),
            },
          },
        ];
      }
      const conditions: MongoFilter[] = [filter];
      if (last) {
        conditions.push(
          keysetFilter(BUILD_HISTORY_SORT, [
            cursorDate(last[0] ?? null),
            cursorDate(last[1] ?? null),
            cursorObjectId(last[2] ?? null),
          ]),
        );
      }

      const rows = await buildsCollection()
        .find(conditions.length === 1 ? filter : { $and: conditions })
        .sort(mongoSortSpec(BUILD_HISTORY_SORT))
        .limit(limit + 1)
        .toArray();
      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items.at(-1);
      const previousComparableBuildId = await findPreviousComparableBuildId(
        build,
        platform,
      );

      return {
        data: items.map((entry) => ({
          ...(serializeValue(buildSummary(entry)) as AnyRecord),
          comparable: isComparable(entry),
          sameStream: entry.labelName === build.labelName,
        })),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(cursorBinding, [
                isoOrNull(lastRow.firstSeenAt),
                isoOrNull(lastRow.createdAt),
                String(lastRow._id),
              ])
            : null,
        ),
        previousComparableBuildId,
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    scope,
    previousComparableBuildId: result.previousComparableBuildId,
    pagination: result.pagination,
  });
});

app.get("/builds/:targetId/compare/:baseId", async (c) => {
  const targetId = requireIdParam(c, "targetId");
  const baseId = requireIdParam(c, "baseId");
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    dir: z.enum(["asc", "desc"]).optional(),
    q: z.string().max(200).optional(),
    status: z.string().max(500).optional(),
    extension: z.string().max(500).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const direction = query.dir ?? "asc";
  const search = query.q?.trim().toLowerCase() || null;
  const statusValues =
    parseCsv(query.status) ?? [...DEFAULT_COMPARE_STATUSES].sort();
  const invalidStatus = statusValues.find(
    (status) =>
      !BUILD_CHANGE_STATUSES.includes(status as BuildFileChangeStatus),
  );
  if (invalidStatus) {
    throw badRequest(
      "INVALID_QUERY",
      `The \`status\` parameter contains an unsupported status '${invalidStatus}'.`,
      [
        {
          parameter: "status",
          code: "INVALID",
          message: "Expected added, removed, modified, or unchanged.",
        },
      ],
    );
  }
  const statuses = new Set(statusValues as BuildFileChangeStatus[]);
  const extensions = parseExtensions(query.extension);
  const extensionList = extensions ? [...extensions].sort() : null;

  const [{ build: target }, { build: base }] = await Promise.all([
    loadBuild(targetId),
    loadBuild(baseId),
  ]);

  if (
    target.appName !== base.appName ||
    effectiveBuildPlatform(target) !== effectiveBuildPlatform(base)
  ) {
    throw badRequest(
      "INCOMPATIBLE_BUILDS",
      "Both builds must use the same app name and platform.",
    );
  }
  if (!isComparable(target) || !isComparable(base)) {
    throw new ProblemError({
      status: 409,
      code: "MANIFEST_NOT_COMPARABLE",
      detail:
        "Both builds must have a stored file snapshot before they can be compared.",
    });
  }

  const cursorBinding = {
    operation: "builds.compare",
    filters: {
      targetId,
      baseId,
      dir: direction,
      statuses: [...statuses].sort(),
      extensions: extensionList,
      q: search,
    },
    ordering: `fileName:${direction}`,
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("builds.compare", {
      targetId,
      baseId,
      targetUpdatedAt: target.updatedAt?.getTime() ?? 0,
      baseUpdatedAt: base.updatedAt?.getTime() ?? 0,
      dir: direction,
      statuses: [...statuses].sort(),
      extensions: extensionList,
      q: search,
      limit,
      cursor,
    }),
    SNAPSHOT_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const afterPath = typeof last?.[0] === "string" ? last[0] : null;
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
      const fileSort = { fileName: direction === "asc" ? 1 : -1 } as const;
      const files = db.db.collection<BuildFileSnapshot>("files");
      const comparison = await compareSnapshotPage(
        files.find(buildSnapshotQuery(base), { projection }).sort(fileSort),
        files.find(buildSnapshotQuery(target), { projection }).sort(fileSort),
        {
          statuses,
          query: search,
          extensions,
          afterPath,
          direction,
          limit,
        },
      );
      const lastChange = comparison.changes.at(-1);

      return {
        data: {
          base: serializeValue(buildSummary(base)),
          target: serializeValue(buildSummary(target)),
          comparisonScope:
            base.labelName === target.labelName
              ? "same_stream"
              : "cross_stream",
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
        },
        pagination: pageMeta(
          limit,
          comparison.hasMore,
          comparison.hasMore && lastChange
            ? encodeCursor(cursorBinding, [lastChange.path])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.changes.length,
    pagination: result.pagination,
  });
});

app.get("/builds/:id/files", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    sort: z.enum(BUILD_FILE_SORT_FIELDS).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    q: z.string().max(200).optional(),
    extension: z.string().max(500).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const sort: BuildFileSortField = query.sort ?? "depth";
  const direction = query.dir ?? "asc";
  const dirValue = direction === "asc" ? 1 : -1;
  const nulls = dirValue === 1 ? "first" : "last";
  const search = query.q?.trim() || null;
  const extensions = parseExtensions(query.extension);
  const { build } = await loadBuild(id);

  const sortFields: MongoSortField[] =
    sort === "fileName"
      ? [{ field: "fileName", direction: dirValue, nulls }]
      : [
          { field: sort, direction: dirValue, nulls },
          { field: "fileName", direction: dirValue, nulls },
        ];
  const cursorBinding = {
    operation: "builds.files",
    filters: {
      id,
      sort,
      dir: direction,
      q: search,
      extensions: extensions ? [...extensions].sort() : null,
    },
    ordering: sortFields
      .map(
        (field) => `${field.field}:${field.direction === 1 ? "asc" : "desc"}`,
      )
      .join(","),
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("builds.files", {
      id,
      sort,
      dir: direction,
      q: search,
      extensions: extensions ? [...extensions].sort() : null,
      limit,
      cursor,
    }),
    SNAPSHOT_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const conditions: MongoFilter[] = [buildSnapshotQuery(build)];
      if (search) {
        conditions.push({
          fileName: { $regex: new RegExp(escapeRegex(search), "i") },
        });
      }
      if (extensions && extensions.size > 0) {
        conditions.push({
          fileName: {
            $regex: new RegExp(
              `\\.(${[...extensions].map(escapeRegex).join("|")})$`,
              "i",
            ),
          },
        });
      }
      if (last) conditions.push(keysetFilter(sortFields, last));

      const rows = await db.db
        .collection("files")
        .find(conditions.length === 1 ? conditions[0] : { $and: conditions })
        .sort(mongoSortSpec(sortFields))
        .limit(limit + 1)
        .toArray();
      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items.at(-1);

      return {
        data: items.map((row) => serializeValue(row)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(cursorBinding, fileSortTuple(sort, lastRow))
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    manifestStatus: buildManifestStatus(build),
    pagination: result.pagination,
  });
});

app.get("/builds/:id/tree", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    path: z.string().max(500).optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const { build } = await loadBuild(id);
  const path = normalizeBuildTreePath(query.path);
  if (path === null) {
    throw badRequest(
      "INVALID_PATH",
      "The `path` parameter must be a relative manifest directory that uses forward slashes and does not ascend above the build root.",
      [
        {
          parameter: "path",
          code: "INVALID",
          message: "Expected a normalized relative directory path.",
        },
      ],
    );
  }
  const cursorBinding = {
    operation: "builds.tree",
    filters: { id, path },
    ordering: "type:asc,name:asc",
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("builds.tree", { id, path, limit, cursor }),
    SNAPSHOT_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const childPrefix = path ? `${path}/` : "";
      const pathFilter = childPrefix
        ? { fileName: { $regex: new RegExp(`^${escapeRegex(childPrefix)}`) } }
        : { fileName: { $type: "string" } };

      const pipeline: Record<string, unknown>[] = [
        { $match: { $and: [buildSnapshotQuery(build), pathFilter] } },
        {
          $set: {
            relativePath: childPrefix
              ? {
                  $replaceOne: {
                    input: "$fileName",
                    find: childPrefix,
                    replacement: "",
                  },
                }
              : "$fileName",
          },
        },
        {
          $set: {
            nodeType: {
              $cond: [
                { $regexMatch: { input: "$relativePath", regex: "/" } },
                "directory",
                "file",
              ],
            },
            nodeName: {
              $arrayElemAt: [{ $split: ["$relativePath", "/"] }, 0],
            },
          },
        },
        {
          $group: {
            _id: { type: "$nodeType", name: "$nodeName" },
            fileCount: { $sum: 1 },
            totalSize: { $sum: { $ifNull: ["$fileSize", 0] } },
            file: { $first: "$$ROOT" },
          },
        },
      ];
      if (last) {
        pipeline.push({
          $match: keysetFilter(BUILD_TREE_SORT, [
            last[0] ?? null,
            last[1] ?? null,
          ]),
        });
      }
      pipeline.push(
        { $sort: { "_id.type": 1, "_id.name": 1 } },
        { $limit: limit + 1 },
        {
          $project: {
            _id: 0,
            type: "$_id.type",
            name: "$_id.name",
            fileCount: {
              $cond: [
                { $eq: ["$_id.type", "directory"] },
                "$fileCount",
                "$$REMOVE",
              ],
            },
            totalSize: {
              $cond: [
                { $eq: ["$_id.type", "directory"] },
                "$totalSize",
                "$$REMOVE",
              ],
            },
            file: {
              $cond: [
                { $eq: ["$_id.type", "file"] },
                {
                  _id: "$file._id",
                  manifestHash: "$file.manifestHash",
                  manifestId: "$file.manifestId",
                  snapshotVerification: "$file.snapshotVerification",
                  appName: "$file.appName",
                  buildVersion: "$file.buildVersion",
                  appLabel: "$file.appLabel",
                  fileName: "$file.fileName",
                  symlinkTarget: "$file.symlinkTarget",
                  fileHash: "$file.fileHash",
                  fileMetaFlags: "$file.fileMetaFlags",
                  installTags: "$file.installTags",
                  fileSize: "$file.fileSize",
                  mimeType: "$file.mimeType",
                  depth: "$file.depth",
                },
                "$$REMOVE",
              ],
            },
          },
        },
      );

      const rows = await db.db
        .collection("files")
        .aggregate(pipeline)
        .toArray();
      const { items, hasMore } = trimPage(rows, limit);
      const nodes: AnyRecord[] = items.map((row) => {
        const node = serializeValue(row) as AnyRecord;
        return {
          ...node,
          path: path ? `${path}/${String(node.name)}` : String(node.name),
        };
      });
      const lastNode = nodes.at(-1);

      return {
        nodes,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastNode
            ? encodeCursor(cursorBinding, [
                String(lastNode.type),
                String(lastNode.name),
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.nodes, {
    count: result.nodes.length,
    path,
    manifestStatus: buildManifestStatus(build),
    pagination: result.pagination,
  });
});

app.get("/builds/:id/items", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, querySchema.pagination);
  const { limit, cursor } = parsePagination(query);
  const { build } = await loadBuild(id);
  const cursorBinding = {
    operation: "builds.items",
    filters: { id },
    ordering: "id:asc",
    ...GLOBAL_CURSOR_SCOPE,
    limit,
  };

  const result = await cached(
    v1CacheKey("builds.items", { id, limit, cursor }),
    LIST_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;
      const conditions: MongoFilter[] = [
        { "releaseInfo.appId": build.appName },
      ];
      if (last) {
        conditions.push(keysetFilter(BUILD_ITEM_SORT, [last[0] ?? null]));
      }
      const rows = await Item.find(
        conditions.length === 1 ? conditions[0] : { $and: conditions },
        undefined,
        { limit: limit + 1, sort: { id: 1 } },
      ).lean();
      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items.at(-1);

      return {
        data: items.map((item) => serializeItem(item)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(cursorBinding, [
                isString(lastRow.id) ? lastRow.id : null,
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.data, {
    count: result.data.length,
    pagination: result.pagination,
  });
});

app.get("/builds/:id/install-options", async (c) => {
  parseStrictQuery(c, {});
  const id = requireIdParam(c);
  const { build } = await loadBuild(id);

  const result = await cached(
    v1CacheKey("builds.install-options", { id }),
    INSTALL_OPTIONS_TTL_SECONDS,
    async () => {
      const rows = await db.db
        .collection("files")
        .aggregate<{ _id: string; files: number; size: number }>([
          {
            $match: {
              ...buildSnapshotQuery(build),
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
          { $limit: INSTALL_OPTION_LIMIT },
        ])
        .toArray();

      return {
        options: Object.fromEntries(
          rows.map(({ _id, files, size }) => [_id, { files, size }]),
        ),
        truncated: rows.length >= INSTALL_OPTION_LIMIT,
      };
    },
  );

  return jsonSuccess(c, result.options, {
    count: Object.keys(result.options).length,
    truncated: result.truncated,
  });
});

app.post("/builds/resolve-launcher-records", async (c) => {
  parseStrictQuery(c, {});
  const body = await readJsonBody(c);
  const parsed = launcherRecordResolveRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(
      "INVALID_BODY",
      "One or more candidates are invalid or not supported. Each candidate must carry a unique `requestId`, a Windows platform, and bounded metadata without paths or manifest bytes.",
      issuesToProblemIssues(parsed.error.issues),
    );
  }

  const results: LauncherRecordResolveResult[] = [];
  for (const candidate of parsed.data.candidates) {
    results.push(await resolveLauncherRecord(candidate));
  }

  return jsonSuccess(c, { results }, { count: results.length });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
