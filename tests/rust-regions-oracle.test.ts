import { Hono } from "hono";
import { it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import catalog from "../src/v1/routes/catalog.js";

vi.mock("../src/clients/response-cache.js", () => ({ default: {} }));
vi.mock("../src/db/index.js", () => ({ db: {} }));
vi.mock("../src/models/index.js", () => ({}));
vi.mock("../src/utils/get-featured-games.js", () => ({
  getFeaturedGames: vi.fn(),
}));
vi.mock("../src/utils/changelog-context.js", () => ({
  resolveChangelogContextSafely: vi.fn(),
}));

it("compares regional metadata and country normalization with Node", async () => {
  const app = new Hono();
  app.use("*", v1Context());
  app.use("*", responseEtag);
  app.use("*", v1CachePolicy());
  app.route("/v1", catalog);
  app.onError((error, c) => {
    if (error instanceof ProblemError) return problemResponse(c, error);
    throw error;
  });
  const headers = {
    "x-egdata-key-id": "key_oracle",
    "x-egdata-key-tier": "free",
    "x-request-id": "req_node_oracle",
  };
  const cases = [];
  for (const [name, path] of [
    ["countries", "/countries"],
    ["regions", "/regions"],
    ["default", "/region"],
    ["europe", "/region?country=%20de%20"],
    ["asia", "/region?country=JP"],
    ["bom", "/region?country=%EF%BB%BFUS"],
    ["nel", "/region?country=%C2%85US"],
    ["empty", "/region?country="],
    ["unknown", "/region?country=ZZ"],
    ["duplicate", "/region?country=GB&country=US"],
    ["unknown-key", "/regions?extra=1"],
  ]) {
    const request = { method: "GET", path: `/v1${path}` };
    cases.push({
      name,
      request,
      response: await captureResponse(
        await app.request(request.path, { headers }),
      ),
    });
  }
  const path = "/v1/region";
  const etag = cases.find((entry) => entry.name === "default")?.response.headers
    .etag;
  if (!etag) throw new Error("Expected an ETag for the region lookup");
  for (const request of [
    { method: "HEAD", path },
    { method: "GET", path, headers: { "if-none-match": etag } },
  ]) {
    cases.push({
      name: request.method === "HEAD" ? "head" : "conditional-get",
      request,
      response: await captureResponse(
        await app.request(path, {
          method: request.method,
          headers: { ...headers, ...request.headers },
        }),
      ),
    });
  }
  assertOracle("regions-http-node", cases);
});
