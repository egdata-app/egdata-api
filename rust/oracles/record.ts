// Expected results must come from executing the canonical Node implementation.
// Normal runs check fixtures; regeneration is an explicit local maintenance step.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

import { BSON } from "mongodb";

export function fixtureValue(value: unknown, mode: boolean | "query" = false): unknown {
  if (mode === true && typeof value === "number" && !Number.isFinite(value)) {
    return { $numberDouble: String(value) };
  }
  if (value instanceof Date) {
    const date = mode === "query" && Number.isNaN(value.getTime())
      ? BSON.deserialize(BSON.serialize({ value })).value as Date
      : value;
    return { $date: date.toISOString() };
  }
  if (value instanceof RegExp)
    return { $regularExpression: { pattern: value.source, options: value.flags } };
  if (
    value &&
    typeof value === "object" &&
    "_bsontype" in value &&
    "toExtendedJSON" in value &&
    typeof value.toExtendedJSON === "function"
  )
    return BSON.EJSON.serialize(value, { relaxed: false });
  if (
    value &&
    typeof value === "object" &&
    "toHexString" in value &&
    typeof value.toHexString === "function"
  )
    return { $oid: value.toHexString() };
  if (Array.isArray(value)) return value.map((entry) => fixtureValue(entry, mode));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fixtureValue(v, mode)]),
    );
  return value;
}

export function assertOracle(name: string, cases: unknown[]): void {
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error("Invalid oracle fixture name");
  if (cases.length === 0)
    throw new Error("An oracle must exercise at least one case");
  const path = new URL(
    `../crates/egdata-api/tests/fixtures/${name}.json`,
    import.meta.url,
  );
  // Match the on-disk JSON representation: Date/ObjectId toJSON, absent undefined.
  const actual = JSON.parse(JSON.stringify(cases));
  if (process.env.RUST_ORACLE_WRITE === "1") {
    const temporary = new URL(`${path.href}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(actual, null, 2) + "\n");
    fs.renameSync(temporary, path);
  } else {
    assert.deepStrictEqual(
      actual,
      JSON.parse(fs.readFileSync(path, "utf8")),
      `Node oracle changed: ${name}. Review before regenerating with RUST_ORACLE_WRITE=1.`,
    );
  }
}

export async function captureResponse(response: Response) {
  const headers: Record<string, string> = {};
  for (const name of [
    "content-type",
    "cache-control",
    "cdn-cache-control",
    "cloudflare-cdn-cache-control",
    "x-content-type-options",
    "x-request-id",
    "location",
    "retry-after",
    "allow",
    "etag",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const contentType = headers["content-type"]?.split(";")[0] ?? "";
  if (contentType.startsWith("image/")) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers,
      body: {
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }
  const raw = await response.text();
  const body =
    raw && (contentType === "application/json" || contentType.endsWith("+json"))
      ? JSON.parse(raw)
      : raw;
  return { status: response.status, headers, body };
}
