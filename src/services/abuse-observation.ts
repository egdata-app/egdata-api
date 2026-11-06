import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Redis } from "ioredis";
import { ABUSE_VERSION } from "./abuse-version.js";

export interface AbuseObservation {
  at: number;
  route: string;
  method: string;
  scope: "observe" | "enforce" | "trial";
  action: "serve" | "challenge" | "tarpit" | "handshake";
  risk: number;
  reasons: string[];
  tracked: boolean;
  /** Decision under enforcement, also evaluated in observe mode. */
  decision?: "serve" | "challenge" | "tarpit";
  sessionValid?: boolean;
  handshakeOutcome?:
    | "issued"
    | "accepted"
    | "replaced"
    | "invalid"
    | "disabled";
}

const POW_COUNTERS = [
  "observedResponses",
  "challengeRequired",
  "challengeRequested",
  "puzzlesIssued",
  "proofsSubmitted",
  "proofsAccepted",
  "proofsRejected",
  "puzzlesReplaced",
  "invalidHandshakeRequests",
  "disabledHandshakeRequests",
  "passedWithSession",
  "wouldChallenge",
  "wouldTarpit",
] as const;

/** Stable zero-filled report; coverage distinguishes old buckets from no activity. */
export function powCounters(totals: Record<string, number>) {
  return Object.fromEntries(
    POW_COUNTERS.map((name) => [name, totals[`pow:${name}`] ?? 0]),
  ) as Record<(typeof POW_COUNTERS)[number], number>;
}
export interface SummaryRow {
  minute: number;
  values: Record<string, number>;
}
export interface SummaryStore {
  write(rows: SummaryRow[]): Promise<void>;
}
export const SUMMARY_PREFIX = `egdata:abuse:summary:v${ABUSE_VERSION}:`;
export const SUMMARY_TTL_SECONDS = 86400;

// The dedupe field makes a retried Redis command safe; expiry is fixed to the
// bucket boundary, so late writes cannot extend retention indefinitely.
export const SUMMARY_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
local values = cjson.decode(ARGV[2])
for field, value in pairs(values) do redis.call('HINCRBY', KEYS[1], field, value) end
redis.call('HSET', KEYS[1], ARGV[1], 1)
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
`;

export class RedisSummaryStore implements SummaryStore {
  constructor(private readonly redis: Pick<Redis, "eval">) {}
  async write(rows: SummaryRow[]) {
    const batch = `__batch:${randomUUID()}`;
    for (const row of rows)
      await this.redis.eval(
        SUMMARY_SCRIPT,
        1,
        `${SUMMARY_PREFIX}${row.minute}`,
        batch,
        JSON.stringify(row.values),
        row.minute * 60 + 60 + SUMMARY_TTL_SECONDS,
      );
  }
}

/** Fixed low-cardinality labels: never record URLs, search terms, IPs or tokens. */
export function observationRoute(path: string): string {
  if (
    path === "/auth/challenge" ||
    path === "/search/v2/search" ||
    path === "/graphql"
  )
    return path;
  if (/^\/offers\/[^/]+$/.test(path)) return "/offers/{id}";
  if (path.startsWith("/offers/")) return "/offers/{id}/*";
  if (/^\/sandboxes\/[^/]+\/offers$/.test(path))
    return "/sandboxes/{id}/offers";
  const root = path.split("/")[1];
  return [
    "offers",
    "items",
    "sellers",
    "sales",
    "active-sales",
    "search",
    "featured",
    "countries",
    "regions",
    "tags",
    "builds",
    "sandboxes",
    "free-games",
    "collections",
    "franchises",
    "promotions",
    "multisearch",
    "catalog",
    "changelist",
    "game-awards",
  ].includes(root)
    ? `/${root}`
    : "/other";
}

export class AbuseObservations {
  private pending = new Map<number, Record<string, number>>();
  private fields = 0;
  private flushing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly stats = { dropped: 0, storeErrors: 0 };
  constructor(
    private readonly store: SummaryStore,
    private readonly now = Date.now,
  ) {}

  start() {
    this.timer = setInterval(() => {
      void this.flush();
    }, 5000);
    this.timer.unref();
  }
  increment(name: string, value = 1, at = this.now()) {
    const minute = Math.floor(at / 60000);
    if (minute < Math.floor(this.now() / 60000) - 1439) return;
    const row = this.pending.get(minute) ?? {};
    if (!(name in row)) {
      if (
        this.fields >= 4096 ||
        (!this.pending.has(minute) && this.pending.size >= 4)
      ) {
        this.stats.dropped++;
        return;
      }
      this.fields++;
    }
    row[name] = (row[name] ?? 0) + value;
    this.pending.set(minute, row);
  }
  record(
    o: AbuseObservation,
    status: number,
    bytes: number,
    complete: boolean,
  ) {
    const method = ["GET", "POST", "HEAD"].includes(o.method)
      ? o.method
      : "OTHER";
    const label = `${o.scope}|${observationRoute(o.route)}|${method}|${o.action}`;
    const add = (name: string, value = 1) =>
      this.increment(`${label}|${name}`, value, o.at);
    add("requests");
    add("bodyBytes", bytes);
    add(`status:${Math.floor(status / 100)}xx`);
    add(`risk:${Math.min(10, Math.max(0, Math.floor(o.risk * 10)))}`);
    add(
      `riskBand:${o.risk > 0.8 ? "high" : o.risk > 0.5 ? "suspicious" : "clean"}`,
    );
    add(complete ? "complete" : "incomplete");
    if (!o.tracked) add("untracked");
    if (o.decision || o.handshakeOutcome) {
      add("pow:observedResponses");
      if (o.action === "challenge") add("pow:challengeRequired");
      if (o.action === "serve" && o.sessionValid) add("pow:passedWithSession");
      if (o.scope === "observe" && o.action === "serve") {
        if (o.decision === "challenge") add("pow:wouldChallenge");
        if (o.decision === "tarpit") add("pow:wouldTarpit");
      }
      switch (o.handshakeOutcome) {
        case "issued":
          add("pow:challengeRequested");
          add("pow:puzzlesIssued");
          break;
        case "accepted":
          add("pow:proofsSubmitted");
          add("pow:proofsAccepted");
          break;
        case "replaced":
          add("pow:proofsSubmitted");
          add("pow:proofsRejected");
          add("pow:puzzlesIssued");
          add("pow:puzzlesReplaced");
          break;
        case "invalid":
          add("pow:invalidHandshakeRequests");
          break;
        case "disabled":
          add("pow:disabledHandshakeRequests");
          break;
      }
    }
    for (const reason of new Set(o.reasons))
      if (
        [
          "canary",
          "deep-only",
          "mostly-deep",
          "sequential-pages",
          "page-sweep",
          "route-hammering",
          "unique-id-sweep",
          "title-lookup-sweep",
          "regular-intervals",
          "high-volume",
          "large-search-volume",
          "transport-mismatch",
        ].includes(reason)
      )
        add(`reason:${reason}`);
  }
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.pending.size) return;
    const rows = [...this.pending].map(([minute, values]) => ({
      minute,
      values,
    }));
    this.pending.clear();
    this.fields = 0;
    this.flushing = this.store
      .write(rows)
      .catch(() => {
        this.stats.storeErrors++;
      })
      .finally(() => {
        this.flushing = undefined;
      });
    await this.flushing;
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.flushing;
    await this.flush();
  }
}

/** Register OUTSIDE compression: counts encoded response-body bytes as consumed.
 * This is an origin-body metric, not billable TCP/TLS bytes or cache-hit traffic. */
export function observeAbuseResponses(
  observations: AbuseObservations,
): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const record = c.get("antiAbuseObservation");
    if (!record) return;
    const response = c.res;
    if (!response.body || c.req.method === "HEAD") {
      observations.record(record, response.status, 0, true);
      return;
    }
    const reader = response.body.getReader();
    let bytes = 0,
      finished = false;
    const finish = (complete: boolean) => {
      if (!finished) {
        finished = true;
        observations.record(record, response.status, bytes, complete);
      }
    };
    c.res = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              finish(true);
              controller.close();
              reader.releaseLock();
            } else {
              bytes += chunk.value.byteLength;
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            finish(false);
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish(false);
          await reader.cancel(reason);
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}

declare module "hono" {
  interface ContextVariableMap {
    antiAbuseObservation: AbuseObservation;
  }
}
