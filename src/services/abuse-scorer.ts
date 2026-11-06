import { randomUUID } from "node:crypto";
import { logicalOperations } from "./abuse-operations.js";
import { riskRedisKeys } from "./abuse-version.js";

const WINDOW_MS = 60_000;
const MAX_EVENTS = 128;
const TRAP_TTL_MS = 600_000;

export interface AbuseResource {
  route: string;
  page?: number;
  itemId?: string;
  limit?: number;
  search?: boolean;
  titleHash?: string;
  hydrationId?: string;
  hydrationRoute?: string;
  cacheHit?: boolean;
}

export interface AbuseEvent extends AbuseResource {
  at: number;
  deep: boolean;
  support: boolean;
  resources?: AbuseResource[];
  mismatch: number;
  trap?: boolean;
  method?: string;
}

export interface RiskStore {
  append(
    key: string,
    event: AbuseEvent,
  ): Promise<{ events: AbuseEvent[]; trapped: boolean }>;
  close?(): void;
}

/** Bounded LRU: both feature windows and score entries expire without timers. */
export class ExpiringLru<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private readonly capacity: number,
    private readonly now = Date.now,
  ) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, ttl: number) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    if (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value as string);
  }
}

export interface AbuseAssessment {
  score: number;
  reasons: string[];
}

function resourceKey(resource: AbuseResource, includeFilters = true): string {
  // Catalog resources append a semantic filter hash. Keep it for page breadth;
  // route volume must not reset when filters change. Preserve concrete IDs.
  const route = includeFilters
    ? resource.route
    : resource.route.replace(/:[a-f0-9]{64}$/, "");
  return JSON.stringify([route, resource.itemId ?? resource.hydrationId ?? ""]);
}

export function analyzeEvents(events: AbuseEvent[]): AbuseAssessment {
  // GraphQL finishes asynchronously; completion order is not arrival order.
  events = [...events].sort((a, b) => a.at - b.at);
  if (events.some((event) => event.trap))
    return { score: 1, reasons: ["canary"] };
  const count = events.length;
  if (!count) return { score: 0, reasons: [] };
  const mismatch = Math.max(...events.map((event) => event.mismatch));
  const deep = events.filter((event) => event.deep);
  const resources = deep.flatMap((event) =>
    (event.resources?.length ? event.resources : [event]).map((resource) => ({
      ...resource,
      at: event.at,
    })),
  );
  const distinctPages = new Map<string, Set<number>>();
  for (const resource of resources) {
    if (
      resource.page === undefined ||
      !Number.isSafeInteger(resource.page) ||
      resource.page < 1
    )
      continue;
    const key = resourceKey(resource);
    const seen = distinctPages.get(key) ?? new Set<number>();
    seen.add(resource.page);
    distinctPages.set(key, seen);
  }
  const pageSweep = [...distinctPages.values()].some(
    (pages) => pages.size >= 10,
  );
  // Ten pages must be observable before the legacy twelve-event warm-up ends.
  if (count < 12 && !pageSweep)
    return {
      score: Math.min(0.3, mismatch),
      reasons: mismatch ? ["transport-mismatch"] : [],
    };
  const operations = logicalOperations(events);
  const logicalDeep = operations.filter((event) => event.deep);
  const routeCounts = new Map<string, number>();
  for (const event of logicalDeep) {
    // A batched GraphQL operation counts at most once per resource, even when
    // aliases repeat it. Hydration/typing collapsing has already happened.
    const keys = new Set(
      (event.resources?.length ? event.resources : [event]).map((resource) =>
        resourceKey(resource, false),
      ),
    );
    for (const key of keys)
      routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
  }
  const routeHammering = [...routeCounts.values()].some(
    (count) => count >= 120,
  );
  const support = events.filter((event) => event.support).length;
  const ratio = deep.length / Math.max(1, deep.length + support);
  const gaps = operations
    .slice(1)
    .map((event, i) => Math.max(0, event.at - operations[i].at));
  const mean = gaps.length
    ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
    : 0;
  const variance =
    gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  const regular = gaps.length >= 8 && mean >= 50 && mean < 2000 && cv < 0.15;
  const highVolume = logicalDeep.length >= 60;
  let sequential = 0;
  const pages = new Map<
    string,
    AbuseResource & { at: number; steps: number }
  >();
  for (const event of resources) {
    const previous = pages.get(event.route);
    if (event.page === undefined || event.page === previous?.page) continue;
    let steps = 0;
    if (
      event.page !== undefined &&
      previous?.page !== undefined &&
      event.page === previous.page + 1 &&
      event.at - previous.at < 5000
    )
      steps = previous.steps + 1;
    sequential = Math.max(sequential, steps);
    pages.set(event.route, { ...event, steps });
  }
  const unique = new Set(resources.map((event) => event.itemId).filter(Boolean))
    .size;
  const titleSearches = operations
    .flatMap((event) => (event.deep ? (event.resources ?? []) : []))
    .filter((resource) => resource.search && resource.titleHash);
  const distinctTitles = new Set(
    titleSearches.map((resource) => resource.titleHash),
  ).size;
  const searchTimes = resources
    .filter((resource) => resource.search && resource.titleHash)
    .map((resource) => resource.at);
  const titleSweep =
    distinctTitles >= 18 &&
    distinctTitles / titleSearches.length >= 0.8 &&
    Math.max(...searchTimes) - Math.min(...searchTimes) >= 25000;
  const sweep =
    sequential >= 8 ||
    unique >= 30 ||
    titleSweep ||
    pageSweep ||
    routeHammering;
  const largeSearches = resources.filter(
    (entry) => entry.search && (entry.limit ?? 0) >= 50,
  );
  const largeSearchVolume =
    largeSearches.length >= 20 &&
    largeSearches.reduce((sum, entry) => sum + (entry.limit ?? 0), 0) >= 1500;
  const reasons = [
    ratio >= 0.95 ? "deep-only" : ratio >= 0.8 ? "mostly-deep" : "",
    sequential >= 8 ? "sequential-pages" : "",
    pageSweep ? "page-sweep" : "",
    routeHammering ? "route-hammering" : "",
    unique >= 30 ? "unique-id-sweep" : "",
    titleSweep ? "title-lookup-sweep" : "",
    regular ? "regular-intervals" : "",
    highVolume ? "high-volume" : "",
    largeSearchVolume ? "large-search-volume" : "",
    mismatch ? "transport-mismatch" : "",
  ].filter(Boolean);
  // Deep-only traffic or a common TLS profile alone must never convict.
  const score = Math.min(
    1,
    (sweep || regular || highVolume || largeSearchVolume
      ? ratio >= 0.95
        ? 0.2
        : ratio >= 0.8
          ? 0.1
          : 0
      : 0) +
      (sweep ? 0.45 : 0) +
      (regular ? 0.2 : 0) +
      (highVolume ? 0.2 : 0) +
      (largeSearchVolume ? 0.2 : 0) +
      Math.min(0.15, mismatch),
  );
  return { score, reasons };
}

export function scoreEvents(events: AbuseEvent[]): number {
  return analyzeEvents(events).score;
}

/** Atomic sliding window shared by all instances, with a bounded Redis payload. */
export const APPEND_WINDOW_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local event = cjson.decode(ARGV[1])
-- Use arrival time, not worker processing time (queueing must not manufacture
-- robotic intervals). Clamp future clock skew; hosts should use NTP.
event.at = math.min(event.at, now)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
if event.at > now - 60000 then
  redis.call('ZADD', KEYS[1], event.at, ARGV[2] .. '|' .. cjson.encode(event))
end
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -129)
redis.call('PEXPIRE', KEYS[1], 60000)
if event.trap then redis.call('SET', KEYS[2], '1', 'PX', 600000) end
return {redis.call('ZRANGE', KEYS[1], 0, -1), redis.call('EXISTS', KEYS[2])}
`;

export class RedisRiskStore implements RiskStore {
  constructor(
    private readonly redis: {
      eval(
        script: string,
        keyCount: number,
        ...args: (string | number)[]
      ): Promise<unknown>;
      disconnect(): void;
    },
  ) {}
  async append(key: string, event: AbuseEvent) {
    const [rows, trapped] = (await this.redis.eval(
      APPEND_WINDOW_SCRIPT,
      2,
      ...riskRedisKeys(key),
      JSON.stringify(event),
      randomUUID(),
    )) as [string[], number];
    return {
      events: rows.map(
        (row) => JSON.parse(row.slice(row.indexOf("|") + 1)) as AbuseEvent,
      ),
      trapped: trapped === 1,
    };
  }
  close() {
    this.redis.disconnect();
  }
}

export class AbuseScorer {
  private readonly windows: ExpiringLru<AbuseEvent[]>;
  private readonly risks: ExpiringLru<AbuseAssessment>;
  private readonly traps: ExpiringLru<boolean>;
  private readonly queue: { keys: string[]; event: AbuseEvent }[] = [];
  private running: Promise<void> | undefined;
  private scheduled = false;
  private unavailableUntil = 0;
  private closed = false;
  readonly stats = { dropped: 0, storeErrors: 0, processed: 0 };

  constructor(
    private readonly store?: RiskStore,
    private readonly now = Date.now,
    capacity = 5000,
  ) {
    this.windows = new ExpiringLru(capacity, now);
    this.risks = new ExpiringLru(capacity, now);
    this.traps = new ExpiringLru(capacity, now);
  }

  risk(keys: string[]): number {
    return Math.max(
      0,
      ...keys.map((key) =>
        this.traps.get(key) ? 1 : (this.risks.get(key)?.score ?? 0),
      ),
    );
  }

  reasons(keys: string[]): string[] {
    return [
      ...new Set(
        keys.flatMap((key) =>
          this.traps.get(key)
            ? ["canary"]
            : (this.risks.get(key)?.reasons ?? []),
        ),
      ),
    ];
  }

  trap(keys: string[]) {
    for (const key of keys) this.traps.set(key, true, TRAP_TTL_MS);
  }

  enqueue(keys: string[], event: AbuseEvent): void {
    if (this.closed || keys.length === 0) return;
    if (event.trap) this.trap(keys);
    if (this.queue.length >= 2048) {
      this.stats.dropped++;
      // Preserve trap propagation under telemetry pressure.
      if (!event.trap) return;
      this.queue.pop();
    }
    this.queue.push({ keys, event });
    if (!this.scheduled && !this.running) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        void this.drain();
      });
    }
  }

  private async process(keys: string[], event: AbuseEvent) {
    for (const key of keys) {
      const local = [...(this.windows.get(key) ?? []), event]
        .filter((entry) => entry.at > this.now() - WINDOW_MS)
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_EVENTS);
      this.windows.set(key, local, WINDOW_MS);
      let assessment = analyzeEvents(local);
      if (this.store && this.now() >= this.unavailableUntil) {
        try {
          const shared = await this.store.append(key, event);
          const candidate = shared.trapped
            ? { score: 1, reasons: ["canary"] }
            : analyzeEvents(shared.events);
          if (candidate.score > assessment.score) assessment = candidate;
        } catch {
          this.stats.storeErrors++;
          this.unavailableUntil = this.now() + 5000;
        }
      }
      this.risks.set(key, assessment, WINDOW_MS);
    }
    this.stats.processed++;
  }

  /** Test/shutdown hook; normal requests only enqueue and never await Redis. */
  async drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.queue.length) {
        // Serial per-process ordering keeps local inter-arrival calculations honest.
        const next = this.queue.shift();
        if (next) await this.process(next.keys, next.event);
        if (this.stats.processed % 32 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
    this.store?.close?.();
  }
}
