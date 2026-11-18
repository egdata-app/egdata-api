import { ApolloServer, HeaderMap } from "@apollo/server";
import {
  ApolloServerPluginLandingPageLocalDefault,
  ApolloServerPluginLandingPageProductionDefault,
} from "@apollo/server/plugin/landingPage/default";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";

for (const [environment, plugin] of [
  ["development", ApolloServerPluginLandingPageLocalDefault()],
  ["production", ApolloServerPluginLandingPageProductionDefault()],
] as const) {
  it(`matches the ${environment} Apollo landing page`, async () => {
    const server = new ApolloServer({
      typeDefs: "type Query { hello: String }",
      plugins: [plugin],
    });
    await server.start();
    try {
      const result = await server.executeHTTPGraphQLRequest({
        httpGraphQLRequest: {
          method: "GET",
          headers: new HeaderMap([["accept", "text/html"]]),
          search: "",
          body: undefined,
        },
        context: async () => ({}),
      });
      expect(result.headers.get("content-type")).toBe("text/html");
      if (result.body.kind !== "complete")
        throw Error("Expected HTML response");
      const html = result.body.string;
      const nonce = html.match(/'nonce-([0-9a-f]{64})'/)?.[1];
      if (!nonce) throw Error("Missing Apollo landing page nonce");
      const template = html.replaceAll(nonce, "{{APOLLO_NONCE}}");
      const file = new URL(
        `../rust/crates/egdata-api/src/graphql/landing-${environment}.html`,
        import.meta.url,
      );
      if (process.env.RUST_ORACLE_WRITE === "1")
        await writeFile(file, template);
      expect(template).toBe(await readFile(file, "utf8"));
    } finally {
      await server.stop();
    }
  });
}
