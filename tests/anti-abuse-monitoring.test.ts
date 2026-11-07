import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAntiAbuse,
  extractFingerprint,
} from "../src/middleware/anti-abuse.js";
import {
  AbuseObservations,
  observeAbuseResponses,
  powCounters,
  type SummaryRow,
} from "../src/services/abuse-observation.js";
import { AbuseScorer } from "../src/services/abuse-scorer.js";
import { type CohortUpdate, PowCohorts } from "../src/services/pow-cohorts.js";
import { PowSessionService } from "../src/services/pow-session.js";

const headers = {
  "x-egdata-edge-secret": "edge",
  "x-egdata-tls-cipher": "AEAD-AES128-GCM-SHA256",
  "x-egdata-tls-version": "TLSv1.3",
  "x-egdata-asn": "1234",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function harness(
  mode: "observe" | "enforce" | "off" = "enforce",
  trial = false,
) {
  let clock = 1800000000000;
  let risk = 0;
  const rows: SummaryRow[] = [];
  const cohortRows: CohortUpdate[] = [];
  const cohorts = new PowCohorts({
    write: async (batch) => {
      cohortRows.push(...batch);
    },
  });
  const observations = new AbuseObservations(
    {
      write: async (batch) => {
        rows.push(...batch);
      },
    },
    () => clock,
    cohorts,
  );
  const scorer = new AbuseScorer(undefined, () => clock);
  cleanup.push(() => scorer.close());
  vi.spyOn(scorer, "risk").mockImplementation(() => risk);
  const sessions = new PowSessionService(
    "monitoring-only-test-secret-at-least-32-bytes",
    () => clock,
  );
  const anti = createAntiAbuse({
    mode,
    scorer,
    sessions,
    now: () => clock,
    edgeSecret: "edge",
    delay: async () => {},
    trial: { matches: () => trial },
  });
  const app = new Hono();
  app.use("*", observeAbuseResponses(observations));
  app.use("*", anti.middleware);
  app.post("/auth/challenge", anti.challenge);
  app.get("*", (c) => c.json({ normal: true }));
  async function request(
    path = "/items/secret-id",
    body?: unknown,
    token?: string,
  ) {
    const response = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...headers,
        ...(token ? { "x-egdata-session": token } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const json = response.status === 204 ? null : await response.json();
    await observations.flush();
    return { response, json };
  }
  async function validSession() {
    const fp = extractFingerprint(
      new Request("https://api.test/items", { headers }),
      { edgeSecret: "edge" },
    ).fingerprintHash;
    const challenge = await sessions.challenge(fp, 0);
    const result = await sessions.redeem(
      challenge.challenge,
      solve(challenge.challenge),
      fp,
    );
    if (!result) throw new Error("Test proof failed");
    return result.token;
  }
  function totals() {
    const sum: Record<string, number> = {};
    for (const row of rows)
      for (const [key, value] of Object.entries(row.values)) {
        const metric = key.split("|").at(-1) ?? key;
        sum[metric] = (sum[metric] ?? 0) + value;
      }
    return powCounters(sum);
  }
  return {
    request,
    validSession,
    totals,
    rows,
    cohortRows,
    setRisk: (value: number) => {
      risk = value;
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function solve(challenge: string) {
  for (let nonce = 0; ; nonce++) {
    const digest = createHash("sha256")
      .update(`${challenge}:${nonce}`)
      .digest();
    if (digest[0] === 0 && digest[1] === 0) return String(nonce);
  }
}

describe("server-side PoW monitoring", () => {
  it("counts real issuance, accepted proof replay, and passed sessions without storing secrets", async () => {
    const h = harness();
    const { json: puzzle } = await h.request("/auth/challenge", {});
    const proof = {
      challenge: puzzle.challenge,
      nonce: solve(puzzle.challenge),
    };
    const { json: session } = await h.request("/auth/challenge", proof);
    await h.request("/auth/challenge", proof);
    await h.request("/items/secret-id", undefined, session.token);
    expect(h.totals()).toMatchObject({
      observedResponses: 4,
      challengeRequested: 1,
      puzzlesIssued: 1,
      proofsSubmitted: 2,
      proofsAccepted: 2,
      proofsRejected: 0,
      passedWithSession: 1,
    });
    const summary = JSON.stringify(h.rows);
    for (const secret of [
      puzzle.challenge,
      session.token,
      "secret-id",
      "fingerprintHash",
      "sessionId",
    ])
      expect(summary).not.toContain(secret);
  });

  it("separates malformed requests from rejected proofs and replacement puzzles", async () => {
    const h = harness();
    const { json: puzzle } = await h.request("/auth/challenge", {});
    expect(
      (
        await h.request("/auth/challenge", {
          challenge: puzzle.challenge,
          nonce: "!",
        })
      ).json,
    ).toHaveProperty("challenge");
    expect(
      (await h.request("/auth/challenge", { challenge: 42, nonce: "0" }))
        .response.status,
    ).toBe(400);
    expect((await h.request("/auth/challenge", "{")).response.status).toBe(400);
    expect(h.totals()).toMatchObject({
      challengeRequested: 1,
      puzzlesIssued: 2,
      proofsSubmitted: 1,
      proofsRejected: 1,
      puzzlesReplaced: 1,
      invalidHandshakeRequests: 2,
    });
  });

  it("records an expired valid proof as rejected, never accepted", async () => {
    const h = harness();
    const { json: puzzle } = await h.request("/auth/challenge", {});
    const nonce = solve(puzzle.challenge);
    h.tick(60_000);
    await h.request("/auth/challenge", { challenge: puzzle.challenge, nonce });
    expect(h.totals()).toMatchObject({
      proofsAccepted: 0,
      proofsRejected: 1,
      puzzlesReplaced: 1,
      puzzlesIssued: 2,
    });
  });

  it.each([
    "observe",
    "enforce",
  ] as const)("uses the same session-expiry decisions in %s", async (mode) => {
    const h = harness(mode);
    const token = await h.validSession();
    h.setRisk(0.65);
    expect((await h.request(undefined, undefined, token)).json.normal).toBe(
      true,
    );
    h.tick(30_000);
    const result = await h.request(undefined, undefined, token);
    expect(
      mode === "observe" ? result.json.normal : result.json.error.code,
    ).toBe(mode === "observe" ? true : "SESSION_CHALLENGE_REQUIRED");
    expect(h.totals()).toMatchObject({
      challengeRequired: mode === "enforce" ? 1 : 0,
      wouldChallenge: mode === "observe" ? 1 : 0,
      passedWithSession: mode === "observe" ? 2 : 1,
    });
  });

  it("does not label clean clients, high risk, or support routes as would-challenge", async () => {
    const h = harness("observe");
    h.setRisk(0.5);
    await h.request();
    h.setRisk(0.65);
    await h.request();
    h.setRisk(0.9);
    await h.request();
    await h.request("/countries");
    expect(h.totals()).toMatchObject({
      observedResponses: 4,
      challengeRequired: 0,
      wouldChallenge: 1,
      wouldTarpit: 1,
    });
  });

  it("records scoped-trial challenges as actual challenges, not observe skips", async () => {
    const h = harness("observe", true);
    h.setRisk(0.65);
    await h.request();
    expect(h.totals()).toMatchObject({
      challengeRequired: 1,
      wouldChallenge: 0,
    });
    expect(Object.keys(h.rows[0].values)).toContain(
      "trial|/items|GET|challenge|pow:challengeRequired",
    );
  });

  it("counts request challenge envelopes separately from handshake attempts", async () => {
    const h = harness();
    h.setRisk(0.65);
    await Promise.all(Array.from({ length: 20 }, () => h.request()));
    expect(h.totals()).toMatchObject({
      challengeRequired: 20,
      challengeRequested: 0,
      proofsSubmitted: 0,
    });
    expect(new Set(h.cohortRows.map((row) => row.id)).size).toBe(1);
    expect(h.cohortRows.some((row) => row.firstChallenge > 0)).toBe(true);
  });

  it("correlates an enforced challenge with a real verified proof across REST/handshake", async () => {
    const h = harness();
    h.setRisk(0.65);
    await h.request();
    const challenged = h.cohortRows.find((row) => row.firstChallenge > 0);
    if (!challenged) throw new Error("Expected a recorded challenge cohort");
    h.setRisk(0); // Real 16-bit proof avoids expensive test-only 20-bit solves.
    const { json: puzzle } = await h.request("/auth/challenge", {});
    await h.request("/auth/challenge", {
      challenge: puzzle.challenge,
      nonce: solve(puzzle.challenge),
    });
    expect(
      h.cohortRows.some((row) => row.id === challenged.id && row.lastSolve > 0),
    ).toBe(true);
  });

  it("does not count a tarpitted valid session as admitted", async () => {
    const h = harness();
    const token = await h.validSession();
    h.setRisk(0.9);
    const result = await h.request(undefined, undefined, token);
    expect(result.response.status).toBe(204);
    expect(result.json).toBeNull();
    expect(
      h.rows.some((row) =>
        Object.entries(row.values).some(
          ([key, value]) => key.endsWith("|tarpit|bodyBytes") && value === 0,
        ),
      ),
    ).toBe(true);
    expect(h.totals()).toMatchObject({
      passedWithSession: 0,
      challengeRequired: 0,
      wouldChallenge: 0,
    });
  });

  it("distinguishes no telemetry coverage from legacy counts", () => {
    expect(powCounters({ requests: 123, "riskBand:suspicious": 20 })).toEqual(
      powCounters({}),
    );
    expect(powCounters({}).observedResponses).toBe(0);
  });
});
