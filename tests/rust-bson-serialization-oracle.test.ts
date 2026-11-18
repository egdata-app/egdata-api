import {
  Binary,
  BSON,
  Code,
  Decimal128,
  Long,
  MaxKey,
  MinKey,
  Timestamp,
  UUID,
} from "mongodb";
import { it } from "vitest";
import { serializeValue } from "../src/v1/serialization.js";
import { assertOracle } from "../rust/oracles/record.js";

it("records the Node MongoDB driver's wire JSON for stored BSON types", () => {
  const docs = [
    {
      name: "longs",
      value: {
        _id: Long.MAX_VALUE,
        exact: Long.fromString("9007199254740992"),
        above: Long.fromString("9007199254740993"),
        below: Long.fromString("-9007199254740993"),
        nested: [{ id: Long.MIN_VALUE }],
      },
    },
    {
      name: "scalar-types",
      value: {
        decimal: Decimal128.fromString("12.3400"),
        clock: new Timestamp({ t: 4_000_000_000, i: 61 }),
        binary: new Binary(Buffer.from([0, 127, 255])),
        uuid: new UUID("00112233-4455-4677-8899-aabbccddeeff"),
        expression: /abc/i,
        code: new Code("x"),
        scoped: new Code("example", { sample: 3 }),
        min: new MinKey(),
        max: new MaxKey(),
      },
    },
    {
      name: "typed-identifiers",
      value: {
        _id: Decimal128.fromString("123.400"),
        nested: [
          { id: new Timestamp({ t: 4_000_000_000, i: 61 }) },
          { id: new Binary(Buffer.from([0, 127, 255])) },
          { id: new UUID("00112233-4455-4677-8899-aabbccddeeff") },
          { id: [Decimal128.fromString("5.20"), null, Long.MAX_VALUE] },
          { id: Number.POSITIVE_INFINITY },
          { id: { $oid: "literal historical field" } },
        ],
      },
    },
    {
      name: "plain-documents-with-type-like-fields",
      value: {
        metadata: {
          reference: { $oid: "a literal field" },
          source: { $date: "2025-03-01" },
          nested: [{ $oid: "still a document" }],
        },
        createdAt: { $date: "2025-03" },
        updatedAt: { $date: 123 },
        releaseDate: { id: 19, __v: 2, fee: Decimal128.fromString("0.25") },
        endDate: new Binary(Buffer.from([0, 127, 255])),
      },
    },
  ];
  const bytes = docs.map(({ name, value }) => ({
    name,
    raw: Buffer.from(BSON.serialize(value)),
  }));
  // Encode the int64 directly so the driver can also read dates outside the JS TimeClip range.
  for (const millis of [
    -8640000000000001n, -8640000000000000n, -8500000000000001n,
    8500000000000001n, 8640000000000000n, 8640000000000001n,
    -(2n ** 63n), 2n ** 63n - 1n,
  ]) {
    const raw = Buffer.from(BSON.serialize({ updatedAt: new Date(0) }));
    raw.writeBigInt64LE(millis, raw.length - 9);
    bytes.push({ name: "date-" + millis, raw });
  }
  // The current driver decodes historical DBPointer (0x0c) but its writer emits modern DBRef documents.
  for (const namespace of ["items", "db.items", "a.b.c"]) {
    const encoded = Buffer.from(namespace + "\0");
    const raw = Buffer.alloc(12 + encoded.length + 12);
    raw.writeInt32LE(raw.length, 0);
    raw[4] = 0x0c;
    raw[5] = 0x78;
    raw.writeInt32LE(encoded.length, 7);
    encoded.copy(raw, 11);
    bytes.push({ name: "pointer-" + namespace, raw });
  }
  assertOracle(
    "bson-driver-wire-node",
    bytes.map(({ name, raw }) => {
      const document = BSON.deserialize(raw);
      return {
        name,
        bson: raw.toString("hex"),
        legacy: JSON.stringify(document),
        v1: JSON.stringify(serializeValue(document)),
      };
    }),
  );
  const integers = [
    "9007199254740991",
    "9007199254740992",
    "9007199254740993",
    "-9007199254740993",
    "9223372036854775807",
    "18446744073709551615",
  ];
  assertOracle(
    "json-integers-node",
    integers.map((input) => ({
      input,
      output: JSON.stringify(JSON.parse(input)),
    })),
  );
});
