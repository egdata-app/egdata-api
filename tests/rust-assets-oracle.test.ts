import { Hono } from "hono";
import { describe, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import type { V1Variables } from "../src/v1/request-context.js";

const state = vi.hoisted(() => ({
  input: {} as {
    asset?: unknown;
    cached?: string;
    databaseFailure?: boolean;
    cacheReadFailure?: boolean;
    cacheWriteFailure?: boolean;
  },
  calls: [] as unknown[],
}));
vi.mock("../src/models/index.js", () => ({
  Asset: {
    findOne: (filter: unknown) => ({
      lean: async () => {
        state.calls.push({
          operation: "findOne",
          collection: "assets",
          filter,
        });
        if (state.input.databaseFailure)
          throw new Error("fixture database failure");
        return state.input.asset ?? null;
      },
    }),
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      state.calls.push({ operation: "cacheGet", key });
      if (state.input.cacheReadFailure)
        throw new Error("fixture cache read failure");
      return state.input.cached ?? null;
    },
    set: async (key: string, value: string, mode: string, ttl: number) => {
      state.calls.push({
        operation: "cacheSet",
        key,
        value: JSON.parse(value),
        mode,
        ttl,
      });
      if (state.input.cacheWriteFailure)
        throw new Error("fixture cache write failure");
      return "OK";
    },
  },
}));

import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import routes from "../src/v1/routes/assets.js";

describe("canonical Node asset HTTP oracle for Rust", () => {
  it("captures asset responses and database/cache calls", async () => {
    const app = new Hono<{ Variables: V1Variables }>();
    app.use("*", async (c, next) => {
      c.set("requestId", "req_node_oracle");
      await next();
    });
    app.use("*", responseEtag);
    app.route("/v1", routes);
    app.onError((error, c) =>
      problemResponse(
        c,
        error instanceof ProblemError
          ? error
          : new ProblemError({
              status: 500,
              code: "INTERNAL_ERROR",
              detail:
                "The API could not complete the request. Retry later and include the request ID when contacting support.",
            }),
      ),
    );
    const asset = {
      artifactId: "asset-a",
      appName: "Game",
      buildVersion: "1.0",
      metadata: { platforms: ["Windows", "Mac"] },
    };
    const inputs = [
      { name: "asset-success", input: { asset } },
      {
        name: "asset-cache-hit",
        input: { cached: JSON.stringify(asset), databaseFailure: true },
      },
      { name: "asset-corrupt-cache", input: { cached: "{broken", asset } },
      { name: "asset-null-cache", input: { cached: "null", asset } },
      {
        name: "asset-false-cache",
        input: { cached: "false", databaseFailure: true },
      },
      {
        name: "asset-cache-read-failure",
        input: { cacheReadFailure: true, asset },
      },
      {
        name: "asset-cache-write-failure",
        input: { cacheWriteFailure: true, asset },
      },
      { name: "asset-missing", input: {} },
      { name: "asset-database-failure", input: { databaseFailure: true } },
      {
        name: "asset-trimmed-id",
        path: "/v1/assets/%20asset-a%20",
        input: { asset },
      },
      {
        name: "asset-bom-trimmed-id",
        path: `/v1/assets/${encodeURIComponent("\uFEFFasset-a\uFEFF")}`,
        input: { asset },
      },
      {
        name: "asset-nel-id-not-trimmed",
        path: `/v1/assets/${encodeURIComponent("\u0085asset-a\u0085")}`,
        input: {},
      },
      {
        name: "asset-utf16-long-id",
        path: `/v1/assets/${encodeURIComponent("\u{1F680}".repeat(101))}`,
        input: {},
      },
      { name: "asset-empty-id", path: "/v1/assets/%20", input: {} },
      {
        name: "asset-unicode-id-missing",
        path: "/v1/assets/caf%C3%A9",
        input: {},
      },
      {
        name: "asset-reserved-id-missing",
        path: "/v1/assets/%2f%3F%23",
        input: {},
      },
      { name: "asset-percent-id-missing", path: "/v1/assets/%25", input: {} },
      {
        name: "asset-double-encoded-id-missing",
        path: "/v1/assets/%2520",
        input: {},
      },
      {
        name: "asset-mixed-id-missing",
        path: "/v1/assets/a%20b%2Fc",
        input: {},
      },
      {
        name: "asset-long-id",
        path: `/v1/assets/${"a".repeat(201)}`,
        input: {},
      },
      {
        name: "asset-ignored-query",
        path: "/v1/assets/asset-a?extra=1",
        input: { asset },
      },
      { name: "asset-head", method: "HEAD", input: { asset } },
      {
        name: "asset-deep-document",
        input: {
          asset: {
            artifactId: "asset-a",
            metadata: Array.from({ length: 14 }).reduce<unknown>(
              (value) => ({ child: value }),
              "leaf",
            ),
          },
        },
      },
    ];
    const cases = [];
    for (const entry of inputs) {
      state.input = entry.input;
      state.calls = [];
      const request = {
        method: entry.method ?? "GET",
        path: entry.path ?? "/v1/assets/asset-a",
      };
      const response = await captureResponse(
        await app.request(request.path, { method: request.method }),
      );
      cases.push({
        name: entry.name,
        input: entry.input,
        request,
        response,
        calls: state.calls,
      });
    }
    assertOracle("assets-http-node", cases);
  });
});
