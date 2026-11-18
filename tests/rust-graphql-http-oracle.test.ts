import { Hono } from "hono";
import { consola } from "consola";
import { expect, it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { honoMiddleware } from "../src/middlewares/apollo.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";
import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";

vi.mock("../src/graphql/persisted-queries.js", async (importOriginal) => {
  const queries = new Map<string, string>();
  return {
    ...(await importOriginal<
      typeof import("../src/graphql/persisted-queries.js")
    >()),
    getPersistedQuery: async (hash: string) => queries.get(hash),
    storePersistedQuery: async (hash: string, query: string) => {
      queries.set(hash, query);
    },
  };
});

const mongoCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (name: string) => ({
        findOne: async (filter: Record<string, unknown>, options = {}) => {
          const result =
            name === "items"
              ? {
                  id: "fixture-item",
                  namespace: "fixture-store",
                  title: "Sample item",
                }
              : null;
          const query = Object.fromEntries(
            Object.entries(filter).map(([key, value]) => [
              key,
              value instanceof ObjectId ? { $oid: value.toHexString() } : value,
            ]),
          );
          mongoCalls.push({
            call: { collection: name, method: "one", query, options },
            result,
          });
          return result;
        },
      }),
    },
  },
}));

it("compares the canonical Apollo HTTP bridge and cache middleware", async () => {
  const { server } = await import("../src/graphql/index.js");
  const { createLoaders } = await import("../src/graphql/loaders.js");
  const { db } = await import("../src/db/index.js");
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  await server.start();
  app.use(
    "/graphql",
    honoMiddleware(server, {
      context: async () => ({
        db: db.db,
        logger: consola,
        loaders: createLoaders(db.db),
      }),
    }),
  );
  const cases: unknown[] = [];
  const record = async (
    name: string,
    path: string,
    method: string,
    status: number,
    body?: unknown,
    headers: Record<string, string | string[]> = {},
  ) => {
    const request = {
      path,
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    };
    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      for (const entry of Array.isArray(value) ? value : [value]) requestHeaders.append(key, entry);
    }
    const res = await app.request(path, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = {
      status: res.status,
      headers: Object.fromEntries(
        [...res.headers.entries()].filter(([key]) =>
          [
            "content-type",
            "etag",
            "cache-control",
            "cdn-cache-control",
            "vary",
            "allow",
            "x-route-template",
          ].includes(key),
        ),
      ),
      body: await res.text(),
    };
    expect(res.status, name + " " + response.body).toBe(status);
    cases.push({ name, request, trace: mongoCalls.splice(0), response });
    return res;
  };
  const get = (query: string) => "/graphql?" + new URLSearchParams({ query });
  try {
    await record("typename-get", get("{ __typename }"), "GET", 200);
    const aliases = Array.from(
      { length: 50 },
      (_, i) => `a${i}: __typename`,
    ).join(" ");
    await record(
      "alias-limit-across-fragment-and-operations",
      "/graphql",
      "POST",
      400,
      {
        query: `fragment Fields on Query { ${aliases} }\nquery First { ...Fields aliasOne: __typename }\nquery Second { aliasTwo: __typename }`,
        operationName: "Second",
      },
    );
    const deepOffer = "related { ".repeat(12) + "id" + " }".repeat(12);
    await record("depth-limit-nested-offers", "/graphql", "POST", 400, {
      query: `{ offer(id: "fixture") { ${deepOffer} } }`,
    });
    await record("typename-post", "/graphql", "POST", 200, {
      query: "query Hello { name: __typename }",
      operationName: "Hello",
    });
    await record("item-variables", "/graphql", "POST", 200, {
      query: "query Get($id: ID!) { item(id:$id) { id title } }",
      variables: { id: "fixture-item" },
    });
    const cachedItem = get('{item(id:"fixture-item"){id title}}');
    const itemResponse = await record("item-cache-get", cachedItem, "GET", 200);
    await record("item-conditional-get", cachedItem, "GET", 304, undefined, {
      "if-none-match": itemResponse.headers.get("etag")!,
    });
    await record(
      "missing-build",
      get('{build(id:"64c000000000000000000001"){_id}}'),
      "GET",
      200,
    );
    await record(
      "graphql-response-media",
      get("{__typename}"),
      "GET",
      200,
      undefined,
      { accept: "application/graphql-response+json" },
    );
    await record("media-quality", get("{__typename}"), "GET", 200, undefined, {
      accept: "application/json;q=0.1, application/graphql-response+json;q=0.8",
    });
    await record("media-separate-accept-fields", get("{__typename}"), "GET", 200, undefined, {
      accept: ["text/plain", "application/graphql-response+json"],
    });
    await record("media-separate-content-types", get("{__typename}"), "GET", 415, undefined, {
      "content-type": ["application/json", "text/plain"],
    });
    for (const [name, accept, status] of [
      ["callback", "application/json;callbackSpec=1.0", 200],
      ["parameter-priority", "application/json;q=1, application/json;charset=utf-8;q=0, application/graphql-response+json;q=.5", 200],
      ["precision", "application/json;q=0.9001, application/graphql-response+json;q=0.9002", 200],
      ["suffix", "application/json;q=0.75tail, application/graphql-response+json;q=.5", 200],
      ["subtype-wildcard", "*/graphql-response+json", 200],
      ["duplicate", "application/json, application/graphql-response+json, application/json", 200],
      ["quoted-parameter", 'application/json;unknown="x,y;z", application/graphql-response+json;charset="UTF-8"', 200],
      ["quoted-quality", 'application/json;q="0.9"', 200],
      ["no-match", "application/json;charset=latin1", 406],
      ["wildcard-parameter", "application/json;extension=*", 200],
      ["invalid-tokens", "/json, application/, missing, bad type/json, application/bad type", 406],
      ["duplicate-parameter", "application/json;charset=latin1;CHARSET=UTF-8", 200],
      ["latin1-parameter", 'application/json;charset="café", application/graphql-response+json', 200],
      ["empty-header", "", 200], ["all", "*/*", 200],
      ["zero", "*/*;q=0", 406],
    ] as const) {
      await record(`media-${name}`, get("{__typename}"), "GET", status, undefined, { accept });
    }
    await record(
      "media-specific-exclusion",
      get("{__typename}"),
      "GET",
      200,
      undefined,
      { accept: "application/json;q=0, */*;q=1" },
    );
    await record(
      "json-fallback-accept",
      get("{__typename}"),
      "GET",
      406,
      undefined,
      { accept: "text/plain" },
    );
    await record("post-empty", "/graphql", "POST", 400, {});
    await record("post-missing-query", "/graphql", "POST", 400, {
      variables: {},
    });
    await record("post-non-string", "/graphql", "POST", 400, { query: 42 });
    for (const [name, fields] of [
      ["document", { query: { kind: "Document" } }], ["false-query", { query: false }],
      ["nested-extensions", { extensions: "{}" }], ["array-extensions", { extensions: [] }],
      ["primitive-variables", { variables: 0 }], ["nonstring-name", { operationName: false }],
      ["validation-order", { extensions: [], variables: "bad", operationName: 0 }],
    ] as const) {
      const body = "query" in fields ? fields : { query: "{__typename}", ...fields };
      await record(`post-${name}`, "/graphql", "POST", 400, body);
    }
    await record("post-variables-string", "/graphql", "POST", 400, {
      query: "{__typename}",
      variables: "{}",
    });
    await record("post-batch", "/graphql", "POST", 400, [
      { query: "{__typename}" },
    ]);
    await record(
      "post-csrf",
      "/graphql",
      "POST",
      400,
      { query: "{__typename}" },
      { "content-type": "text/plain" },
    );
    await record(
      "post-preflight-marker",
      "/graphql",
      "POST",
      200,
      { query: "{__typename}" },
      { "content-type": "text/plain", "apollo-require-preflight": "true" },
    );
    await record(
      "get-invalid-type",
      get("{__typename}"),
      "GET",
      415,
      undefined,
      { "content-type": "text/plain" },
    );
    await record(
      "get-duplicate",
      get("{__typename}") + "&query=second",
      "GET",
      400,
    );
    await record(
      "get-invalid-json",
      get("{__typename}") + "&variables=%7B",
      "GET",
      400,
    );
    await record(
      "get-array-vars",
      get("{__typename}") + "&variables=[]",
      "GET",
      400,
    );
    await record("empty-get", "/graphql", "GET", 400);
    for (const field of ["operationName", "variables", "extensions"]) {
      await record(`get-duplicate-${field}`, get("{__typename}") + `&${field}=%7B%7D&${field}=%7B%7D`, "GET", 400);
    }
    await record("get-invalid-extensions", get("{__typename}") + "&extensions=42", "GET", 400);
    await record("unknown-operation", "/graphql", "POST", 400, {
      query: "query Known { __typename }",
      operationName: "Other",
    });
    await record("ambiguous-operation", "/graphql", "POST", 400, {
      query: "query A { __typename } query B { __typename }",
    });
    await record("invalid-before-unknown-operation", "/graphql", "POST", 400, {
      query: "query A {madeUpField}",
      operationName: "B",
    });
    await record(
      "invalid-before-ambiguous-operation",
      "/graphql",
      "POST",
      400,
      {
        query: "query A {madeUpField} query B {__typename}",
      },
    );
    await record(
      "invalid-document-before-get-mutation",
      get("mutation A {__typename} query B {madeUpField}") + "&operationName=A",
      "GET",
      400,
    );
    await record("method-not-allowed", "/graphql", "PUT", 405, undefined, {
      "apollo-require-preflight": "true",
    });
    await record("bad-apq-version", "/graphql", "POST", 200, {
      extensions: { persistedQuery: { version: 2 } },
    });
    const query = '{item(id:"fixture-item"){title}}';
    const extensions = {
      persistedQuery: {
        version: 1,
        sha256Hash: createHash("sha256").update(query).digest("hex"),
      },
    };
    const hashUrl =
      "/graphql?" +
      new URLSearchParams({ extensions: JSON.stringify(extensions) });
    await record("apq-cache-miss", hashUrl, "GET", 200);
    await record("apq-register", "/graphql", "POST", 200, {
      query,
      extensions,
    });
    await record("apq-cache-hit", hashUrl, "GET", 200);
    await record("validation-field", get("{madeUpField}"), "GET", 400);
    await record("graphql-parse-error", get("{item("), "GET", 400);
    await record("variable-missing", "/graphql", "POST", 400, {
      query: "query One($id: ID!) { item(id:$id){title} }",
    });
    const required = "query One($id: ID!) { item(id:$id){title} }";
    await record("variable-numeric-id", "/graphql", "POST", 200, {
      query: required,
      variables: { id: 42 },
    });
    await record("variable-string-int", "/graphql", "POST", 400, {
      query: "query($limit:Int){items(limit:$limit){total}}",
      variables: { limit: "12" },
    });
    await record("variable-invalid-boolean", "/graphql", "POST", 400, {
      query: "query($show:Boolean!){__typename @include(if:$show)}",
      variables: { show: 1 },
    });
    await record("invalid-object-id-partial", "/graphql", "POST", 200, {
      query: '{service:__typename build(id:"bad"){_id}}',
    });
    await record("variable-null", "/graphql", "POST", 400, {
      query: required,
      variables: { id: null },
    });
    await record("variable-default", "/graphql", "POST", 200, {
      query: 'query One($id: ID! = "fixture-item") { item(id:$id){title} }',
    });
    await record("multiple-missing", "/graphql", "POST", 400, {
      query:
        "query Two($one:ID!,$two:ID!){a:item(id:$one){id} b:item(id:$two){id}}",
    });
    await record("invalid-document-before-variables", "/graphql", "POST", 400, {
      query: "query One($id: ID!) { item(id:$id){madeUpField} }",
    });
    await record("parse-argument-name", get('{item( : "x"){id}}'), "GET", 400);
    await record(
      "get-mutation",
      get("mutation Change { __typename }"),
      "GET",
      405,
    );
    assertOracle("graphql-transport-node", cases);
  } finally {
    await server.stop();
  }
});
