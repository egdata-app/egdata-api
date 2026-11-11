import { describe, expect, it } from "vitest";
import {
  type MongoSortField,
  mongoKeysetFilter,
  parseLimit,
  trimPage,
} from "../src/v1/pagination.js";

const descSort: MongoSortField[] = [
  { field: "lastModifiedDate", direction: -1, nulls: "last" },
  { field: "id", direction: 1, nulls: "last" },
];

describe("v1 keyset pagination", () => {
  it("builds a lexicographic filter for a non-null descending tuple", () => {
    expect(
      mongoKeysetFilter(descSort, ["2026-04-30T00:00:00.000Z", "offer-2"]),
    ).toEqual({
      $or: [
        { lastModifiedDate: { $lt: "2026-04-30T00:00:00.000Z" } },
        { lastModifiedDate: null },
        {
          $and: [
            { lastModifiedDate: { $eq: "2026-04-30T00:00:00.000Z" } },
            { id: { $gt: "offer-2" } },
          ],
        },
        {
          $and: [
            { lastModifiedDate: { $eq: "2026-04-30T00:00:00.000Z" } },
            { id: null },
          ],
        },
      ],
    });
  });

  it("handles a null sort value without repeating the null group", () => {
    expect(mongoKeysetFilter(descSort, [null, "offer-9"])).toEqual({
      $or: [
        { $and: [{ lastModifiedDate: null }, { id: { $gt: "offer-9" } }] },
        { $and: [{ lastModifiedDate: null }, { id: null }] },
      ],
    });
  });

  it("keeps nulls first for an ascending sort with explicit null policy", () => {
    const sort: MongoSortField[] = [
      { field: "releaseDate", direction: 1, nulls: "first" },
      { field: "id", direction: 1, nulls: "last" },
    ];
    expect(mongoKeysetFilter(sort, [null, "offer-1"])).toEqual({
      $or: [
        { releaseDate: { $ne: null } },
        {
          $and: [{ releaseDate: null }, { id: { $gt: "offer-1" } }],
        },
        {
          $and: [{ releaseDate: null }, { id: null }],
        },
      ],
    });
    expect(
      mongoKeysetFilter(sort, ["2026-01-01T00:00:00.000Z", "offer-1"]),
    ).toEqual({
      $or: [
        { releaseDate: { $gt: "2026-01-01T00:00:00.000Z" } },
        {
          $and: [
            { releaseDate: { $eq: "2026-01-01T00:00:00.000Z" } },
            { id: { $gt: "offer-1" } },
          ],
        },
        {
          $and: [
            { releaseDate: { $eq: "2026-01-01T00:00:00.000Z" } },
            { id: null },
          ],
        },
      ],
    });
  });

  it("validates page sizes and trims the lookahead row", () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit("100")).toBe(100);
    expect(() => parseLimit("0")).toThrow();
    expect(() => parseLimit("101")).toThrow();
    expect(() => parseLimit("abc")).toThrow();
    expect(trimPage([1, 2, 3], 2)).toEqual({ items: [1, 2], hasMore: true });
    expect(trimPage([1, 2], 2)).toEqual({ items: [1, 2], hasMore: false });
  });

  it("rejects an empty sort specification instead of scanning from the beginning", () => {
    expect(() => mongoKeysetFilter([], [])).toThrow();
  });
});
