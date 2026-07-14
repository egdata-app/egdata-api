import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { type BuildDocument, buildSnapshotQuery } from "../src/utils/builds.js";

function build(overrides: Partial<BuildDocument>): BuildDocument {
  return {
    _id: new ObjectId(),
    appName: "app",
    buildVersion: "1.0.0",
    labelName: "Live-Windows",
    hash: "source-hash",
    ...overrides,
  };
}

describe("buildSnapshotQuery", () => {
  it("uses the legacy manifest hash even when a canonical ID is present", () => {
    expect(
      buildSnapshotQuery(
        build({
          manifestStatus: "legacy_unverified",
          manifestId: "legacy:canonical-hash",
          sourceManifestHash: "legacy-source-hash",
        }),
      ),
    ).toEqual({ manifestHash: "legacy-source-hash" });
  });

  it("falls back to the build hash for older legacy snapshots", () => {
    expect(
      buildSnapshotQuery(
        build({
          manifestStatus: "legacy_unverified",
          manifestId: "legacy:canonical-hash",
        }),
      ),
    ).toEqual({ manifestHash: "source-hash" });
  });

  it("uses a canonical manifest ID for verified snapshots", () => {
    expect(
      buildSnapshotQuery(
        build({ manifestStatus: "verified", manifestId: "canonical-hash" }),
      ),
    ).toEqual({ manifestId: "canonical-hash" });
  });
});
