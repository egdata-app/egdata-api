import { BSON, Decimal128, Long, ObjectId } from "mongodb";
import { captureResponse } from "./record.js";
import type { Hono } from "hono";

type DriverReply = [string, string, unknown];
type RequestInput = {
  method: string;
  path: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
};

// Record the actual driver calls from the Node models, including BSON type distinctions.
function bsonJson(value: unknown, result = false): unknown {
  if (result && typeof value === "number" && !Number.isFinite(value)) {
    return { $numberDouble: String(value) };
  }
  if (value instanceof Decimal128) return { $numberDecimal:value.toString() };
  if (value instanceof Long) return { $numberLong:value.toString() };
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Date) {
    const { date } = BSON.deserialize(BSON.serialize({ date: value }));
    return { $date: date.toISOString() };
  }
  if (Array.isArray(value)) return value.map((entry) => bsonJson(entry, result));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, bsonJson(v, result)]),
    );
  return value;
}

export function createReadRecorder() {
  const trace: unknown[] = [];
  const replies: DriverReply[] = [];
  let hit: unknown = null;
  let failAt: number | undefined;
  let rawCache: string | undefined;
  let failed = false;
  function checkFailure(call: object) {
    if (failAt !== undefined && failAt === trace.length) {
      failed = true;
      trace.push({ call, error: true });
      throw new Error("fixture read failed");
    }
  }
  function collection(name: string) {
    const read = (
      method: string,
      query: unknown = {},
      options: unknown = {},
    ) => {
      const next = replies.shift();
      if (!next || next[0] !== name || next[1] !== method)
        throw new Error(
          `Unexpected ${name}.${method}, expected ${next?.slice(0, 2)}`,
        );
      const call = {
        collection: name,
        method,
        query: bsonJson(query),
        options: bsonJson(options),
      };
      checkFailure(call);
      if (next[2] instanceof Error) {
        trace.push({ call, error: true });
        throw next[2];
      }
      trace.push({ call, result: bsonJson(next[2], true) });
      return next[2];
    };
    return {
      findOne: async (q: unknown, options: unknown) => read("one", q, options),
      find: (q: unknown = {}, options: Record<string, unknown> = {}) => {
        const actual = { ...options };
        // "lean" is a model option ignored by Mongo's native FindOperation.
        delete actual.lean;
        const cursor = {
          sort(value: unknown) {
            actual.sort = value;
            return cursor;
          },
          limit(value: number) {
            actual.limit = value;
            return cursor;
          },
          skip(value: number) {
            actual.skip = value;
            return cursor;
          },
          toArray: async () => read("many", q, actual),
        };
        return cursor;
      },
      countDocuments: async (q: unknown) => read("count", q),
      distinct: async (field: string, q: unknown) =>
        read("distinct", q, { field }),
      updateOne: async (q: unknown, update: unknown) =>
        read("update", q, { update }),
      aggregate: (q: unknown[], options: unknown) => {
        const stages = [...q];
        const cursor = {
          limit(value: number) {
            stages.push({ $limit: value });
            return cursor;
          },
          toArray: async () => read("aggregate", stages, options),
        };
        return cursor;
      },
    };
  }
  const cache = {
    get: async (key: string) => {
      checkFailure({ method: "get", key });
      if (rawCache !== undefined) {
        trace.push({ call: { method: "get", key }, rawResult: rawCache });
        return rawCache;
      }
      trace.push({ call: { method: "get", key }, result: hit });
      return hit === null ? null : JSON.stringify(hit);
    },
    set: async (key: string, payload: string, _mode: string, ttl: number) => {
      const call = { method: "set", key, payload: JSON.parse(payload), ttl };
      checkFailure(call);
      trace.push({ call, result: null });
      return "OK";
    },
  };
  async function record(
    app: Hono,
    name: string,
    request: RequestInput,
    expectedStatus: number,
    reads: DriverReply[],
    cacheHit: unknown = null,
    additionalHeaders: string[] = [],
    failureAt?: number,
    rawCacheResponse?: string,
  ) {
    trace.length = 0;
    replies.splice(0, replies.length, ...reads);
    hit = cacheHit;
    rawCache = rawCacheResponse;
    failAt = failureAt;
    failed = false;
    const response = await app.request(request.path, {
      method: request.method,
      headers: request.headers,
      body:
        request.rawBody ??
        (request.body === undefined ? undefined : JSON.stringify(request.body)),
    });
    if (response.status !== expectedStatus || (replies.length && !failed) || (failureAt !== undefined && !failed))
      throw new Error(
        `${name} returned ${response.status}, ${replies.length} reads pending`,
      );
    return {
      name,
      request,
      ...(additionalHeaders.length ? {
        additionalHeaders: Object.fromEntries(additionalHeaders.map(name => [name, response.headers.get(name)])),
      } : {}),
      trace: [...trace],
      response: await captureResponse(response),
    };
  }
  const receipt = {
    jobId: "job-1",
    workflowId: "workflow-1",
    statusUrl: "/jobs/job-1",
    deduplicated: false,
  };
  const jobs = {
    submitJobApiRequest: async (jobType: string, payload: unknown) => {
      trace.push({
        call: {
          service: "job",
          method: "submit",
          jobType,
          payload,
          requestId: null,
        },
        result: receipt,
      });
      return receipt;
    },
    submitJobApiBatch: async (jobType: string, payloads: unknown[]) => {
      const result = payloads.map(() => receipt);
      trace.push({
        call: {
          service: "job",
          method: "submitBatch",
          jobType,
          payloads,
          requestId: null,
        },
        result,
      });
      return result;
    },
  };
  function service(call: object, result: unknown) {
    trace.push({ call, result });
    return result;
  }
  function fail(call: object): never {
    trace.push({ call, error: true });
    throw new Error("fixture service failed");
  }
  const sharedRedis = {
    get: async (key: string) => {
      service({ service: "primaryRedis", method: "get", key }, hit);
      return hit === null ? null : JSON.stringify(hit);
    },
  };
  return { collection, cache, sharedRedis, jobs, record, service, fail };
}
