import { randomUUID } from "node:crypto";

const WINDOW_MS = 60_000;
const MAX_EVENTS = 128;
const TRAP_TTL_MS = 600_000;

export interface AbuseEvent {
  at: number;
  deep: boolean;
  support: boolean;
  route: string;
  page?: number;
  itemId?: string;
  mismatch: number;
  trap?: boolean;
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

export function scoreEvents(events: AbuseEvent[]): number {
  if (events.some((event) => event.trap)) return 1;
  const count = events.length;
  if (!count) return 0;
  const mismatch = Math.max(...events.map((event) => event.mismatch));
  if (count < 12) return Math.min(0.3, mismatch);
  const deep = events.filter((event) => event.deep);
  const support = events.filter((event) => event.support).length;
  const ratio = deep.length / Math.max(1, deep.length + support);
  const gaps = events
    .slice(1)
    .map((event, i) => Math.max(0, event.at - events[i].at));
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const variance =
    gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  let sequential = 0;
  const pages = new Map<string, AbuseEvent>();
  for (const event of deep) {
    const previous = pages.get(event.route);
    if (
      event.page !== undefined &&
      previous?.page !== undefined &&
      event.page === previous.page + 1 &&
      event.at - previous.at < 2000
    )
      sequential++;
    if (event.page !== undefined) pages.set(event.route, event);
  }
  const unique = new Set(deep.map((event) => event.itemId).filter(Boolean))
    .size;
  const sweep = sequential >= 8 || unique >= 30;
  // Deep-only traffic or a common TLS profile alone must never convict.
  return Math.min(
    1,
    (ratio >= 0.95 ? 0.2 : ratio >= 0.8 ? 0.1 : 0) +
      (sweep ? 0.45 : 0) +
      (cv < 0.15 && mean < 2000 ? 0.2 : 0) +
      (deep.length >= 60 ? 0.2 : 0) +
      Math.min(0.15, mismatch),
  );
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
      `egdata:abuse:{${key}}:events`,
      `egdata:abuse:{${key}}:trap`,
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
  private readonly risks: ExpiringLru<number>;
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
        this.traps.get(key) ? 1 : (this.risks.get(key) ?? 0),
      ),
    );
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
      const local = [
        ...(this.windows.get(key) ?? []).filter(
          (entry) => entry.at > this.now() - WINDOW_MS,
        ),
        event,
      ].slice(-MAX_EVENTS);
      this.windows.set(key, local, WINDOW_MS);
      let score = scoreEvents(local);
      if (this.store && this.now() >= this.unavailableUntil) {
        try {
          const shared = await this.store.append(key, event);
          score = Math.max(
            score,
            shared.trapped ? 1 : scoreEvents(shared.events),
          );
        } catch {
          this.stats.storeErrors++;
          this.unavailableUntil = this.now() + 5000;
        }
      }
      this.risks.set(key, score, WINDOW_MS);
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
