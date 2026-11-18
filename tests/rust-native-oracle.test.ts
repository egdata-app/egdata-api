import { Hono } from "hono";
import { BSON } from "mongodb";
import { describe, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import type { V1Variables } from "../src/v1/request-context.js";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  count: 0,
  fail: false,
}));
vi.mock("../src/models/index.js", () => {
  const model = {
    find: () => ({
      lean: async () => {
        if (state.fail) throw new Error("fixture database failure");
        return state.rows;
      },
    }),
    countDocuments: async () => {
      if (state.fail) throw new Error("fixture database failure");
      return state.count;
    },
  };
  return { Offer: model, Item: model, TagModel: model };
});
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: () => ({
        find: () => ({
          toArray: async () => {
            if (state.fail) throw new Error("fixture database failure");
            return state.rows;
          },
        }),
        countDocuments: async () => {
          if (state.fail) throw new Error("fixture database failure");
          return state.count;
        },
      }),
    },
  },
}));

import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import nativeRoutes from "../src/v1/routes/native.js";

describe("canonical Node native HTTP oracle for Rust", () => {
  it("records native bodies, conditional requests, validation and upstream errors", async () => {
    vi.stubEnv("V1_PUBLIC_BASE_URL", "https://api.egdata.app/v1");
    const app = new Hono<{ Variables: V1Variables }>();
    app.use("*", async (c, next) => {
      c.set("requestId", "req_node_oracle");
      await next();
    });
    app.use("*", responseEtag);
    app.route("/v1", nativeRoutes);
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
    const inputs: Array<{
      name: string;
      path: string;
      method?: string;
      rows?: Record<string, unknown>[];
      wireRows?: Buffer[];
      count?: number;
      fail?: boolean;
    }> = [
      { name: "robots", path: "/v1/robots.txt" },
      { name: "robots-head", path: "/v1/robots.txt", method: "HEAD" },
      { name: "robots-unknown-query", path: "/v1/robots.txt?bad=1" },
      { name: "offers-index-empty", path: "/v1/sitemap.xml", count: 0 },
      {
        name: "offers-page",
        path: "/v1/sitemap.xml?page=1",
        rows: [{ id: "offer-a", lastModifiedDate: "2026-09-01T01:02:03.000Z" }],
      },
      { name: "items-index", path: "/v1/items-sitemap.xml", count: 1001 },
      { name: "items-alias-index", path: "/v1/items/sitemap.xml", count: 1001 },
      {
        name: "items-page",
        path: "/v1/items-sitemap.xml?page=2",
        rows: [
          { id: "item-a", lastModifiedDate: "2026-09-02" },
          { id: "item-b", lastModifiedDate: null },
        ],
      },
      { name: "items-zero-page", path: "/v1/items-sitemap.xml?page=0" },
      { name: "items-bad-page", path: "/v1/items-sitemap.xml?page=nope" },
      {
        name: "items-duplicate-page",
        path: "/v1/items-sitemap.xml?page=1&page=bad",
        rows: [],
      },
      {
        name: "promotions",
        path: "/v1/promotions-sitemap.xml",
        rows: [{ id: "event-a" }],
      },
      {
        name: "profiles",
        path: "/v1/profiles/sitemap.xml",
        rows: [{ accountId: "account-a" }, { accountId: "" }, {}],
      },
      {
        name: "sandboxes-index",
        path: "/v1/sandboxes/sitemap.xml",
        count: 1001,
      },
      {
        name: "sandboxes-page",
        path: "/v1/sandboxes/sitemap.xml?page=1",
        rows: [
          { _id: "sandbox-a", updated: "2026-09-03T00:00:00Z" },
          { _id: "sandbox-b", updated: null },
        ],
      },
      {
        name: "offers-invalid-date",
        path: "/v1/sitemap.xml?page=1",
        rows: [{ id: "offer-a", lastModifiedDate: "invalid" }],
      },
      {
        name: "items-invalid-date",
        path: "/v1/items-sitemap.xml?page=1",
        rows: [{ id: "item-a", lastModifiedDate: "invalid" }],
      },
      {
        name: "sandboxes-invalid-date",
        path: "/v1/sandboxes/sitemap.xml?page=1",
        rows: [{ _id: "sandbox-a", updated: "invalid" }],
      },
      {
        name: "items-db-failure",
        path: "/v1/items-sitemap.xml?page=1",
        fail: true,
      },
    ];
    for (const [name, path] of [
      ["offers-count", "/v1/sitemap.xml"],
      ["offer-rows", "/v1/sitemap.xml?page=1"],
      ["item-count", "/v1/items-sitemap.xml"],
      ["promotions-rows", "/v1/promotions-sitemap.xml"],
      ["profile-rows", "/v1/profiles/sitemap.xml"],
      ["sandbox-count", "/v1/sandboxes/sitemap.xml"],
      ["sandbox-rows", "/v1/sandboxes/sitemap.xml?page=1"],
    ])
      inputs.push({ name: name + "-failure", path, fail: true });
    for (const path of [
      "/v1/items-sitemap.xml",
      "/v1/promotions-sitemap.xml",
      "/v1/profiles/sitemap.xml",
      "/v1/sandboxes/sitemap.xml",
    ])
      inputs.push({ name: "unknown query " + path, path: path + "?unknown=1" });
    inputs.push({
      name: "invalid sandbox page",
      path: "/v1/sandboxes/sitemap.xml?page=0",
    });
    const mixed = [
      { id: 42, lastModifiedDate: 1.9 },
      { id: null, lastModifiedDate: false },
      { id: true, lastModifiedDate: true },
      { lastModifiedDate: 0 },
      { id: ["nested"], lastModifiedDate: "" },
    ];
    inputs.push(
      {
        name: "offer historical scalars",
        path: "/v1/sitemap.xml?page=1",
        rows: mixed,
      },
      {
        name: "item historical scalars",
        path: "/v1/items-sitemap.xml?page=1",
        rows: mixed,
      },
      {
        name: "historical promotion IDs",
        path: "/v1/promotions-sitemap.xml",
        rows: [{ id: 42 }, { id: null }, {}],
      },
      {
        name: "historical profile IDs",
        path: "/v1/profiles/sitemap.xml",
        rows: [
          { accountId: 41 },
          { accountId: 0 },
          { accountId: true },
          { accountId: {} },
          { accountId: null },
        ],
      },
      {
        name: "historical sandbox IDs",
        path: "/v1/sandboxes/sitemap.xml?page=1",
        rows: [{ _id: 42 }, { _id: null }, {}],
      },
    );
    inputs.push(
      {
        name: "item extended-year timestamps",
        path: "/v1/items-sitemap.xml?page=1",
        rows: [
          { id: "latest", lastModifiedDate: 8_640_000_000_000_000 },
          { id: "earliest", lastModifiedDate: -8_640_000_000_000_000 },
          { id: "extended", lastModifiedDate: -62_198_755_200_000 },
          { id: "year", lastModifiedDate: "2020" },
          { id: "month", lastModifiedDate: "2020-04" },
          { id: "array", lastModifiedDate: ["2020-04-01"] },
        ],
      },
      {
        name: "item invalid timestamp magnitude",
        path: "/v1/items-sitemap.xml?page=1",
        rows: [{ id: "overflow", lastModifiedDate: 8_640_000_000_000_001 }],
      },
    );
    for (const [path, id, field] of [
      ["/v1/sitemap.xml?page=1", "id", "lastModifiedDate"],
      ["/v1/items-sitemap.xml?page=1", "id", "lastModifiedDate"],
      ["/v1/items/sitemap.xml?page=1", "id", "lastModifiedDate"],
      ["/v1/sandboxes/sitemap.xml?page=1", "_id", "updated"],
    ]) {
      for (const millis of [8640000000000000n, 8640000000000001n]) {
        const raw = Buffer.from(BSON.serialize({ [id]: "boundary", [field]: new Date(0) }));
        raw.writeBigInt64LE(millis, raw.length - 9);
        inputs.push({ name: `stored BSON date ${millis} ${path}`, path, wireRows: [raw] });
      }
    }
    const cases = [];
    try {
      for (const input of inputs) {
        state.rows = input.wireRows?.map((row) => BSON.deserialize(row)) ?? input.rows ?? [];
        state.count = input.count ?? 0;
        state.fail = input.fail ?? false;
        const request = { path: input.path, method: input.method ?? "GET" };
        cases.push({
          name: input.name,
          input: {
            ...(input.wireRows
              ? { wireRows: input.wireRows.map((row) => row.toString("hex")) }
              : { rows: state.rows }),
            count: state.count,
            fail: state.fail,
          },
          request,
          response: await captureResponse(
            await app.request(request.path, { method: request.method }),
          ),
        });
      }
      state.fail = false;
      const first = await app.request("/v1/robots.txt");
      const tag = first.headers.get("etag")!;
      for (const [name, value] of [
        ["conditional-match", tag],
        ["conditional-weak", `W/${tag}`],
        ["conditional-wildcard", "*"],
      ]) {
        const request = {
          path: "/v1/robots.txt",
          method: "GET",
          headers: { "if-none-match": value },
        };
        cases.push({
          name,
          input: { rows: [], count: 0, fail: false },
          request,
          response: await captureResponse(
            await app.request(request.path, { headers: request.headers }),
          ),
        });
      }
      assertOracle("native-http-node", cases);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
