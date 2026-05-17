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

const OPEN_MAP_KEYS = new Set(["customAttributes"]);

function isVolatileKey(key: string): boolean {
  return VOLATILE_KEY_PATTERNS.some((p) => p.test(key));
}

type PrimitiveType = "string" | "number" | "boolean" | "null";

type Shape =
  | { kind: "primitive"; types: PrimitiveType[] }
  | { kind: "array"; element: Shape | null }
  | { kind: "map"; value: Shape | null }
  | { kind: "object"; fields: Record<string, Shape> };

function shapeOf(value: unknown, key?: string): Shape {
  if (value === null) return { kind: "primitive", types: ["null"] };
  if (Array.isArray(value)) {
    const samples = value
      .filter((v) => v !== undefined && v !== null)
      .map((v) => shapeOf(v));
    return {
      kind: "array",
      element: mergeShapeList(samples),
    };
  }
  if (typeof value === "object") {
    if (key !== undefined && OPEN_MAP_KEYS.has(key)) {
      const values = Object.values(value as Record<string, unknown>)
        .filter((v) => v !== undefined && v !== null)
        .map((v) => shapeOf(v));
      return { kind: "map", value: mergeShapeList(values) };
    }

    const fields: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isVolatileKey(k)) continue;
      fields[k] = shapeOf(v, k);
    }
    return { kind: "object", fields };
  }
  if (typeof value === "string")
    return { kind: "primitive", types: ["string"] };
  if (typeof value === "number")
    return { kind: "primitive", types: ["number"] };
  if (typeof value === "boolean") {
    return { kind: "primitive", types: ["boolean"] };
  }
  return { kind: "primitive", types: ["null"] };
}

function mergeShapeList(shapes: Shape[]): Shape | null {
  return shapes.reduce<Shape | null>(
    (merged, shape) => (merged === null ? shape : mergeShapes(merged, shape)),
    null,
  );
}

function mergeShapes(left: Shape, right: Shape): Shape {
  if (left.kind !== right.kind) {
    return left;
  }

  if (left.kind === "primitive" && right.kind === "primitive") {
    return {
      kind: "primitive",
      types: [...new Set([...left.types, ...right.types])],
    };
  }

  if (left.kind === "array" && right.kind === "array") {
    return {
      kind: "array",
      element:
        left.element === null
          ? right.element
          : right.element === null
            ? left.element
            : mergeShapes(left.element, right.element),
    };
  }

  if (left.kind === "map" && right.kind === "map") {
    return {
      kind: "map",
      value:
        left.value === null
          ? right.value
          : right.value === null
            ? left.value
            : mergeShapes(left.value, right.value),
    };
  }

  if (left.kind === "object" && right.kind === "object") {
    const fields: Record<string, Shape> = { ...left.fields };
    for (const [key, rightField] of Object.entries(right.fields)) {
      fields[key] =
        fields[key] === undefined
          ? rightField
          : mergeShapes(fields[key], rightField);
    }
    return { kind: "object", fields };
  }

  return left;
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
    const expectedTypes = expected.types.filter((type) => type !== "null");
    const actualTypes = actual.types.filter((type) => type !== "null");
    const unexpectedTypes = actualTypes.filter(
      (type) => !expectedTypes.includes(type),
    );

    if (
      expectedTypes.length > 0 &&
      actualTypes.length > 0 &&
      unexpectedTypes.length > 0
    ) {
      return [
        {
          path,
          message: `expected ${formatTypes(expected.types)}, got ${formatTypes(actual.types)}`,
        },
      ];
    }
    return [];
  }
  if (expected.kind === "array" && actual.kind === "array") {
    if (expected.element === null || actual.element === null) return [];
    return diffShapeInner(expected.element, actual.element, `${path}[]`);
  }
  if (expected.kind === "map" && actual.kind === "map") {
    if (expected.value === null || actual.value === null) return [];
    return diffShapeInner(expected.value, actual.value, `${path}.*`);
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

function formatTypes(types: PrimitiveType[]): string {
  return types.filter((type) => type !== "null").join(" | ") || "null";
}
