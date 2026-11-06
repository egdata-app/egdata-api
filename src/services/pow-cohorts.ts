import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { AbuseObservation } from "./abuse-observation.js";

const DAY_MS = 86_400_000;
export const COHORT_WAIT_MS = 300_000;
export const COHORT_LIMIT = 10_000;
export const COHORT_PREFIX = "egdata:abuse:pow-cohorts:v1:";

export interface CohortState {
  firstChallenge: number;
  lastChallenge: number;
  lastPuzzle: number;
  lastSolve: number;
}
export interface CohortUpdate extends CohortState {
  day: number;
  id: string;
}
export interface CohortStore {
  write(rows: CohortUpdate[]): Promise<void>;
}

// Timestamp min/max merges are idempotent and tolerate out-of-order flushes
// from multiple API replicas. No raw fingerprint, IP, UA, token or URL is stored.
export const COHORT_SCRIPT = `
local rows = cjson.decode(ARGV[1])
for _, row in ipairs(rows) do
  local raw = redis.call('HGET', KEYS[1], row.id)
  if not raw and tonumber(redis.call('HGET', KEYS[1], '__count') or '0') >= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], '__capacityReached', '1')
  else
    local state = raw and cjson.decode(raw) or {firstChallenge=0,lastChallenge=0,lastPuzzle=0,lastSolve=0}
    if row.firstChallenge > 0 and (state.firstChallenge == 0 or row.firstChallenge < state.firstChallenge) then
      state.firstChallenge = row.firstChallenge
    end
    for _, field in ipairs({'lastChallenge','lastPuzzle','lastSolve'}) do
      state[field] = math.max(state[field], row[field])
    end
    redis.call('HSET', KEYS[1], row.id, cjson.encode(state))
    if not raw then redis.call('HINCRBY', KEYS[1], '__count', 1) end
    local at = math.max(row.lastChallenge, row.lastPuzzle, row.lastSolve)
    local first = tonumber(redis.call('HGET', KEYS[1], '__firstObservedAt') or '0')
    if first == 0 or at < first then redis.call('HSET', KEYS[1], '__firstObservedAt', at) end
    local last = tonumber(redis.call('HGET', KEYS[1], '__lastObservedAt') or '0')
    redis.call('HSET', KEYS[1], '__lastObservedAt', math.max(last, at))
  end
end
redis.call('EXPIREAT', KEYS[1], ARGV[2])
return 1
`;

export class RedisCohortStore implements CohortStore {
  constructor(private readonly redis: Pick<Redis, "eval">) {}
  async write(rows: CohortUpdate[]) {
    const days = new Map<number, CohortUpdate[]>();
    for (const row of rows) {
      const group = days.get(row.day) ?? [];
      group.push(row);
      days.set(row.day, group);
    }
    for (const [day, group] of days) {
      // Small atomic batches avoid long Lua stalls in shared Redis.
      for (let offset = 0; offset < group.length; offset += 128) {
        await this.redis.eval(
          COHORT_SCRIPT,
          1,
          `${COHORT_PREFIX}${day}`,
          JSON.stringify(group.slice(offset, offset + 128)),
          (day + 2) * 86400,
          COHORT_LIMIT,
        );
      }
    }
  }
}

/** Enforce-only cohort funnel; never changes scoring or request admission. */
export class PowCohorts {
  private pending = new Map<string, CohortUpdate>();
  readonly stats = { dropped: 0, untracked: 0, storeErrors: 0 };
  constructor(private readonly store: CohortStore) {}

  record(o: AbuseObservation) {
    if (o.scope !== "enforce") return;
    const challenge = o.action === "challenge";
    const puzzle =
      o.handshakeOutcome === "issued" || o.handshakeOutcome === "replaced";
    const solve = o.handshakeOutcome === "accepted";
    if (!challenge && !puzzle && !solve) return;
    if (!o.cohortFingerprint || !/^[a-f0-9]{64}$/.test(o.cohortFingerprint)) {
      this.stats.untracked++;
      return;
    }
    const current = Math.floor(o.at / DAY_MS);
    // A handshake after midnight can resolve yesterday's challenged cohort.
    for (const day of challenge ? [current] : [current, current - 1]) {
      const id = createHash("sha256")
        .update(`pow-cohort:${day}:${o.cohortFingerprint}`)
        .digest("hex");
      const key = `${day}:${id}`;
      let row = this.pending.get(key);
      if (!row) {
        if (this.pending.size >= 2048) {
          this.stats.dropped++;
          continue;
        }
        row = {
          day,
          id,
          firstChallenge: 0,
          lastChallenge: 0,
          lastPuzzle: 0,
          lastSolve: 0,
        };
        this.pending.set(key, row);
      }
      if (challenge) {
        row.firstChallenge = row.firstChallenge
          ? Math.min(row.firstChallenge, o.at)
          : o.at;
        row.lastChallenge = Math.max(row.lastChallenge, o.at);
      }
      if (puzzle) row.lastPuzzle = Math.max(row.lastPuzzle, o.at);
      if (solve) row.lastSolve = Math.max(row.lastSolve, o.at);
    }
  }

  async flush() {
    const rows = [...this.pending.values()];
    this.pending.clear();
    if (!rows.length) return;
    try {
      await this.store.write(rows);
    } catch {
      this.stats.storeErrors++;
    }
  }
}

export function cohortReport(raw: Record<string, string>, now = Date.now()) {
  let challenged = 0,
    solved = 0,
    pending = 0,
    noSolutionObserved = 0;
  let noPuzzleRequested = 0,
    puzzleRequestedUnsolved = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (id.startsWith("__")) continue;
    const state = JSON.parse(value) as CohortState;
    if (!state.firstChallenge) continue;
    challenged++;
    if (state.lastSolve >= state.firstChallenge) solved++;
    else if (now - state.firstChallenge < COHORT_WAIT_MS) pending++;
    else {
      noSolutionObserved++;
      if (state.lastPuzzle >= state.firstChallenge) puzzleRequestedUnsolved++;
      else noPuzzleRequested++;
    }
  }
  return {
    challenged,
    solved,
    pending,
    noSolutionObserved,
    noPuzzleRequested,
    puzzleRequestedUnsolved,
    waitingPeriodSeconds: COHORT_WAIT_MS / 1000,
    firstObservedAt: raw.__firstObservedAt
      ? new Date(Number(raw.__firstObservedAt)).toISOString()
      : null,
    lastObservedAt: raw.__lastObservedAt
      ? new Date(Number(raw.__lastObservedAt)).toISOString()
      : null,
    capacityReached: raw.__capacityReached === "1",
    limitations:
      "Daily trusted fingerprint cohorts, not unique clients or people. Solved means at least one accepted proof after the day's first challenge; later re-challenges do not undo it. No solution observed after five minutes does not prove deliberate ignoring. Fingerprint sharing/changes, missing edge trust, dropped telemetry and disconnects limit attribution. Enforce only; no historical backfill or scoped trials. Handshakes on the following UTC day can update a retained cohort; storage expires at the end of that following day.",
  };
}
