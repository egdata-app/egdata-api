import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalToken = process.env.V1_WORKER_TOKEN;
const originalRequired = process.env.V1_WORKER_AUTH_REQUIRED;

afterEach(() => {
  if (originalToken === undefined) delete process.env.V1_WORKER_TOKEN;
  else process.env.V1_WORKER_TOKEN = originalToken;
  if (originalRequired === undefined) delete process.env.V1_WORKER_AUTH_REQUIRED;
  else process.env.V1_WORKER_AUTH_REQUIRED = originalRequired;
});

async function importRouter() {
  vi.resetModules();
  const { default: v1Router } = await import("../src/v1/router.js");
  return new Hono().route("/v1", v1Router);
}

describe("v1 origin Worker provenance", () => {
  it("requires the Worker token on any VM hostname when configured", async () => {
    process.env.V1_WORKER_TOKEN = "worker-token-that-is-long-enough";
    process.env.V1_WORKER_AUTH_REQUIRED = "true";
    const app = await importRouter();
    const headers = {
      "x-egdata-key-id": "key_provenance_1",
      "x-egdata-key-tier": "free",
    };

    const missing = await app.request("https://origin-api.egdata.app/v1/countries", {
      headers,
    });
    expect(missing.status).toBe(403);
    expect((await missing.json()).code).toBe("UNTRUSTED_WORKER");

    const wrong = await app.request("https://api-gcp.egdata.app/v1/countries", {
      headers: { ...headers, "x-egdata-worker-token": "wrong" },
    });
    expect(wrong.status).toBe(403);

    const accepted = await app.request("https://some-other-vm.example/v1/countries", {
      headers: {
        ...headers,
        "x-egdata-worker-token": "worker-token-that-is-long-enough",
        "x-egdata-request-id": "req_from_worker_123",
      },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("x-request-id")).toBe("req_from_worker_123");
  });

  it("fails closed when provenance is required but the origin has no token", async () => {
    delete process.env.V1_WORKER_TOKEN;
    process.env.V1_WORKER_AUTH_REQUIRED = "true";
    const app = await importRouter();
    const response = await app.request("https://unknown-vm.example/v1/countries", {
      headers: {
        "x-egdata-key-id": "key_provenance_1",
        "x-egdata-key-tier": "free",
      },
    });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("WORKER_AUTH_NOT_CONFIGURED");
  });
});
