import { createHash } from "node:crypto";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginCacheControl } from "@apollo/server/plugin/cacheControl";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyGraphqlCdnCacheHeaders,
  applyPersistedQuery,
} from "../src/graphql/apq.js";
import { honoMiddleware } from "../src/middlewares/apollo.js";

const TYPE_DEFS = `#graphql
  enum CacheControlScope {
    PUBLIC
    PRIVATE
  }

  directive @cacheControl(
    maxAge: Int
    scope: CacheControlScope
    inheritMaxAge: Boolean
  ) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION

  type Query {
    hello: String @cacheControl(maxAge: 60)
  }
`;

const hashQuery = (query: string) =>
  createHash("sha256").update(query).digest("hex");

const extensionParam = (hash: string) =>
  encodeURIComponent(
    JSON.stringify({
      persistedQuery: {
        version: 1,
        sha256Hash: hash,
      },
    }),
  );

describe("GraphQL CDN caching and APQ", () => {
  const server = new ApolloServer({
    typeDefs: TYPE_DEFS,
    resolvers: {
      Query: {
        hello: () => "world",
      },
    },
    plugins: [ApolloServerPluginCacheControl({ defaultMaxAge: 60 })],
  });
  const app = new Hono();

  beforeAll(async () => {
    await server.start();
    app.use("/graphql", honoMiddleware(server, { context: async () => ({}) }));
  });

  afterAll(async () => {
    await server.stop();
  });

  it("serves GET queries and converts the cache policy for the CDN", async () => {
    const response = await app.request(
      `/graphql?query=${encodeURIComponent("{ hello }")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { hello: "world" } });
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=60, stale-while-revalidate=600",
    );
    expect(response.headers.get("cdn-cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=600",
    );
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
  });

  it("returns PERSISTED_QUERY_NOT_FOUND for an unknown hash", async () => {
    const hash = hashQuery("{ hello }");
    const response = await app.request(
      `/graphql?extensions=${extensionParam(hash)}`,
    );
    const body = (await response.json()) as {
      errors?: Array<{ extensions?: { code?: string } }>;
    };

    expect(response.status).toBe(200);
    expect(body.errors?.[0]?.extensions?.code).toBe(
      "PERSISTED_QUERY_NOT_FOUND",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("registers a query then serves it from the hash-only URL", async () => {
    const query = "{ hello }";
    const hash = hashQuery(query);

    const register = await app.request("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        extensions: {
          persistedQuery: { version: 1, sha256Hash: hash },
        },
      }),
    });
    expect(register.status).toBe(200);
    expect(await register.json()).toEqual({ data: { hello: "world" } });

    const cached = await app.request(
      `/graphql?extensions=${extensionParam(hash)}`,
    );
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({ data: { hello: "world" } });
    expect(cached.headers.get("cdn-cache-control")).toContain("max-age=60");
  });

  it("rejects a hash that does not match the supplied query", async () => {
    const response = await app.request("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ hello }",
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: hashQuery("{ goodby }"),
          },
        },
      }),
    });
    const body = (await response.json()) as {
      errors?: Array<{ extensions?: { code?: string } }>;
    };

    expect(response.status).toBe(400);
    expect(body.errors?.[0]?.extensions?.code).toBe(
      "PERSISTED_QUERY_HASH_MISMATCH",
    );
  });

  it("only adds CDN headers to cacheable GET responses", () => {
    const getHeaders: Record<string, string> = {
      "cache-control": "max-age=120, public",
    };
    applyGraphqlCdnCacheHeaders(getHeaders, "GET");
    expect(getHeaders["cache-control"]).toContain("s-maxage=120");
    expect(getHeaders["cdn-cache-control"]).toContain("max-age=120");

    const postHeaders: Record<string, string> = {
      "cache-control": "max-age=60, public",
    };
    applyGraphqlCdnCacheHeaders(postHeaders, "POST");
    expect(postHeaders["cdn-cache-control"]).toBeUndefined();
    expect(postHeaders["cache-control"]).toBe("no-store");
  });

  it("resolves APQ without Apollo for a known hash", async () => {
    const query = "{ hello }";
    const hash = hashQuery(query);
    await applyPersistedQuery({
      method: "POST",
      headers: {} as never,
      search: "",
      body: {
        query,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      },
    });

    const resolved = await applyPersistedQuery({
      method: "GET",
      headers: {} as never,
      search: `?extensions=${extensionParam(hash)}`,
      body: undefined,
    });

    expect(resolved.response).toBeUndefined();
    expect(resolved.request.search).toContain("query=");
  });
});
