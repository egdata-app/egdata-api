import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { typeDefs } from "../src/graphql/typedefs.js";

// Keep the scalar implementations and the schema on the same GraphQL-js instance.
const require = createRequire(import.meta.url);
const { parse, getOperationAST } =
  require("graphql") as typeof import("graphql");
const { getVariableValues } =
  require("graphql/execution/values.js") as typeof import("graphql/execution/values.js");
const { makeExecutableSchema } =
  require("@graphql-tools/schema") as typeof import("@graphql-tools/schema");
const { GraphQLDateTime, GraphQLJSON } =
  require("graphql-scalars") as typeof import("graphql-scalars");
const schema = makeExecutableSchema({
  typeDefs,
  resolvers: { Date: GraphQLDateTime, JSON: GraphQLJSON },
});
const path = fileURLToPath(
  new URL("../rust/oracles/graphql-variables-node.json", import.meta.url),
);

it("records GraphQL-js coercion of JSON request variables", () => {
  const cases: unknown[] = [];
  function record(
    name: string,
    declaration: string,
    variables: Record<string, unknown>,
  ) {
    const query = `query Test(\n${declaration}\n){__typename}`;
    const operation = getOperationAST(parse(query))!;
    const result = getVariableValues(
      schema,
      operation.variableDefinitions!,
      variables,
      { maxErrors: 50 },
    );
    const errors = result.errors?.map((e) => ({
      message: e.message,
      ...(e.locations ? { locations: e.locations } : {}),
    }));
    cases.push({
      name,
      query,
      variables,
      ...(errors ? { errors } : { coerced: result.coerced }),
    });
  }
  record("optional missing", "$a:String", { ignored: 1 });
  record("required missing", "$v:ID!", {});
  record("explicit null", "$v:ID", { v: null });
  record("required null", "$v:ID! = 2", { v: null });
  record("default ID and singleton list", "$v:ID=9, $list:[ID!]=7", {});
  record("integer ID", "$v:ID!", { v: 124 });
  record("large ID uses JS number spelling", "$v:ID!", { v: 1e22 });
  record("valid integers", "$min:Int!, $max:Int!, $float:Float!", {
    min: -2147483648,
    max: 2147483647,
    float: 3.5,
  });
  record("wrong scalars", "$i:Int!, $f:Float, $b:Boolean!, $s:String!", {
    i: "42",
    f: "1",
    b: 0,
    s: false,
  });
  record("integer bounds", "$i:Int!, $j:Int", {
    i: 2147483648,
    j: -2147483649,
  });
  record("fractional integer and ID", "$i:Int, $id:ID!", { i: 1.5, id: 0.25 });
  record("nested singleton IDs", "$v:[[ID!]!]", { v: [1, ["2", 3]] });
  record("nested list paths", "$v:[[Int!]]!", {
    v: [[true, null, 12.5], null, "4"],
  });
  record("nested missing path", "$v:[[Int!]!]!", { v: [null] });
  record("singleton scalar error path", "$v:[Boolean!]!", { v: 6 });
  record("valid enum", "$v:ProfileGameSort!", { v: "ALPHABETICAL" });
  record("enum case suggestion", "$v:[ProfileGameFilter!]!", {
    v: ["in_progress", "COMPLETD", true],
  });
  record("enum transposition", "$v:ProfileGameSort", { v: "ALPHAEBTICAL" });
  record("enum unknown", "$v:ProfileActivityType", { v: "WRONG" });
  record("JSON object", "$v:JSON!", { v: { b: "a", c: [true, null, 5] } });
  record("inspected object/array", "$v:ID!", {
    v: { deep: { x: { a: 2 } }, arr: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  });
  record("offset date", "$v:DateTime!", {
    v: "2025-05-30T15:04:03.12345+02:00",
  });
  record("invalid date strings", "$v:[DateTime]!", {
    v: ["2025-02-29T00:00:00Z", "2025-01-01 00:00:00Z", 4],
  });
  record("error limit", "$v:[Int!]", {
    v: Array.from({ length: 53 }, (_, i) => String(i)),
  });
  const text = JSON.stringify(cases, null, 2) + "\n";
  if (process.env.RUST_ORACLE_WRITE === "1") writeFileSync(path, text);
  else expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(path, "utf8")));
});
