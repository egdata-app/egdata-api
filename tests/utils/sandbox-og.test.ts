import { describe, expect, it } from "vitest";
import { countSandboxOgAssets } from "../../src/utils/sandbox-og.js";

describe("sandbox OG asset totals", () => {
  it("includes release platforms without double-counting stored artifacts", () => {
    expect(
      countSandboxOgAssets(
        [{ artifactId: "stored" }],
        [
          {
            releaseInfo: [
              { appId: "stored", platform: ["Windows", "Mac"] },
              { appId: "virtual", platform: ["Windows", "Mac"] },
            ],
          },
        ],
      ),
    ).toBe(3);
  });

  it("preserves the stats convention of counting each catalog release record", () => {
    expect(
      countSandboxOgAssets(
        [],
        [
          { releaseInfo: [{ appId: "virtual", platform: ["Windows"] }] },
          { releaseInfo: [{ appId: "virtual", platform: ["Windows"] }] },
        ],
      ),
    ).toBe(2);
  });

  it("handles empty catalogs and missing release metadata", () => {
    expect(countSandboxOgAssets([], [])).toBe(0);
    expect(
      countSandboxOgAssets(
        [],
        [
          {},
          { releaseInfo: [{ appId: "virtual" }, { platform: ["Windows"] }] },
        ],
      ),
    ).toBe(0);
  });
});
