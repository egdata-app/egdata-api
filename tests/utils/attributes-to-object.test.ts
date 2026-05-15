import { describe, expect, it } from "vitest";
import { attributesToObject } from "../../src/utils/attributes-to-object.js";

describe("attributesToObject", () => {
  it("returns an object unchanged when given an object", () => {
    const input = { foo: { type: "STRING", value: "bar" } };
    expect(attributesToObject(input)).toEqual(input);
  });

  it("converts an array of {key,type,value} into a keyed object", () => {
    const result = attributesToObject([
      { key: "color", type: "STRING", value: "red" },
      { key: "count", type: "NUMBER", value: "3" },
    ]);
    expect(result).toEqual({
      color: { type: "STRING", value: "red" },
      count: { type: "NUMBER", value: "3" },
    });
  });

  it("defaults missing type to STRING when input is an array", () => {
    const result = attributesToObject([{ key: "x", value: "y" }]);
    expect(result).toEqual({ x: { type: "STRING", value: "y" } });
  });

  it("converts a Map to a keyed object", () => {
    const map = new Map<string, { key: string; type: string; value: string }>([
      ["a", { key: "a", type: "STRING", value: "1" }],
      ["b", { key: "b", type: "NUMBER", value: "2" }],
    ]);
    expect(attributesToObject(map)).toEqual({
      a: { type: "STRING", value: "1" },
      b: { type: "NUMBER", value: "2" },
    });
  });
});
