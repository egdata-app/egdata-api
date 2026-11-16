import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import v1Router from "../src/v1/router.js";
import {
  clearSsrTelemetryBufferForTesting,
  flushSsrTelemetry,
  getSsrTelemetryBufferForTesting,
  recordSsrTelemetryHit,
} from "../src/v1/ssr-telemetry.js";

const app = new Hono().route("/v1", v1Router);

const keyHeaders = {
  "x-egdata-key-id": "key_test_router_1",
  "x-egdata-key-tier": "free",
};

describe("versioned v1 origin router", () => {
  it("exposes countries and regions in the data/meta envelope", async () => {
    const countries = await app.request("/v1/countries", {
      headers: keyHeaders,
    });
    expect(countries.status).toBe(200);
    expect(countries.headers.get("content-type")).toContain("application/json");
    expect(countries.headers.get("cache-control")).toBe("private, no-cache");
    expect(countries.headers.get("cdn-cache-control")).toBe("no-store");
    expect(countries.headers.get("x-request-id")).toMatch(/^req_/);
    const body = await countries.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toContain("US");
    expect(body.meta.count).toBe(body.data.length);

    const regions = await app.request("/v1/regions", { headers: keyHeaders });
    expect(regions.status).toBe(200);
    const regionBody = await regions.json();
    expect(regionBody.data.US.currencyCode).toBe("USD");
  });

  it("resolves an explicit country without cookies and returns 400 for unknown codes", async () => {
    const gb = await app.request("/v1/region?country=GB", {
      headers: { ...keyHeaders, Cookie: "EGDATA_COUNTRY=DE" },
    });
    expect(gb.status).toBe(200);
    expect((await gb.json()).data.region.code).toBe("GB");

    const unknown = await app.request("/v1/region?country=ZZ", {
      headers: keyHeaders,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    const problem = await unknown.json();
    expect(problem.code).toBe("INVALID_COUNTRY");
    expect(problem.requestId).toMatch(/^req_/);
    expect(problem.instance).toBe("/v1/region");
  });

  it("rejects unknown query parameters and unknown paths with Problem Details", async () => {
    const unknownQuery = await app.request("/v1/countries?page=2", {
      headers: keyHeaders,
    });
    expect(unknownQuery.status).toBe(400);
    expect((await unknownQuery.json()).code).toBe("INVALID_QUERY");

    const unknownPath = await app.request("/v1/not-real", {
      headers: keyHeaders,
    });
    expect(unknownPath.status).toBe(404);
    expect((await unknownPath.json()).code).toBe("NOT_FOUND");
  });

  it("returns 405 with Allow for unsupported methods", async () => {
    const response = await app.request("/v1/countries", {
      method: "POST",
      headers: keyHeaders,
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
    expect((await response.json()).code).toBe("METHOD_NOT_ALLOWED");
  });

  it("requires trusted key context for data operations", async () => {
    const response = await app.request("/v1/countries");
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("MISSING_KEY_CONTEXT");

    const invalidPrefix = await app.request("/v1/countries", {
      headers: {
        "x-egdata-key-id": "other_12345",
        "x-egdata-key-tier": "free",
      },
    });
    expect(invalidPrefix.status).toBe(401);
    expect((await invalidPrefix.json()).code).toBe("MISSING_KEY_CONTEXT");

    const consoleSession = await app.request("/v1/countries", {
      headers: {
        "x-egdata-key-id": "console_prj_a",
        "x-egdata-key-tier": "free",
        "x-egdata-key-project": "prj_a",
      },
    });
    expect(consoleSession.status).toBe(200);
  });

  it("treats health and the OpenAPI document as public", async () => {
    const document = await app.request("/v1/open-api.json");
    expect(document.status).toBe(200);
    const body = await document.json();
    expect(body.openapi).toBe("3.0.3");
    expect(body.paths["/v1/countries"]).toBeDefined();

    const health = await app.request("/v1/health");
    expect([200, 503]).toContain(health.status);
    const healthBody = await health.json();
    expect(healthBody.data.services).toBeDefined();
  });

  it("revalidates conditional requests while still returning Problem Details for missing identity", async () => {
    const first = await app.request("/v1/countries", { headers: keyHeaders });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const conditional = await app.request("/v1/countries", {
      headers: { ...keyHeaders, "If-None-Match": etag ?? "" },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");

    const unauthenticated = await app.request("/v1/countries", {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(unauthenticated.status).toBe(401);
  });

  it("supports HEAD without a body", async () => {
    const response = await app.request("/v1/countries", {
      method: "HEAD",
      headers: keyHeaders,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("answers CORS preflights without key context", async () => {
    const response = await app.request("/v1/countries", {
      method: "OPTIONS",
      headers: { Origin: "https://customer.example" },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://customer.example",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-API-Key",
    );
  });

  it("normalizes a read-only POST search into a bodyless 303 GET redirect", async () => {
    const response = await app.request("/v1/search", {
      method: "POST",
      headers: { ...keyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Hades",
        tags: ["b", "a"],
        limit: 5,
        price: { min: 100, max: 5000 },
      }),
    });
    expect(response.status).toBe(303);
    expect(await response.text()).toBe("");
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("https://api.egdata.app/v1/search?")).toBe(true);
    const params = new URLSearchParams(location.split("?")[1]);
    expect(params.get("title")).toBe("Hades");
    expect(params.get("tags")).toBe("a,b");
    expect(params.get("limit")).toBe("5");
    expect(params.get("priceMin")).toBe("100");
    expect(params.get("priceMax")).toBe("5000");
    expect(params.get("country")).toBe("US");
    expect(params.get("locale")).toBe("en-US");

    const wrongType = await app.request("/v1/search", {
      method: "POST",
      headers: { ...keyHeaders, "Content-Type": "text/plain" },
      body: "Hades",
    });
    expect(wrongType.status).toBe(415);

    const unknownField = await app.request("/v1/search", {
      method: "POST",
      headers: { ...keyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hades", page: 2 }),
    });
    expect(unknownField.status).toBe(400);
  });

  it("records telemetry in ring buffer for key_egdata_web_ssr and flushes batch to internal telemetry", async () => {
    clearSsrTelemetryBufferForTesting();
    process.env.ORIGIN_AUTH_TOKEN = "test-worker-token";
    process.env.DEVS_TELEMETRY_URL =
      "https://devs.egdata.app/_internal/telemetry";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ingested: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ssrHeaders = {
      "x-egdata-key-id": "key_egdata_web_ssr",
      "x-egdata-key-tier": "enterprise",
      "x-egdata-key-project": "prj_egdata_web",
      "x-egdata-worker-token": "test-worker-token",
    };

    const res = await app.request("/v1/countries", {
      headers: ssrHeaders,
    });
    expect(res.status).toBe(200);

    const buffer = getSsrTelemetryBufferForTesting();
    expect(buffer.length).toBe(1);
    expect(buffer[0]).toMatchObject({
      keyId: "key_egdata_web_ssr",
      projectId: "prj_egdata_web",
      tier: "enterprise",
      routeTemplate: "/v1/countries",
      operationId: "listCountries",
      method: "GET",
      statusCode: 200,
      cacheStatus: "SSR_DIRECT",
      limitOutcome: "allowed",
      policyFamily: "ssr",
    });

    await flushSsrTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://devs.egdata.app/_internal/telemetry",
    );
    const sentHeaders = fetchMock.mock.calls[0][1].headers;
    expect(sentHeaders.Authorization).toBe("Bearer test-worker-token");
    expect(sentHeaders["x-egdata-worker-token"]).toBe("test-worker-token");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.events).toHaveLength(1);
    expect(sentBody.events[0].keyId).toBe("key_egdata_web_ssr");

    // Buffer is drained after flush
    expect(getSsrTelemetryBufferForTesting().length).toBe(0);

    vi.unstubAllGlobals();
    clearSsrTelemetryBufferForTesting();
  });

  it("restores telemetry events to the buffer when flush fails and sends them on retry", async () => {
    clearSsrTelemetryBufferForTesting();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let callCount = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => {
      callCount++;
      if (callCount === 1) {
        // First attempt returns HTTP 503
        return new Response(JSON.stringify({ error: "Service Unavailable" }), {
          status: 503,
        });
      }
      if (callCount === 2) {
        // Second attempt throws network error
        throw new Error("Network timeout");
      }
      // Subsequent attempts succeed
      return new Response(JSON.stringify({ ok: true, ingested: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ssrHeaders = {
      "x-egdata-key-id": "key_egdata_web_ssr",
      "x-egdata-key-tier": "enterprise",
      "x-egdata-key-project": "prj_egdata_web",
      "x-egdata-worker-token": "test-worker-token",
    };

    // Record request 1
    const res = await app.request("/v1/countries", {
      headers: ssrHeaders,
    });
    expect(res.status).toBe(200);
    expect(getSsrTelemetryBufferForTesting()).toHaveLength(1);

    // First flush fails with 503
    await flushSsrTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Events must be restored to the ring buffer
    expect(getSsrTelemetryBufferForTesting()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[v1 SSR Telemetry] Failed to flush batch: HTTP 503",
    );

    // Second flush throws network error
    await flushSsrTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Events must still be preserved in the ring buffer
    expect(getSsrTelemetryBufferForTesting()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[v1 SSR Telemetry] Network flush error",
      expect.any(Error),
    );

    // Verify bounded capacity behavior on restore (never exceeds 2000)
    for (let i = 0; i < 2005; i++) {
      recordSsrTelemetryHit({
        requestId: `req_${i}`,
        keyId: "key_egdata_web_ssr",
        projectId: "prj_egdata_web",
        tier: "enterprise",
        routeTemplate: "/v1/countries",
        operationId: "listCountries",
        method: "GET",
        statusCode: 200,
        cacheStatus: "SSR_DIRECT",
        limitOutcome: "allowed",
        policyFamily: "ssr",
        errorCode: "",
        country: "US",
        latencyMs: 10,
        upstreamMs: 10,
        responseBytes: 100,
        timestamp: Date.now(),
      });
    }
    expect(getSsrTelemetryBufferForTesting().length).toBe(2000);

    // Test concurrent flushes deduplication
    const flush1 = flushSsrTelemetry();
    const flush2 = flushSsrTelemetry();
    await Promise.all([flush1, flush2]);
    // Only one new fetch call should have occurred (total 3 calls)
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Buffer is fully drained after successful flush
    expect(getSsrTelemetryBufferForTesting()).toHaveLength(0);

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    clearSsrTelemetryBufferForTesting();
  });
});
