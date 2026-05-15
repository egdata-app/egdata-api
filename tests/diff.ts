// Structural diff helpers for the golden-snapshot test.
//
// We don't want exact-equality on response bodies — fields like timestamps,
// cache TTLs, and pagination metadata legitimately change between captures.
// Instead we compare *shapes*: same keys, same leaf types.

const VOLATILE_KEY_PATTERNS = [
  /^updatedAt$/i,
  /^createdAt$/i,
  /^lastModified(Date)?$/i,
  /^timestamp$/i,
  /^capturedAt$/i,
  /^etag$/i,
  /^cacheKey$/i,
  /^date$/i,
];

function isVolatileKey(key: string): boolean {
  return VOLATILE_KEY_PATTERNS.some((p) => p.test(key));
}

type Shape =
  | { kind: "primitive"; type: "string" | "number" | "boolean" | "null" }
  | { kind: "array"; element: Shape | null }
  | { kind: "object"; fields: Record<string, Shape> };

function shapeOf(value: unknown): Shape {
  if (value === null) return { kind: "primitive", type: "null" };
  if (Array.isArray(value)) {
    const sample = value.find((v) => v !== undefined && v !== null);
    return {
      kind: "array",
      element: sample === undefined ? null : shapeOf(sample),
    };
  }
  if (typeof value === "object") {
    const fields: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isVolatileKey(k)) continue;
      fields[k] = shapeOf(v);
    }
    return { kind: "object", fields };
  }
  if (typeof value === "string") return { kind: "primitive", type: "string" };
  if (typeof value === "number") return { kind: "primitive", type: "number" };
  if (typeof value === "boolean") return { kind: "primitive", type: "boolean" };
  return { kind: "primitive", type: "null" };
}

export type ShapeDiff = { path: string; message: string };

export function diffShape(
  expected: unknown,
  actual: unknown,
  path = "$",
): ShapeDiff[] {
  const e = shapeOf(expected);
  const a = shapeOf(actual);
  return diffShapeInner(e, a, path);
}

function diffShapeInner(
  expected: Shape,
  actual: Shape,
  path: string,
): ShapeDiff[] {
  if (expected.kind !== actual.kind) {
    return [
      {
        path,
        message: `expected ${expected.kind}, got ${actual.kind}`,
      },
    ];
  }
  if (expected.kind === "primitive" && actual.kind === "primitive") {
    if (
      expected.type !== actual.type &&
      expected.type !== "null" &&
      actual.type !== "null"
    ) {
      return [
        {
          path,
          message: `expected ${expected.type}, got ${actual.type}`,
        },
      ];
    }
    return [];
  }
  if (expected.kind === "array" && actual.kind === "array") {
    if (expected.element === null || actual.element === null) return [];
    return diffShapeInner(expected.element, actual.element, `${path}[]`);
  }
  if (expected.kind === "object" && actual.kind === "object") {
    const diffs: ShapeDiff[] = [];
    for (const [key, expectedField] of Object.entries(expected.fields)) {
      const actualField = actual.fields[key];
      if (actualField === undefined) {
        diffs.push({
          path: `${path}.${key}`,
          message: "missing key in actual",
        });
        continue;
      }
      diffs.push(
        ...diffShapeInner(expectedField, actualField, `${path}.${key}`),
      );
    }
    return diffs;
  }
  return [];
}
