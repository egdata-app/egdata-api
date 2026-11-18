import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { assertOracle } from "../rust/oracles/record.js";

it.skipIf(!process.env.EGDATA_TEST_OPENSEARCH)(
  "records mapping, pagination, and authentication against disposable OpenSearch",
  async () => {
    const endpoint = new URL(process.env.EGDATA_TEST_OPENSEARCH ?? "");
    expect(endpoint.hostname).toBe("127.0.0.1");
    const index = "egdata-transport-" + randomUUID();
    const setup = {
      mapping: { rank: { type: "integer" as const } },
      documents: [
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ],
      query: {
        size: 1,
        sort: [{ rank: "asc" as const }],
        query: { match_all: {} },
      },
    };
    vi.stubEnv("OPENSEARCH_URL", endpoint.href);
    vi.stubEnv("OPENSEARCH_USERNAME", "admin");
    vi.stubEnv("OPENSEARCH_PASSWORD", "Fixture-Only-Search-42!");
    vi.resetModules();
    const client = (
      await import("../src/clients/opensearch.js")
    ).getOpenSearchClient();
    let created = false;
    try {
      await client.indices.create({
        index,
        body: { settings: { number_of_shards: 1, number_of_replicas: 0 } },
      });
      created = true;
      await client.indices.putMapping({
        index,
        body: { properties: setup.mapping },
      });
      for (const { id, rank } of setup.documents)
        await client.index({ index, id, refresh: true, body: { rank } });
      const mapped = (await client.indices.getMapping({ index })).body[index]
        .mappings;
      const hitPage = z.object({
        total: z.object({ value: z.number(), relation: z.string() }),
        hits: z.array(
          z.object({
            _id: z.string(),
            _source: z.object({ rank: z.number() }),
            sort: z.array(z.number()),
          }),
        ),
      });
      const first = hitPage.parse(
        (await client.search({ index, body: setup.query })).body.hits,
      );
      const continuation = { ...setup.query, search_after: first.hits[0].sort };
      const second = hitPage.parse(
        (await client.search({ index, body: continuation })).body.hits,
      );
      async function status(action: Promise<unknown>) {
        try {
          await action;
          return 200;
        } catch (e) {
          return (e as { statusCode: number }).statusCode;
        }
      }
      const missing = await status(
        client.search({ index: index + "-missing", body: setup.query }),
      );
      const invalidQuery = await status(
        client.search({
          index,
          body: { query: { unsupported_fixture_query: {} } } as never,
        }),
      );
      vi.stubEnv("OPENSEARCH_PASSWORD", "Invalid-Fixture-Credential");
      vi.resetModules();
      const rejected = (
        await import("../src/clients/opensearch.js")
      ).getOpenSearchClient();
      try {
        const unauthenticated = await status(
          rejected.search({ index, body: setup.query }),
        );
        const pages = [first, second].map((hits) => ({
          total: hits.total,
          hits: hits.hits.map((h) => ({
            id: h._id,
            source: h._source,
            sort: h.sort,
          })),
        }));
        expect([missing, invalidQuery, unauthenticated]).toEqual([
          404, 400, 401,
        ]);
        assertOracle("search-clients-cluster-node", [
          { setup, mapped, pages, missing, invalidQuery, unauthenticated },
        ]);
      } finally {
        await rejected.close();
      }
    } finally {
      try {
        if (created) await client.indices.delete({ index });
      } finally {
        await client.close();
        vi.unstubAllEnvs();
      }
    }
  },
  30000,
);
