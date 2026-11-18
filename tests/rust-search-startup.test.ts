import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withOrigin } from "./fixtures/origin-listener.js";

for (const origin of ["node", "rust"]) {
  it.skipIf(
    !process.env.EGDATA_TEST_MONGO ||
      !process.env.EGDATA_TEST_REDIS ||
      (origin === "rust" && !process.env.EGDATA_TEST_RUST_ORIGIN_BIN),
  )(
    origin +
      " keeps public routes available when optional search configuration is invalid",
    async () => {
      const endpoint = new URL(process.env.EGDATA_TEST_REDIS ?? "");
      expect(endpoint.hostname).toBe("127.0.0.1");
      const redis = { REDISPORT: endpoint.port };
      // Registered catalog routes use OpenSearch lazily; the old eager
      // Meilisearch client is not imported by the Node listener.
      await withOrigin(
        origin,
        {
          ...redis,
          MEILISEARCH_INSTANCE: "http://bad host",
          MEILISEARCH_API_KEY: "fixture🔍",
          OPENSEARCH_URL: "http://invalid host",
        },
        async ({ ready, get, checkHealth }) => {
          await ready();
          await checkHealth(200);
          const search = await get(
            "/v1/free-games/search?title=" + randomUUID(),
          );
          expect(search.status).toBe(503);
          expect(await search.json()).toMatchObject({
            code: "SEARCH_UNAVAILABLE",
          });
        },
      );
      await withOrigin(
        origin,
        {
          ...redis,
          MEILISEARCH_INSTANCE: "http://bad host",
          OPENSEARCH_URL: "http://invalid host",
          MONGO_CA: join(tmpdir(), randomUUID() + ".pem"),
        },
        async ({ exited, output }) => {
          expect(await exited()).toBe(1);
          expect(output()).toMatch(/MongoDB/i);
        },
      );
    },
    60000,
  );
}
