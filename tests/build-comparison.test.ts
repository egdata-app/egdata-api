import { describe, expect, it } from "vitest";
import {
  type BuildFileSnapshot,
  compareBuildFileSnapshots,
} from "../src/utils/build-comparison.js";

async function* files(values: BuildFileSnapshot[]) {
  for (const value of values) yield value;
}

const filters = {
  statuses: new Set(["added", "removed", "modified", "unchanged"] as const),
  page: 1,
  limit: 50,
  direction: "asc" as const,
};

describe("build comparison", () => {
  it("reports added, removed, modified, and unchanged paths", async () => {
    const result = await compareBuildFileSnapshots(
      files([
        { fileName: "A.txt", fileHash: "old", fileSize: 10 },
        { fileName: "B.bin", fileHash: "same", fileSize: 20 },
        { fileName: "Removed.pak", fileHash: "removed", fileSize: 30 },
      ]),
      files([
        { fileName: "A.txt", fileHash: "new", fileSize: 15 },
        { fileName: "Added.dll", fileHash: "added", fileSize: 40 },
        { fileName: "B.bin", fileHash: "same", fileSize: 20 },
      ]),
      filters,
    );

    expect(result.files).toEqual({
      added: 1,
      removed: 1,
      modified: 1,
      unchanged: 1,
      total: 4,
    });
    expect(result.fileBytes).toMatchObject({ base: 60, target: 75, delta: 15 });
    expect(result.changes.map(({ path, status }) => [path, status])).toEqual([
      ["A.txt", "modified"],
      ["Added.dll", "added"],
      ["B.bin", "unchanged"],
      ["Removed.pak", "removed"],
    ]);
  });

  it("treats install tags and symlinks as semantic modifications", async () => {
    const result = await compareBuildFileSnapshots(
      files([
        {
          fileName: "A",
          fileHash: "same",
          fileSize: 1,
          installTags: ["base"],
          symlinkTarget: "old",
        },
      ]),
      files([
        {
          fileName: "A",
          fileHash: "same",
          fileSize: 1,
          installTags: ["target"],
          symlinkTarget: "new",
        },
      ]),
      filters,
    );
    expect(result.files.modified).toBe(1);
    expect(result.installTags).toEqual({
      added: ["target"],
      removed: ["base"],
    });
  });

  it("keeps global summary independent from filters and pagination", async () => {
    const result = await compareBuildFileSnapshots(
      files([{ fileName: "A.txt", fileHash: "a", fileSize: 1 }]),
      files([
        { fileName: "A.txt", fileHash: "b", fileSize: 2 },
        { fileName: "B.dll", fileHash: "c", fileSize: 3 },
      ]),
      {
        ...filters,
        statuses: new Set(["added"]),
        extensions: new Set(["dll"]),
        limit: 1,
      },
    );
    expect(result.files).toMatchObject({ added: 1, modified: 1 });
    expect(result.total).toBe(1);
    expect(result.changes).toHaveLength(1);
  });
});
