export type BuildFileSnapshot = {
  fileName: string;
  fileHash: string;
  fileSize: number;
  mimeType?: string;
  installTags?: string[];
  symlinkTarget?: string;
  fileMetaFlags?: number;
};

export type BuildFileChangeStatus =
  | "added"
  | "removed"
  | "modified"
  | "unchanged";

export type BuildFileChange = {
  path: string;
  status: BuildFileChangeStatus;
  before: BuildFileSnapshot | null;
  after: BuildFileSnapshot | null;
  sizeDeltaBytes: number;
};

export type BuildComparisonFilters = {
  statuses: Set<BuildFileChangeStatus>;
  query?: string;
  extensions?: Set<string>;
  page: number;
  limit: number;
  direction: "asc" | "desc";
};

type FileCounts = Record<BuildFileChangeStatus, number> & { total: number };

function canonicalTags(tags: string[] | undefined): string[] {
  return [...new Set(tags ?? [])].sort();
}

function sameArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isModified(
  before: BuildFileSnapshot,
  after: BuildFileSnapshot,
): boolean {
  return (
    before.fileHash !== after.fileHash ||
    before.fileSize !== after.fileSize ||
    (before.symlinkTarget ?? "") !== (after.symlinkTarget ?? "") ||
    (before.fileMetaFlags ?? 0) !== (after.fileMetaFlags ?? 0) ||
    !sameArray(
      canonicalTags(before.installTags),
      canonicalTags(after.installTags),
    )
  );
}

function changeFor(
  before: BuildFileSnapshot | null,
  after: BuildFileSnapshot | null,
): BuildFileChange {
  const status: BuildFileChangeStatus = !before
    ? "added"
    : !after
      ? "removed"
      : isModified(before, after)
        ? "modified"
        : "unchanged";
  return {
    path: after?.fileName ?? before?.fileName ?? "",
    status,
    before,
    after,
    sizeDeltaBytes: (after?.fileSize ?? 0) - (before?.fileSize ?? 0),
  };
}

function fileExtension(path: string): string {
  const fileName = path.split(/[\\/]/).at(-1) ?? path;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function matchesFilters(
  change: BuildFileChange,
  filters: BuildComparisonFilters,
): boolean {
  if (!filters.statuses.has(change.status)) return false;
  if (
    filters.query &&
    !change.path.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())
  )
    return false;
  if (
    filters.extensions?.size &&
    !filters.extensions.has(fileExtension(change.path))
  )
    return false;
  return true;
}

function parentDirectory(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "/" : normalized.slice(0, separator) || "/";
}

async function nextValue(iterator: AsyncIterator<BuildFileSnapshot>) {
  const result = await iterator.next();
  return result.done ? null : result.value;
}

function sortedTop<T>(
  values: T[],
  score: (value: T) => number,
  limit = 10,
): T[] {
  return values
    .sort((left, right) => score(right) - score(left))
    .slice(0, limit);
}

export async function compareBuildFileSnapshots(
  baseFiles: AsyncIterable<BuildFileSnapshot>,
  targetFiles: AsyncIterable<BuildFileSnapshot>,
  filters: BuildComparisonFilters,
) {
  const baseIterator = baseFiles[Symbol.asyncIterator]();
  const targetIterator = targetFiles[Symbol.asyncIterator]();
  let before = await nextValue(baseIterator);
  let after = await nextValue(targetIterator);
  const counts: FileCounts = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
    total: 0,
  };
  const fileBytes = {
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
  let filteredTotal = 0;
  const firstRow = (filters.page - 1) * filters.limit;

  const record = (change: BuildFileChange) => {
    counts[change.status]++;
    counts.total++;
    fileBytes.base += change.before?.fileSize ?? 0;
    fileBytes.target += change.after?.fileSize ?? 0;
    for (const tag of change.before?.installTags ?? []) baseTags.add(tag);
    for (const tag of change.after?.installTags ?? []) targetTags.add(tag);

    if (change.status === "added")
      fileBytes.added += change.after?.fileSize ?? 0;
    if (change.status === "removed")
      fileBytes.removed += change.before?.fileSize ?? 0;
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
      if (topFiles.length > 10) topFiles.length = 10;
      const directory = parentDirectory(change.path);
      directoryDeltas.set(
        directory,
        (directoryDeltas.get(directory) ?? 0) + change.sizeDeltaBytes,
      );
    }

    if (!matchesFilters(change, filters)) return;
    if (filteredTotal >= firstRow && changes.length < filters.limit)
      changes.push(change);
    filteredTotal++;
  };

  while (before || after) {
    if (!before) {
      record(changeFor(null, after));
      after = await nextValue(targetIterator);
      continue;
    }
    if (!after) {
      record(changeFor(before, null));
      before = await nextValue(baseIterator);
      continue;
    }

    const order = before.fileName.localeCompare(after.fileName);
    if (order === 0) {
      record(changeFor(before, after));
      before = await nextValue(baseIterator);
      after = await nextValue(targetIterator);
    } else if (
      (filters.direction === "asc" && order < 0) ||
      (filters.direction === "desc" && order > 0)
    ) {
      record(changeFor(before, null));
      before = await nextValue(baseIterator);
    } else {
      record(changeFor(null, after));
      after = await nextValue(targetIterator);
    }
  }

  fileBytes.delta = fileBytes.target - fileBytes.base;
  return {
    files: counts,
    fileBytes,
    installTags: {
      added: [...targetTags].filter((tag) => !baseTags.has(tag)).sort(),
      removed: [...baseTags].filter((tag) => !targetTags.has(tag)).sort(),
    },
    topFiles: sortedTop(topFiles, (change) => Math.abs(change.sizeDeltaBytes)),
    topDirectories: sortedTop(
      [...directoryDeltas].map(([path, sizeDeltaBytes]) => ({
        path,
        sizeDeltaBytes,
      })),
      (directory) => Math.abs(directory.sizeDeltaBytes),
    ),
    changes,
    total: filteredTotal,
  };
}
