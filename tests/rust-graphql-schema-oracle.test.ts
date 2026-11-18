import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { getIntrospectionQuery } from "graphql";
import { consola } from "consola";
import { it, vi } from "vitest";
vi.mock("../src/db/index.js", () => ({ db: { db: {} } }));
import { server, type Context } from "../src/graphql/index.js";
import { assertOracle } from "../rust/oracles/record.js";

const introspectionQuery = `
  query CanonicalSchema {
    __schema {
      types {
        kind name
        fields(includeDeprecated: true) {
          name type { ...TypeRef }
          args { name defaultValue type { ...TypeRef } }
        }
        inputFields { name defaultValue type { ...TypeRef } }
        enumValues(includeDeprecated: true) { name }
        possibleTypes { name }
      }
      directives {
        name isRepeatable locations
        args { name defaultValue type { ...TypeRef } }
      }
    }
  }
  fragment TypeRef on __Type {
    kind name
    ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
  }
`;

function sortByName<T extends { name?: string | null }>(values: T[] | null | undefined) {
  return values?.sort((left, right) =>
    (left.name ?? "") < (right.name ?? "")
      ? -1
      : (left.name ?? "") > (right.name ?? "")
        ? 1
        : 0,
  );
}

type Named = { name: string; [key: string]: any };
function normalize(schema: {types: Named[]; directives: Named[]}) {
  for (const type of schema.types) {
    sortByName(type.fields);
    for (const field of type.fields ?? []) sortByName(field.args);
    sortByName(type.inputFields);
    sortByName(type.enumValues);
    sortByName(type.possibleTypes);
  }
  sortByName(schema.types);
  for (const directive of schema.directives) {
    directive.locations.sort();
    sortByName(directive.args);
  }
  sortByName(schema.directives);
  return schema;
}

it("records canonical Apollo GraphQL schema introspection", async () => {
  await server.start();
  try {
    const introspect = async (query: string) => {
      const response = await server.executeOperation({ query }, {
        contextValue: { logger: consola } as Context,
      });
      assert.equal(response.body.kind, "single");
      assert.equal(response.body.singleResult.errors, undefined);
      assert.ok(response.body.singleResult.data);
      return response.body.singleResult.data.__schema;
    };
    const canonical = await introspect(getIntrospectionQuery({
      descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true,
      schemaDescription: true, inputValueDeprecation: true, oneOf: true,
    }));
    const path = new URL("../rust/crates/egdata-graphql/src/schema/public-schema.json", import.meta.url);
    const encoded = JSON.stringify(canonical) + "\n";
    if (process.env.RUST_ORACLE_WRITE === "1") writeFileSync(path, encoded);
    else assert.equal(readFileSync(path, "utf8"), encoded);

    const schema = await introspect(introspectionQuery) as Parameters<typeof normalize>[0];
    assertOracle("graphql-schema-node", [{ name: "canonical-schema", schema: normalize(schema) }]);
  } finally {
    await server.stop();
  }
});
