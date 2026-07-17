import { describe, expect, it } from "vitest";
import { normalizeBuildTreePath } from "../src/utils/build-file-tree.js";

describe("normalizeBuildTreePath", () => {
  it("keeps valid relative manifest directories", () => {
    expect(normalizeBuildTreePath(undefined)).toBe("");
    expect(normalizeBuildTreePath("/")).toBe("");
    expect(normalizeBuildTreePath("Engine/Binaries/")).toBe("Engine/Binaries");
  });

  it("rejects non-canonical and traversing paths", () => {
    for (const path of [
      "/Engine",
      "Engine\\Binaries",
      "Engine//Binaries",
      "Engine/../Config",
      "./Engine",
    ]) {
      expect(normalizeBuildTreePath(path)).toBeNull();
    }
  });
});
