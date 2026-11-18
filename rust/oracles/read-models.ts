import { Hono } from "hono";
import { afterEach, expect, vi } from "vitest";
import { responseEtag } from "../../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../../src/v1/errors.js";
import {
  type V1Variables,
  v1CachePolicy,
  v1Context,
} from "../../src/v1/request-context.js";
import { captureResponse, fixtureValue } from "./record.js";

const mock = vi.hoisted(() => ({ read: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock("../../src/db/index.js", () => ({
  db: {
    db: {
      collection: (name: string) => ({
        findOne: async (filter: unknown, options = {}) =>
          mock.read(name, "one", filter, options),
        find: (filter: unknown, options: Record<string, unknown> = {}) => {
          const effectiveOptions = { ...options };
          const cursor = {
            sort(sort: unknown) {
              effectiveOptions.sort = sort;
              return cursor;
            },
            limit(limit: number) {
              effectiveOptions.limit = limit;
              return cursor;
            },
            toArray: async () =>
              mock.read(name, "many", filter, effectiveOptions),
          };
          return cursor;
        },
        countDocuments: async (filter: unknown, options = {}) =>
          mock.read(name, "count", filter, options),
        distinct: async (field: string, filter = {}) =>
          mock.read(name, "distinct", filter, { field }),
        aggregate: (pipeline: unknown, options = {}) => ({
          toArray: async () => mock.read(name, "aggregate", pipeline, options),
        }),
      }),
    },
  },
}));
vi.mock("../../src/clients/response-cache.js", () => ({
  default: { get: mock.get, set: mock.set },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

export function recordMongoReads(
  ...groups: Hono<{ Variables: V1Variables }>[]
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
  vi.stubEnv(
    "V1_CURSOR_SECRET",
    "deterministic-collection-cursor-secret-for-oracle",
  );
  vi.stubEnv("V1_WORKER_TOKEN", "oracle-worker");
  const app = new Hono<{ Variables: V1Variables }>();
  app.use("*", v1Context(), responseEtag, v1CachePolicy());
  for (const routes of groups) app.route("/v1", routes);
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
  const cases: unknown[] = [];
  type Seed = Record<string, unknown>;
  async function record(
    name: string,
    path: string,
    status: number,
    seed: Seed = {},
    hit?: unknown,
    cacheUnavailable = false,
    post?: { rawBody: string; contentType?: string },
  ) {
    const trace: unknown[] = [];
    const gate = seed.__holdUntilResponse as {collection:string; method:string; query?:unknown; remaining:number} | undefined;
    let releaseRead: (() => void) | undefined;
    const sequences = new Map<string, unknown[]>(
      Object.entries(
        (seed.__sequence as Record<string, unknown[]> | undefined) ?? {},
      ),
    );
    mock.read.mockImplementation(
      (
        collection: string,
        method: string,
        query: unknown,
        options: unknown,
      ) => {
        const key = `${collection}.${method}`;
        const sequence = sequences.get(key);
        const result = sequence?.length
          ? sequence.shift()
          : Object.hasOwn(seed, key)
            ? seed[key]
            : (seed[collection] ??
              (method === "one" ? null : method === "count" ? 0 : []));
        const call = {
          collection,
          method,
          query: fixtureValue(query, "query"),
          options,
        };
        if (result === "FAIL") {
          trace.push({ call, error: true });
          throw new Error("fixture read failed");
        }
        if (gate && gate.collection === collection && gate.method === method &&
          (gate.query === undefined || JSON.stringify(gate.query) === JSON.stringify(query))) {
          trace.push({ call, result: fixtureValue(result, true), releaseAfterResponse:true });
          return new Promise(resolve => { releaseRead = () => resolve(result); });
        }
        trace.push({ call, result: fixtureValue(result, true) });
        return result;
      },
    );
    mock.get.mockImplementation(async (key: string) => {
      if (cacheUnavailable) {
        trace.push({ call: { method: "get", key }, error: true });
        throw new Error("Redis unavailable");
      }
      trace.push({ call: { method: "get", key }, result: hit ?? null });
      return hit === undefined ? null : JSON.stringify(hit);
    });
    mock.set.mockImplementation(
      async (key: string, payload: string, _ex: string, ttl: number) => {
        const call = { method: "set", key, payload: JSON.parse(payload), ttl };
        if (cacheUnavailable) {
          trace.push({ call, error: true });
          throw new Error("Redis unavailable");
        }
        trace.push({ call, result: null });
        return "OK";
      },
    );
    const request = post ? { path, method: "POST", ...post } : { path, method: "GET" };
    const response = await captureResponse(
      await app.request(path, {
        method: request.method,
        body: post?.rawBody,
        headers: {
          ...(post?.contentType ? { "content-type": post.contentType } : {}),
          "x-request-id": "req_node_oracle",
          "x-egdata-worker-token": "oracle-worker",
          "x-egdata-key-id": "key_oracle",
          "x-egdata-key-tier": "free",
        },
      }),
    );
    expect(response.status, `${name} ${JSON.stringify(response.body)}`).toBe(
      status,
    );
    if (gate) {
      expect(releaseRead, name + " must start the held read").toBeTypeOf("function");
      const expected = trace.length + gate.remaining;
      releaseRead!();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(trace, name + " sibling continuation").toHaveLength(expected);
    }
    cases.push({ name, request, trace, response, ...(gate ? {remainingReadsAfterResponse:gate.remaining} : {}) });
    return response.body;
  }
  return { cases, record };
}
