import { describe, expect, it } from "vitest";
import {
  buildPaginationOffset,
  MAX_BUILD_PAGE,
  parseBuildInteger,
} from "../src/utils/build-pagination.js";

describe("build pagination validation", () => {
  it("accepts bounded decimal integers and rejects partial numeric strings", () => {
    expect(parseBuildInteger(undefined, 25)).toBe(25);
    expect(parseBuildInteger("10", 25)).toBe(10);
    expect(parseBuildInteger("10foo", 25)).toBeNull();
    expect(parseBuildInteger("1.5", 25)).toBeNull();
    expect(parseBuildInteger("1e2", 25)).toBeNull();
    expect(parseBuildInteger("0x10", 25)).toBeNull();
  });

  it("rejects offsets above the public scan limit", () => {
    expect(parseBuildInteger(String(MAX_BUILD_PAGE), 1, MAX_BUILD_PAGE)).toBe(
      MAX_BUILD_PAGE,
    );
    expect(buildPaginationOffset(1_001, 100)).toBe(100_000);
    expect(buildPaginationOffset(1_002, 100)).toBeNull();
  });
});
