import { describe, expect, it } from "vitest";
import type { AbuseObservation } from "../src/services/abuse-observation.js";
import {
  type CohortUpdate,
  cohortReport,
  PowCohorts,
} from "../src/services/pow-cohorts.js";

const at = Date.parse("2026-11-06T12:00:00Z");
const event = (changes: Partial<AbuseObservation> = {}): AbuseObservation => ({
  at,
  route: "/offers/private-id",
  method: "GET",
  scope: "enforce",
  action: "challenge",
  risk: 0.65,
  reasons: [],
  tracked: true,
  cohortFingerprint: "a".repeat(64),
  ...changes,
});

describe("PoW daily cohorts", () => {
  it("deduplicates parallel challenge responses and proof replays without retaining request identities", async () => {
    const rows: CohortUpdate[] = [];
    const tracker = new PowCohorts({
      write: async (batch) => {
        rows.push(...batch);
      },
    });
    for (let i = 0; i < 20; i++) tracker.record(event({ at: at + i }));
    for (let i = 0; i < 3; i++)
      tracker.record(
        event({
          at: at + 100 + i,
          action: "handshake",
          handshakeOutcome: "accepted",
        }),
      );
    expect(rows).toHaveLength(0); // No store work on the request path.
    await tracker.flush();
    const current = rows.filter((row) => row.day === Math.floor(at / 86400000));
    expect(current).toHaveLength(1);
    expect(
      cohortReport({ [current[0].id]: JSON.stringify(current[0]) }, at + 1000),
    ).toMatchObject({
      challenged: 1,
      solved: 1,
      pending: 0,
      noSolutionObserved: 0,
    });
    expect(JSON.stringify(rows)).not.toContain("a".repeat(64));
    expect(JSON.stringify(rows)).not.toContain("private-id");
  });

  it("separates pending, no puzzle requested, and started but unsolved; accepts late recovery", () => {
    const state = {
      firstChallenge: at,
      lastChallenge: at + 290000,
      lastPuzzle: 0,
      lastSolve: 0,
    };
    const raw = { one: JSON.stringify(state) };
    expect(cohortReport(raw, at + 299999)).toMatchObject({
      pending: 1,
      noSolutionObserved: 0,
    });
    expect(cohortReport(raw, at + 300000)).toMatchObject({
      pending: 0,
      noSolutionObserved: 1,
      noPuzzleRequested: 1,
    });
    state.lastPuzzle = at + 1000;
    expect(
      cohortReport({ one: JSON.stringify(state) }, at + 300000),
    ).toMatchObject({
      noSolutionObserved: 1,
      puzzleRequestedUnsolved: 1,
      noPuzzleRequested: 0,
    });
    state.lastSolve = at + 310000;
    expect(
      cohortReport({ one: JSON.stringify(state) }, at + 320000),
    ).toMatchObject({ solved: 1, noSolutionObserved: 0 });
  });

  it("does not count a proof predating the first challenge, or unsolicited handshakes", () => {
    const raw = {
      one: JSON.stringify({
        firstChallenge: at,
        lastChallenge: at,
        lastPuzzle: at - 100,
        lastSolve: at - 1,
      }),
      two: JSON.stringify({
        firstChallenge: 0,
        lastChallenge: 0,
        lastPuzzle: at,
        lastSolve: at + 1,
      }),
    };
    expect(cohortReport(raw, at + 300000)).toMatchObject({
      challenged: 1,
      solved: 0,
      noPuzzleRequested: 1,
    });
  });

  it("does not reset a day's solved cohort after re-challenges; partitions balance", () => {
    const raw = {
      one: JSON.stringify({
        firstChallenge: at,
        lastChallenge: at + 500000,
        lastPuzzle: at + 1000,
        lastSolve: at + 2000,
      }),
    };
    const report = cohortReport(raw, at + 600000);
    expect(report.solved).toBe(1);
    expect(report.challenged).toBe(
      report.solved + report.pending + report.noSolutionObserved,
    );
  });

  it("excludes observe mode, trials, normal responses, tarpit and untrusted fingerprints", async () => {
    const rows: CohortUpdate[] = [];
    const tracker = new PowCohorts({
      write: async (batch) => {
        rows.push(...batch);
      },
    });
    tracker.record(event({ scope: "observe" }));
    tracker.record(event({ scope: "trial" }));
    tracker.record(event({ action: "serve" }));
    tracker.record(event({ action: "tarpit" }));
    tracker.record(event({ cohortFingerprint: undefined }));
    tracker.record(event({ cohortFingerprint: "invalid" }));
    tracker.record(event({ action: "handshake", handshakeOutcome: "invalid" }));
    await tracker.flush();
    expect(rows).toHaveLength(0);
    expect(tracker.stats.untracked).toBe(2);
    expect(cohortReport({})).toMatchObject({
      firstObservedAt: null,
      challenged: 0,
    });
  });

  it("bounds in-process state and tolerates telemetry outages", async () => {
    const tracker = new PowCohorts({
      write: async (batch) => {
        expect(batch).toHaveLength(2048);
        throw Error("Redis unavailable");
      },
    });
    for (let i = 0; i < 2050; i++)
      tracker.record(
        event({ cohortFingerprint: i.toString(16).padStart(64, "0") }),
      );
    await expect(tracker.flush()).resolves.toBeUndefined();
    expect(tracker.stats).toMatchObject({ dropped: 2, storeErrors: 1 });
  });
});
