import { describe, expect, it, vi } from "vitest";
import {
  createJobApiIdempotencyKey,
  createJobApiNonce,
  createJobApiSignature,
  type JobApiClientConfig,
  JobApiRequestError,
  loadJobApiClientConfig,
  submitJobApiBatch,
  submitJobApiRequest,
} from "../src/clients/job-api.js";

const secret = "0123456789abcdef0123456789abcdef";
const config: JobApiClientConfig = {
  baseUrl: "https://ops.example.test",
  keyId: "api-client",
  secret,
};

function accepted(
  jobType: "offer-regen" | "item-regen" | "achievement-refresh",
) {
  const jobId = `api-${jobType}-${"a".repeat(64)}`;
  return {
    jobId,
    workflowId: jobId,
    statusUrl: `/v1/jobs/${jobId}`,
    deduplicated: false,
  };
}

describe("signed job API client", () => {
  it("matches the backend canonical HMAC vector exactly", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ id: "offer-123", namespace: "ns" }),
    );

    expect(
      createJobApiSignature({
        keyId: "api-client",
        secret,
        timestamp: "1784757000",
        nonce: "abcdefghijklmnop",
        method: "post",
        url: "https://ops.example.test/v1/jobs/offer-regens?source=api",
        idempotencyKey: "egdata-api:offer-regen:req:0:payload",
        body,
      }),
    ).toBe("9909841df5464fe1421334575443ddadc97de30d7a948e114b85de8c4c625d39");
  });

  it("fails closed when required credentials are absent or invalid", () => {
    expect(() => loadJobApiClientConfig({})).toThrow(
      "JOB_API_BASE_URL is required",
    );
    expect(() =>
      loadJobApiClientConfig({
        JOB_API_BASE_URL: "https://ops.example.test",
        JOB_API_KEY_ID: "api-client",
        JOB_API_SECRET: "too-short",
      }),
    ).toThrow("JOB_API_SECRET must contain at least 32 bytes");
  });

  it("uses fresh signed nonces but one stable idempotency key across retries", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
        status: 503,
      }),
      new Response(JSON.stringify(accepted("offer-regen")), { status: 202 }),
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch attempt");
      return response;
    };
    const nonces = ["nonce_retry_00000001", "nonce_retry_00000002"];
    const sleep = vi.fn(async () => undefined);

    await expect(
      submitJobApiRequest(
        "offer-regen",
        { id: "offer-123" },
        {
          config,
          fetchImpl,
          nonce: () => nonces.shift() ?? "nonce_retry_00000003",
          now: () => 1_784_757_000_000,
          requestId: "public-request-123",
          sleep,
        },
      ),
    ).resolves.toEqual(accepted("offer-regen"));

    expect(requests).toHaveLength(2);
    const firstHeaders = new Headers(requests[0]?.init.headers);
    const secondHeaders = new Headers(requests[1]?.init.headers);
    expect(firstHeaders.get("idempotency-key")).toBe(
      secondHeaders.get("idempotency-key"),
    );
    expect(firstHeaders.get("x-api-nonce")).not.toBe(
      secondHeaders.get("x-api-nonce"),
    );
    expect(sleep).toHaveBeenCalledWith(100);

    for (const request of requests) {
      const headers = new Headers(request.init.headers);
      const body = String(request.init.body);
      const expectedSignature = createJobApiSignature({
        keyId: config.keyId,
        secret: config.secret,
        timestamp: headers.get("x-api-timestamp") ?? "",
        nonce: headers.get("x-api-nonce") ?? "",
        method: "POST",
        url: request.url,
        idempotencyKey: headers.get("idempotency-key") ?? undefined,
        body: new TextEncoder().encode(body),
      });
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-api-signature")).toBe(
        `sha256=${expectedSignature}`,
      );
    }
  });

  it("does not retry a non-retryable rejection", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_credentials" }), {
          status: 401,
        }),
    );

    const error = await submitJobApiRequest(
      "item-regen",
      { id: "item-1" },
      {
        config,
        fetchImpl,
        nonce: () => "nonce_failure_000001",
        requestId: "public-request-401",
      },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobApiRequestError);
    expect(error).toMatchObject({ retryable: false, status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("submits every bulk entry with bounded concurrency and distinct duplicate keys", async () => {
    let active = 0;
    let maximumActive = 0;
    let nonceCounter = 0;
    const idempotencyKeys: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      idempotencyKeys.push(
        new Headers(init?.headers).get("idempotency-key") ?? "",
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(JSON.stringify(accepted("item-regen")), {
        status: 202,
      });
    };
    const payloads = [
      { id: "duplicate" },
      { id: "duplicate" },
      { id: "item-2" },
      { id: "item-3" },
    ];

    await expect(
      submitJobApiBatch("item-regen", payloads, {
        concurrency: 2,
        config,
        fetchImpl,
        maxAttempts: 1,
        nonce: () => `nonce_batch_${String(++nonceCounter).padStart(8, "0")}`,
        requestId: "bulk-request-1",
      }),
    ).resolves.toHaveLength(payloads.length);

    expect(maximumActive).toBe(2);
    expect(idempotencyKeys).toHaveLength(payloads.length);
    expect(new Set(idempotencyKeys).size).toBe(payloads.length);
  });

  it("attempts all bulk entries and fails the request if one is not accepted", async () => {
    const seenIds: string[] = [];
    let nonceCounter = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { id: string };
      seenIds.push(payload.id);
      if (payload.id === "bad") {
        return new Response(JSON.stringify({ error: "invalid_input" }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify(accepted("item-regen")), {
        status: 202,
      });
    };

    await expect(
      submitJobApiBatch(
        "item-regen",
        [{ id: "first" }, { id: "bad" }, { id: "last" }],
        {
          concurrency: 2,
          config,
          fetchImpl,
          maxAttempts: 1,
          nonce: () =>
            `nonce_failure_${String(++nonceCounter).padStart(8, "0")}`,
          requestId: "bulk-request-failure",
        },
      ),
    ).rejects.toThrow("1 of 3 job submissions were not durably accepted");
    expect(seenIds.sort()).toEqual(["bad", "first", "last"]);
  });

  it("creates deterministic keys and cryptographically sized nonces", () => {
    const input = {
      jobType: "offer-regen" as const,
      requestId: "request-1",
      itemIndex: 2,
      payload: { id: "offer-1" },
    };
    expect(createJobApiIdempotencyKey(input)).toBe(
      createJobApiIdempotencyKey(input),
    );
    expect(createJobApiNonce()).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  });
});
