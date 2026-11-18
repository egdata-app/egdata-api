import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createAntiAbuse } from "../src/middleware/anti-abuse.js";
import { AbuseScorer } from "../src/services/abuse-scorer.js";
import { PowSessionService } from "../src/services/pow-session.js";
import { createAntiAbuseRuntime } from "../src/services/anti-abuse-runtime.js";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";

it("compares the challenge response, cache policy and lifetime across modes", async () => {
  const now = () => 1700000000000;
  const enabled = createAntiAbuse({
    mode: "enforce",
    scorer: new AbuseScorer(undefined, now),
    sessions: new PowSessionService(
      "fixture-only-secret-for-handshake-comparison",
      now,
    ),
    now,
  });
  const cases = [];
  vi.stubEnv("ANTI_ABUSE_MODE", "off");
  try {
    for (const [mode, data, expected] of [
      ["off", "{}", 503],
      ["enforce", "{", 400],
      ["enforce", "{}", 200],
    ] as const) {
      const anti = mode === "off" ? createAntiAbuseRuntime() : enabled;
      const app = new Hono();
      app.use("*", anti.middleware);
      app.post("/auth/challenge", anti.challenge);
      const request = {
        path: "/auth/challenge",
        method: "POST",
        rawBody: data,
      };
      const response = await captureResponse(
        await app.request(request.path, { method: request.method, body: data }),
      );
      expect(response.status).toBe(expected);
      if (expected === 200) {
        expect(response.body.challenge).toEqual(expect.any(String));
        expect(response.body.challenge.length).toBeGreaterThan(32);
        response.body.challenge = "<issued challenge>";
        response.body.expiresAt -= now();
      }
      cases.push({ name: mode + " " + expected, mode, request, response });
    }
    const app = new Hono();
    const off = createAntiAbuseRuntime();
    app.use("*", off.middleware);
    app.post("/auth/challenge", off.challenge);
    app.use("*", responseEtag, routeTemplate, edgeCacheHeaders);
    for (const method of ["GET", "HEAD"]) {
      const request = { path: "/auth/challenge", method };
      const response = await captureResponse(
        await app.request(request.path, { method }),
      );
      expect(response.status).toBe(404);
      cases.push({
        name: method + " fallback",
        mode: "off",
        request,
        response,
      });
    }
    assertOracle("legacy-challenge-http-node", cases);
  } finally {
    vi.unstubAllEnvs();
  }
});
