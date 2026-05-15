import { describe, expect, it } from "vitest";
import { diffShape } from "./diff.js";

describe("diffShape", () => {
  it("reports no diffs when shapes match exactly", () => {
    const a = { id: "x", count: 1, tags: ["a", "b"] };
    const b = { id: "y", count: 99, tags: ["c"] };
    expect(diffShape(a, b)).toEqual([]);
  });

  it("detects missing keys", () => {
    const expected = { id: "x", name: "n" };
    const actual = { id: "x" };
    const diffs = diffShape(expected, actual);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe("$.name");
  });

  it("detects type drift on leaves", () => {
    const diffs = diffShape({ count: 1 }, { count: "1" });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.message).toContain("expected number, got string");
  });

  it("ignores volatile keys (timestamps, etag, lastModified)", () => {
    const expected = {
      id: "x",
      updatedAt: "2024-01-01T00:00:00Z",
      lastModifiedDate: "2024-01-01T00:00:00Z",
      etag: '"abc"',
    };
    const actual = { id: "x" };
    expect(diffShape(expected, actual)).toEqual([]);
  });

  it("walks into arrays using the first non-null sample", () => {
    const expected = { rows: [{ id: "x", n: 1 }] };
    const actual = { rows: [{ id: "y", n: "2" }] };
    const diffs = diffShape(expected, actual);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe("$.rows[].n");
  });

  it("allows extra keys in actual without complaint", () => {
    const expected = { id: "x" };
    const actual = { id: "y", extra: 42 };
    expect(diffShape(expected, actual)).toEqual([]);
  });
});
