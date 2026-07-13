import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { type BuildDocument, buildSummary } from "../src/utils/builds.js";

describe("build response shaping", () => {
  it("removes raw manifest locations and preserves historical sizes", () => {
    const build = {
      _id: new ObjectId("67141fcefb3045682a6fbf19"),
      appName: "TestApp",
      buildVersion: "1.0",
      labelName: "Live-Windows",
      hash: "source-hash",
      manifestId: "canonical-hash",
      manifestStatus: "verified",
      downloadSizeBytes: 100,
      installedSizeBytes: 200,
      manifests: [{ uri: "https://example.invalid/signed-manifest" }],
    } satisfies BuildDocument;

    const result = buildSummary(build, {
      downloadSizeBytes: 999,
      installedSizeBytes: 999,
    });

    expect(result).not.toHaveProperty("manifests");
    expect(result.downloadSizeBytes).toBe(100);
    expect(result.installedSizeBytes).toBe(200);
    expect(result.manifest).toMatchObject({
      status: "verified",
      canonicalHash: "canonical-hash",
      sourceHash: "source-hash",
    });
  });

  it("uses asset sizes only when the build has no historical values", () => {
    const build = {
      _id: new ObjectId("67141fcefb3045682a6fbf19"),
      appName: "TestApp",
      buildVersion: "1.0",
      labelName: "Live-Windows",
      hash: "source-hash",
    } satisfies BuildDocument;

    const result = buildSummary(build, {
      downloadSizeBytes: 300,
      installedSizeBytes: 400,
    });

    expect(result.downloadSizeBytes).toBe(300);
    expect(result.installedSizeBytes).toBe(400);
  });
});
