import type { Redis } from "ioredis";
import { ABUSE_VERSION } from "./abuse-version.js";

export const TRIAL_KEY = `egdata:abuse:trial:v${ABUSE_VERSION}`;
export interface AbuseTrial {
  id: string;
  createdAt: number;
  expiresAt: number;
  fingerprints: string[];
  route: "offer-details" | "catalog-search";
}

export function parseTrial(
  raw: string | null,
  now = Date.now(),
): AbuseTrial | undefined {
  if (!raw || raw.length > 4096) return;
  try {
    const t = JSON.parse(raw) as AbuseTrial;
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(t.id) ||
      !Number.isSafeInteger(t.createdAt) ||
      !Number.isSafeInteger(t.expiresAt) ||
      t.createdAt > now ||
      t.expiresAt <= now ||
      t.expiresAt - t.createdAt > 900000 ||
      t.expiresAt <= t.createdAt
    )
      return;
    if (
      !["offer-details", "catalog-search"].includes(t.route) ||
      !Array.isArray(t.fingerprints) ||
      t.fingerprints.length < 1 ||
      t.fingerprints.length > 10 ||
      !t.fingerprints.every((f) => /^[a-f0-9]{64}$/.test(f))
    )
      return;
    return t;
  } catch {
    return;
  }
}

/** Operator-only Redis switch. No request can enable a trial. Errors fail back
 * to observe; a deleted switch is picked up within two seconds. */
export class AbuseTrialController {
  private current: AbuseTrial | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private closed = false;
  constructor(
    private readonly redis: Pick<Redis, "get">,
    private readonly now = Date.now,
  ) {}
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const value = await this.redis.get(TRIAL_KEY);
      if (!this.closed) this.current = parseTrial(value, this.now());
    } catch {
      this.current = undefined;
    } finally {
      this.polling = false;
    }
  }
  start() {
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, 2000);
    this.timer.unref();
  }
  matches(fingerprint: string, path: string, method: string): boolean {
    const t = this.current;
    if (
      !t ||
      t.expiresAt <= this.now() ||
      !t.fingerprints.includes(fingerprint)
    )
      return false;
    return t.route === "offer-details"
      ? method === "GET" && /^\/offers\/[a-f0-9]{32}$/.test(path)
      : ["GET", "POST"].includes(method) && path === "/search/v2/search";
  }
  close() {
    this.closed = true;
    this.current = undefined;
    if (this.timer) clearInterval(this.timer);
  }
}
