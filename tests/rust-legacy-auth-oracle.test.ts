import { afterAll, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";

// Requests exercise authentication failures, validation and read-only successes. External
// services must remain unreachable for these inputs; an unexpected call fails the test.
const external = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("unexpected external call");
  }),
);
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: () => ({
        findOne: external,
        insertOne: external,
        updateOne: external,
        deleteOne: external,
      }),
    },
  },
}));
vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: external,
    set: external,
    del: external,
    disconnect: () => {},
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: external, set: external },
  disconnectResponseCache: () => {},
}));
vi.mock("../src/utils/auth.js", () => ({
  getLinkedEpicSession: async () => null,
  auth: { api: { getSession: async () => null } },
}));
vi.mock("satori", () => ({ default: external }));

it("compares private account routes through the full Node and Rust HTTP stacks", async () => {
  vi.stubGlobal("fetch", external);
  vi.stubEnv("VAPID_PUBLIC_KEY", "");
  const { app } = await import("../src/index.js");
  type Req = {
    method: string;
    path: string;
    rawBody?: string;
    headers?: Record<string, string>;
  };
  const cases = [];
  const specs: Record<string, string[]> = {
    GET: [
      "/auth",
      "/auth/refresh",
      "/auth/v2/refresh",
      "/auth/logout",
      "/auth/discord/link",
      "/auth/discord/callback",
      "/offers/demo/ownership",
      "/offers/demo/reviews/permissions",
      "/accounts",
      "/users",
      "/users/discord",
      "/users/check-epic",
      "/users-service",
      "/push/subscribe",
      "/push/subscriptions",
      "/push/subscriptions/demo",
      "/push/vapid-public-key",
      "/push/topics/stats",
      "/launcher/sandbox/demo",
      "/launcher/sandbox/demo/items",
      "/launcher/sandbox/demo/offers",
      "/admin",
    ],
    POST: [
      "/auth/avatar",
      "/auth/persist",
      "/auth/v2/persist",
      "/auth/v2/validate-state",
      "/donate/key/invalid",
      "/offers/demo/reviews",
      "/users/find-or-create",
      "/users/discord",
      "/users-service/playtime",
      "/users-service/ownership",
      "/push/subscribe",
      "/push/topics/subscribe",
      "/push/topics/unsubscribe",
      "/push/send",
      "/push/send-to-user",
      "/admin/offers",
    ],
    PATCH: [
      "/auth/refresh",
      "/auth/refresh-admin",
      "/offers/demo/reviews",
      "/admin/offers",
    ],
    DELETE: ["/offers/demo/reviews", "/users/epic", "/push/unsubscribe/demo"],
    PUT: ["/users/epic"],
  };
  for (const [method, paths] of Object.entries(specs)) {
    for (const path of paths) {
      const request: Req = { method, path };
      if (method !== "GET") {
        request.rawBody = "{}";
        request.headers = { "content-type": "application/json" };
      }
      const response = await app.request(path, {
        method,
        headers: request.headers,
        body: request.rawBody,
      });
      expect(external).not.toHaveBeenCalled();
      cases.push({
        name: "legacy auth " + method + " " + path,
        request,
        trace: [],
        response: await captureResponse(response),
      });
    }
  }
  for (const origin of [
    "https://egdata.app",
    "http://localhost:3000",
    "https://example.invalid",
  ]) {
    const request = {
      method: "OPTIONS",
      path: "/auth",
      headers: { origin, "access-control-request-method": "GET" },
    };
    const response = await app.request(request.path, request);
    const additionalHeaders = Object.fromEntries(
      [
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-max-age",
        "vary",
      ].map((k) => [k, response.headers.get(k)]),
    );
    cases.push({
      name: "legacy auth preflight " + origin,
      request,
      trace: [],
      response: await captureResponse(response),
      additionalHeaders,
    });
  }
  assertOracle("legacy-auth-http-node", cases);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const { server } = await import("../src/graphql/index.js");
  await server.stop();
});
