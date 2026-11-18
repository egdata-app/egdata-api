import { expect, it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { requestAchievementRefresh } from "../src/clients/achievement-refresh.js";
import {
  createJobApiSignature,
  JobApiRequestError,
  loadJobApiClientConfig,
  submitJobApiRequest,
} from "../src/clients/job-api.js";

vi.mock("../src/clients/redis.js", () => ({ default: {} }));

it("records URL, signing-key, and timer boundaries", async () => {
  const body = '{"nested":{"title":"tést"}}';
  const cases = [];
  for (const [url, secret] of [
    ["/relative", ""],
    ["http://jobs.local/root?", ""],
    ["http://jobs.local/a%20b?x=1+2#ignored", "s".repeat(256)],
  ]) {
    let output: unknown;
    try {
      output = {
        signature: createJobApiSignature({
          keyId: "worker",
          secret,
          timestamp: "-1",
          nonce: "edge_nonce-123456",
          method: "post",
          url,
          body: new TextEncoder().encode(body),
        }),
      };
    } catch (error) {
      output = { error: (error as Error).message };
    }
    cases.push({ url, secret, body, output });
  }
  const submissions = [];
  for (const [name, baseUrl, timeoutMs] of [
    ["invalid url", "invalid", 500],
    ["timer overflow", "http://jobs.local", 2 ** 31],
    ["invalid nonce character", "http://jobs.local", 500],
  ] as const) {
    const nonce =
      name === "invalid nonce character"
        ? "invalid!0123456789"
        : "edge_nonce-123456";
    let output: unknown;
    try {
      await submitJobApiRequest(
        "offer-regen",
        {},
        {
          config: { ...config, baseUrl },
          requestId,
          timeoutMs,
          maxAttempts: 1,
          nonce: () => nonce,
          now: () => -1,
          fetchImpl: (async (_url, init) =>
            new Promise<Response>((_, reject) =>
              init?.signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              ),
            )) as typeof fetch,
        },
      );
    } catch (error) {
      output = { error: (error as Error).message };
    }
    submissions.push({ name, baseUrl, timeoutMs, nonce, output });
  }
  assertOracle("job-boundaries-node", [{ signatures: cases, submissions }]);
});

const jobId = `api-achievement-refresh-${"a".repeat(64)}`;
const receipt = {
  jobId,
  workflowId: jobId,
  statusUrl: "/status/ok",
  deduplicated: false,
};
const requestId = "request_from_test_12345";
const config = {
  baseUrl: "http://localhost/prefix",
  keyId: "job-test",
  secret: "0123456789abcdef0123456789abcdef",
};

it("records signed Job API attempts and the error visible to its callers", async () => {
  const payload = '{"name":"tést","10":"ten","2":"two","n":1.0,"small":1e-7}';
  const cases = [];
  const accepted = { status: 202, body: JSON.stringify(receipt) };
  const partial = { status: 400, body: "truncated", partial: true };
  for (const [name, responses] of [
    ["accepted", [accepted]],
    ["retry", [{ status: 429, body: "try again" }, accepted]],
    ["partial receipt", [partial]],
    ["partial receipt retry", [partial, accepted]],
    ["invalid json", [{ status: 202, body: "{" }]],
    ["null receipt", [{ status: 202, body: "null" }]],
    ["incomplete receipt", [{ status: 202, body: "{}" }]],
    ["utf8 bom", [{ status: 202, body: `\ufeff${accepted.body}` }]],
    ["long rejection", [{ status: 403, body: `\ufeff${"🎮".repeat(251)}  ` }]],
  ] as const) {
    const calls: unknown[] = [];
    let output: unknown;
    try {
      output = await submitJobApiRequest(
        "achievement-refresh",
        JSON.parse(payload),
        {
          config,
          requestId,
          maxAttempts: responses.length,
          now: () => -1,
          sleep: async () => {},
          nonce: () => `fixture-attempt-${calls.length}`,
          fetchImpl: (async (url, init) => {
            const step = responses[calls.length];
            calls.push({
              path: new URL(String(url)).pathname,
              method: init?.method,
              headers: init?.headers,
              body: init?.body,
            });
            if ("partial" in step)
              return new Response(
                new ReadableStream({
                  start(stream) {
                    stream.error(new Error("incomplete"));
                  },
                }),
                { status: step.status },
              );
            return new Response(step.body, { status: step.status });
          }) as typeof fetch,
        },
      );
    } catch (error) {
      if (!(error instanceof JobApiRequestError)) throw error;
      output = {
        error: error.message,
        retryable: error.retryable,
        status: error.status ?? null,
      };
    }
    expect(calls).toHaveLength(responses.length);
    cases.push({ name, config, payload, requestId, responses, calls, output });
  }
  assertOracle("job-submit-node", cases);
});

it("records refresh locks, retained Redis metadata and failure receipts", async () => {
  const ttl = 10_000,
    now = 1_000_000,
    accountId = "example";
  const status = `refresh-achievements:${accountId}`,
    slot = `refresh-achievements:temporal-cooldown:${accountId}`;
  const slotId = "previous_lock_id_12345";
  type Scenario = {
    name: string;
    ttl?: number;
    times?: number[];
    initial?: Record<string, string>;
    failAt?: number;
    dropSlot?: boolean;
  };
  const scenarios: Scenario[] = [
    { name: "accepted" },
    {
      name: "reuse existing active",
      initial: { [status]: '{"timestamp":9.99e5}' },
    },
    { name: "reacquire expired", initial: { [status]: '{"timestamp":100.0}' } },
    {
      name: "existing request wins",
      initial: {
        [slot]: JSON.stringify({ requestId: slotId, timestamp: now - 1 }),
      },
    },
    {
      name: "slot decimal integer",
      initial: {
        [slot]: '{"requestId":"previous_lock_id_12345","timestamp":999999.0}',
      },
    },
    {
      name: "expires after acceptance",
      times: [now, now, now, now + ttl + 10],
    },
    { name: "slot disappeared", dropSlot: true },
    { name: "invalid ttl", ttl: 0 },
    { name: "unsafe ttl", ttl: 2 ** 53 },
    { name: "invalid accepted date", times: [now, now, now, 9e15] },
    ...["{", "[]", '{"timestamp":0.5}', '{"timestamp":9007199254740992}'].map(
      (raw) => ({ name: `bad status ${raw}`, initial: { [status]: raw } }),
    ),
    ...[
      "null",
      "{",
      '{"requestId":"short","timestamp":1000000}',
      JSON.stringify({ requestId: slotId, timestamp: now + 1 }),
      JSON.stringify({ requestId: slotId, timestamp: now - ttl }),
      JSON.stringify({ requestId: slotId, timestamp: 2 ** 53 }),
    ].map((raw) => ({ name: `bad slot ${raw}`, initial: { [slot]: raw } })),
    ...Array.from({ length: 5 }, (_, failAt) => ({
      name: `failure at ${failAt}`,
      failAt,
    })),
  ];
  const cases = [];
  for (const scenario of scenarios) {
    const times = scenario.times ?? [now, now, now, now],
      calls: unknown[] = [];
    const values = { ...scenario.initial };
    let tick = 0;
    const call = (value: unknown) => {
      calls.push(value);
      if (calls.length - 1 === scenario.failAt)
        throw new Error("fixture failure");
    };
    let output: unknown;
    try {
      output = await requestAchievementRefresh(accountId, scenario.ttl ?? ttl, {
        now: () => times[tick++],
        createRequestId: () => requestId,
        cacheGet: async (key) => {
          call({ method: "get", key });
          return values[key] ?? null;
        },
        cacheSet: async (key, raw, ttl, nx) => {
          call({ method: "set", key, raw, ttl, nx });
          if (!(nx && (scenario.dropSlot || key in values))) values[key] = raw;
        },
        submit: async (type, payload, options) => {
          call({
            method: "submit",
            type,
            payload,
            requestId: options?.requestId,
          });
          return receipt;
        },
      });
    } catch (error) {
      output = { error: (error as Error).message };
    }
    cases.push({
      ...scenario,
      times,
      ttl: scenario.ttl ?? ttl,
      calls,
      output,
      values,
    });
  }
  assertOracle("job-refresh-node", cases);
});

it("records env validation at the Job API boundary", () => {
  const base = {
    JOB_API_BASE_URL: "http://jobs.example/queue/",
    JOB_API_KEY_ID: "api-0._",
    JOB_API_SECRET: "a".repeat(32),
  };
  const inputs: Record<string, string>[] = [
    {},
    { JOB_API_BASE_URL: base.JOB_API_BASE_URL },
    { JOB_API_BASE_URL: base.JOB_API_BASE_URL, JOB_API_KEY_ID: "a" },
    base,
    { ...base, JOB_API_BASE_URL: "relative/path" },
    { ...base, JOB_API_BASE_URL: "file:///queue" },
    { ...base, JOB_API_SECRET: "é".repeat(15) },
    { ...base, JOB_API_BASE_URL: "http://jobs.example/queue?x=1" },
    { ...base, JOB_API_BASE_URL: "http://jobs.example/queue#x" },
    { ...base, JOB_API_BASE_URL: "http://jobs.example/queue?#" },
    { ...base, JOB_API_BASE_URL: "http://:password@jobs.example/" },
    { ...base, JOB_API_KEY_ID: "a?" },
    { ...base, JOB_API_KEY_ID: "\ufeffapi_1\ufeff" },
    { ...base, JOB_API_SECRET: "\ufeff".repeat(32) },
    { ...base, JOB_API_SECRET: "é".repeat(16) },
  ];
  assertOracle(
    "job-config-node",
    inputs.map((input) => {
      try {
        return {
          input,
          output: loadJobApiClientConfig(input as NodeJS.ProcessEnv),
        };
      } catch (error) {
        return { input, output: { error: (error as Error).message } };
      }
    }),
  );
});
