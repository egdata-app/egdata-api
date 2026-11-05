import { createHash } from "node:crypto";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginCacheControl } from "@apollo/server/plugin/cacheControl";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AbuseTelemetryContext,
  createAbuseTelemetryPlugin,
} from "../src/graphql/abuse-telemetry.js";
import { disconnectPersistedQueryStore } from "../src/graphql/persisted-queries.js";
import { createAntiAbuse } from "../src/middleware/anti-abuse.js";
import { honoMiddleware } from "../src/middlewares/apollo.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import {
  type AbuseEvent,
  AbuseScorer,
  scoreEvents,
} from "../src/services/abuse-scorer.js";
import { PowSessionService } from "../src/services/pow-session.js";

describe("GraphQL abuse telemetry", () => {
  const server = new ApolloServer<AbuseTelemetryContext>({
    typeDefs: `
      enum CacheControlScope { PUBLIC PRIVATE }
      directive @cacheControl(maxAge: Int, scope: CacheControlScope, inheritMaxAge: Boolean) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION
      type Query { offers(page: Int, limit: Int): [Offer] @cacheControl(maxAge: 60) item(id: ID!): Offer @cacheControl(maxAge: 60) }
      type Offer { id: ID! }
    `,
    resolvers: {
      Query: {
        offers: () => [{ id: "game" }],
        item: (_, args) => ({ id: args.id }),
      },
    },
    plugins: [
      createAbuseTelemetryPlugin(),
      ApolloServerPluginCacheControl({ defaultMaxAge: 60 }),
    ],
  });
  beforeAll(async () => {
    vi.stubEnv("REDISHOST", "127.0.0.1");
    vi.stubEnv("REDISPORT", "1");
    vi.stubEnv("REDISTLS", "false");
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    disconnectPersistedQueryStore();
    vi.unstubAllEnvs();
  });

  function fixture(mode: "observe" | "enforce" = "observe") {
    let now = Date.now();
    const scorer = new AbuseScorer(undefined, () => now);
    const events: AbuseEvent[] = [];
    const enqueue = vi.spyOn(scorer, "enqueue");
    // Read calls after each response; the real queue still aggregates scores.
    const anti = createAntiAbuse({
      mode,
      scorer,
      sessions: new PowSessionService("graphql-test-secret-at-least-32-bytes"),
      edgeSecret: "edge",
      now: () => now,
      delay: async () => {},
    });
    const app = new Hono();
    app.use("*", anti.middleware);
    app.use("*", responseEtag);
    app.use(
      "/graphql",
      honoMiddleware(server, {
        context: async ({ c }) => ({
          abuseTelemetry: c.get("antiAbuseGraphql"),
        }),
      }),
    );
    const request = async (
      payload: Record<string, unknown>,
      method = "POST",
      i = 0,
    ) => {
      const query = new URLSearchParams(
        Object.entries(payload).map(([key, value]) => [
          key,
          typeof value === "string" ? value : JSON.stringify(value),
        ]),
      );
      const response = await app.request(
        method === "GET" ? `/graphql?${query}` : "/graphql",
        {
          method,
          headers: {
            "content-type": "application/json",
            "x-egdata-edge-secret": "edge",
            "x-egdata-tls-version": "TLSv1.3",
            "x-egdata-tls-cipher": "AEAD-AES128-GCM-SHA256",
            "x-egdata-asn": "1234",
            "cf-connecting-ip": `192.0.2.${i + 1}`,
            "user-agent": `desktop-${i}`,
          },
          ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
        },
      );
      const recorded = enqueue.mock.calls.at(-1)?.[1];
      if (!recorded) throw new Error("Request was not recorded");
      events.push(recorded);
      now += 100;
      await scorer.drain();
      return response;
    };
    return { scorer, enqueue, events, request };
  }

  it.each([
    "POST",
    "GET",
  ])("detects %s variable pagination across rotating IPs/UAs", async (method) => {
    const f = fixture();
    for (let page = 1; page <= 30; page++) {
      const response = await f.request(
        {
          query:
            "query Sweep($p: Int!) { renamed: offers(page: $p, limit: 10) { id } }",
          variables: { p: page },
        },
        method,
        page,
      );
      expect((await response.json()).data.renamed[0].id).toBe("game");
    }
    expect(f.events).toHaveLength(30);
    expect(f.events[29].resources).toEqual([
      { route: "/graphql/Query.offers", page: 30, itemId: undefined },
    ]);
    expect(f.scorer.risk(f.enqueue.mock.calls[0][0])).toBeGreaterThan(0.8);
    f.scorer.close();
  });

  it("captures literal/default arguments and APQ GET variables without losing public caching", async () => {
    const f = fixture("enforce");
    const query =
      'query Sweep($p: Int = 3) { offers(page: $p) { id } item(id: "game-1") { id } }';
    const extensions = {
      persistedQuery: {
        version: 1,
        sha256Hash: createHash("sha256").update(query).digest("hex"),
      },
    };
    await f.request({ query, extensions });
    expect(f.events[0].resources?.[0].page).toBe(3);
    expect(f.events[0].resources?.[1].itemId).toBe("game-1");
    const response = await f.request(
      { extensions, variables: { p: 4 } },
      "GET",
    );
    expect((await response.json()).data.offers[0].id).toBe("game");
    expect(f.events[1].resources?.[0].page).toBe(4);
    expect(response.headers.get("cdn-cache-control")).toContain("public");
    expect(response.headers.get("etag")).toBeTruthy();
    f.scorer.close();
  });

  it("counts a request once, caps alias features and ignores invalid or skipped fields", async () => {
    const f = fixture();
    await f.request({
      query: `{ ${Array.from({ length: 40 }, (_, i) => `a${i}: item(id: "${i}") { id }`).join(" ")} }`,
    });
    expect(f.events).toHaveLength(1);
    expect(f.events[0].resources).toHaveLength(32);
    expect(scoreEvents(f.events)).toBe(0);
    await f.request({ query: "{ missing(page: 7) }" });
    expect(f.events[1].resources).toBeUndefined();
    await f.request({ query: "{ offers(page: 7) @skip(if: true) { id } }" });
    expect(f.events[2].resources).toBeUndefined();
    f.scorer.close();
  });

  it("scores GraphQL ID sweeps without manufacturing request volume from aliases", () => {
    const events: AbuseEvent[] = Array.from({ length: 30 }, (_, i) => ({
      at: i * 100,
      deep: true,
      support: false,
      route: "/graphql",
      mismatch: 0,
      resources: [{ route: "/graphql/Query.item", itemId: `game-${i}` }],
    }));
    expect(scoreEvents(events)).toBeGreaterThan(0.8);
    expect(scoreEvents([...events].reverse())).toBe(scoreEvents(events));
  });
});
