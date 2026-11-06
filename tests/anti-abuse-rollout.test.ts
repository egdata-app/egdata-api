import { Hono } from "hono";
import { compress } from "hono/compress";
import { describe, expect, it, vi } from "vitest";
import {
  createAntiAbuse,
  extractFingerprint,
} from "../src/middleware/anti-abuse.js";
import {
  AbuseObservations,
  observeAbuseResponses,
  type SummaryRow,
} from "../src/services/abuse-observation.js";
import {
  type AbuseEvent,
  AbuseScorer,
  analyzeEvents,
} from "../src/services/abuse-scorer.js";
import { searchAbuseResource } from "../src/services/abuse-search.js";
import {
  AbuseTrialController,
  parseTrial,
} from "../src/services/abuse-trial.js";
import { PowSessionService } from "../src/services/pow-session.js";

const base = 1800000000000;
const headers = {
  "x-egdata-edge-secret": "edge",
  "x-egdata-tls-cipher": "AEAD-AES128-GCM-SHA256",
  "x-egdata-tls-version": "TLSv1.3",
  "x-egdata-asn": "1234",
  "user-agent": "Desktop/1",
};

describe("catalog traversal", () => {
  it("groups semantic search filters across key order, pagination and tracking noise without storing terms", () => {
    const a = searchAbuseResource(
      { title: "private search", tags: ["a", "b"], page: 1 },
      1,
      50,
      "US",
      "en",
    );
    const b = searchAbuseResource(
      { tags: ["b", "a"], title: "private search", cachebuster: "x" },
      2,
      50,
      "US",
      "en",
    );
    expect(a?.route).toBe(b?.route);
    expect(JSON.stringify(a)).not.toContain("private search");
    expect(
      searchAbuseResource({ title: "another" }, 3, 50, "US", "en")?.route,
    ).not.toBe(a?.route);
  });

  it.each([
    "GET",
    "POST",
  ])("records %s catalog search sweeps across rotating IPs/UAs", async (method) => {
    let now = base;
    const scorer = new AbuseScorer(undefined, () => now);
    const app = new Hono();
    app.use(
      "*",
      createAntiAbuse({
        mode: "observe",
        scorer,
        sessions: new PowSessionService("test-secret-with-more-than-32-bytes"),
        edgeSecret: "edge",
        now: () => now,
      }).middleware,
    );
    app.all("/search/v2/search", async (c) => {
      const q = method === "POST" ? await c.req.json() : c.req.query();
      const resource = searchAbuseResource(
        { title: q.title },
        Number(q.page),
        50,
        "US",
        "en",
      );
      if (resource) c.get("antiAbuseCatalog")?.(resource);
      return c.json({ elements: [] });
    });
    const fp = extractFingerprint(
      new Request("https://api.test", { headers }),
      { edgeSecret: "edge" },
    ).fingerprintHash;
    for (let page = 1; page <= 20; page++) {
      const q = { title: "game", page };
      await app.request(
        method === "GET"
          ? `/search/v2/search?title=game&page=${page}&noise=${page}`
          : "/search/v2/search",
        {
          method,
          headers: {
            ...headers,
            "cf-connecting-ip": `192.0.2.${page}`,
            "user-agent": `Client/${page}`,
            ...(method === "POST"
              ? { "content-type": "application/json" }
              : {}),
          },
          ...(method === "POST" ? { body: JSON.stringify(q) } : {}),
        },
      );
      now += 2250;
      await scorer.drain();
    }
    expect(scorer.risk([`fp:${fp}`])).toBeGreaterThan(0.5);
    expect(scorer.reasons([`fp:${fp}`])).toContain("sequential-pages");
    scorer.close();
  });

  it("detects the 1600/hour sandbox traversal while allowing occasional pages and unrelated searches", () => {
    const events: AbuseEvent[] = Array.from({ length: 24 }, (_, i) => ({
      at: base + i * 2250,
      deep: true,
      support: false,
      route: "/sandboxes/fn/offers",
      page: i + 1,
      mismatch: 0,
    }));
    expect(analyzeEvents(events).score).toBeGreaterThan(0.5);
    expect(analyzeEvents(events.slice(0, 6)).score).toBe(0);
    const unrelated = events.map((event, i) => {
      const resource = searchAbuseResource(
        { title: `term-${i}` },
        i + 1,
        10,
        "US",
        "en",
      );
      if (!resource) throw new Error("Invalid test feature");
      return {
        ...event,
        route: "/search/v2/search",
        page: undefined,
        resources: [resource],
      };
    });
    expect(analyzeEvents(unrelated).score).toBeLessThanOrEqual(0.5);
    const shortRuns = events.map((event, i) => ({
      ...event,
      route: `/query-${Math.floor(i / 4)}`,
      page: (i % 4) + 1,
    }));
    expect(analyzeEvents(shortRuns).reasons).not.toContain("sequential-pages");
    expect(analyzeEvents(shortRuns).score).toBeLessThanOrEqual(0.5);
    expect(
      analyzeEvents(events.map((e) => ({ ...e, page: 1 }))).score,
    ).toBeLessThanOrEqual(0.5);
  });

  it("requires combined evidence for repeated large searches, not a single large result set", () => {
    const resource = searchAbuseResource({}, 1, 100, "US", "en");
    if (!resource) throw new Error("Invalid test feature");
    const events: AbuseEvent[] = Array.from({ length: 20 }, (_, i) => ({
      at: base + i * 500,
      route: "/search/v2/search",
      deep: true,
      support: false,
      mismatch: 0,
      resources: [resource],
    }));
    expect(analyzeEvents(events.slice(0, 1)).score).toBe(0);
    expect(analyzeEvents(events).reasons).toContain("large-search-volume");
    expect(analyzeEvents(events).score).toBeGreaterThan(0.5);
    expect(
      analyzeEvents(
        events.map((event, i) => ({ ...event, at: base + i * i * 100 })),
      ).score,
    ).toBeLessThanOrEqual(0.5);
  });
});

describe("bounded observation summaries", () => {
  it("counts encoded bytes without changing compressed bodies, headers, or caching", async () => {
    const rows: SummaryRow[] = [];
    const observations = new AbuseObservations({
      write: async (batch) => {
        rows.push(...batch);
      },
    });
    const app = new Hono();
    app.use("*", observeAbuseResponses(observations));
    app.use("*", compress({ threshold: 0 }));
    app.get("*", (c) => {
      c.set("antiAbuseObservation", {
        at: Date.now(),
        route: "/sandboxes/fn/offers",
        method: "GET",
        scope: "observe",
        action: "serve",
        risk: 0.65,
        reasons: ["sequential-pages"],
        tracked: true,
      });
      c.header("Cache-Control", "public, max-age=60");
      return c.text("repeatable catalog data".repeat(500));
    });
    const response = await app.request("/sandboxes/fn/offers", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("cache-control")).toContain("public");
    const encoded = new Uint8Array(await response.arrayBuffer());
    expect(encoded.byteLength).toBeLessThan(500);
    const decoded = await new Response(
      new Blob([encoded]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(decoded).toBe("repeatable catalog data".repeat(500));
    await observations.flush();
    expect(
      Object.entries(rows[0].values).find(([key]) =>
        key.endsWith("|bodyBytes"),
      )?.[1],
    ).toBe(encoded.byteLength);
    expect(
      Object.keys(rows[0].values).some((key) =>
        key.includes("/sandboxes/{id}/offers"),
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("/fn/");
  });

  it("does not await a blocked store and bounds pending cardinality", async () => {
    let release: (() => void) | undefined;
    const observations = new AbuseObservations({
      write: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    observations.increment("requests");
    const flushing = observations.flush();
    for (let i = 0; i < 5000; i++) observations.increment(`bounded-test:${i}`);
    expect(observations.stats.dropped).toBe(904);
    release?.();
    await flushing;
  });

  it("counts cancellations and telemetry failures without breaking the response", async () => {
    const write = vi.fn().mockRejectedValue(new Error("offline"));
    const observations = new AbuseObservations({ write });
    observations.record(
      {
        at: Date.now(),
        route: "/offers/private-id",
        method: "GET",
        scope: "trial",
        action: "challenge",
        risk: 0.6,
        reasons: [],
        tracked: true,
      },
      200,
      123,
      false,
    );
    await observations.flush();
    expect(observations.stats.storeErrors).toBe(1);
    expect(
      write.mock.calls[0][0][0].values[
        "trial|/offers/{id}|GET|challenge|incomplete"
      ],
    ).toBe(1);
  });
});

describe("expiring production trial", () => {
  it("only enforces the selected trusted fingerprint and path, then rolls back on expiry/deletion/error", async () => {
    let now = base;
    const fp = extractFingerprint(
      new Request("https://api.test", { headers }),
      { edgeSecret: "edge" },
    ).fingerprintHash;
    let raw: string | null = JSON.stringify({
      id: "test",
      createdAt: now,
      expiresAt: now + 60000,
      fingerprints: [fp],
      route: "offer-details",
    });
    const get = vi.fn(async () => raw);
    const trial = new AbuseTrialController({ get } as never, () => now);
    const scorer = new AbuseScorer();
    vi.spyOn(scorer, "risk").mockReturnValue(0.6);
    const app = new Hono();
    app.use(
      "*",
      createAntiAbuse({
        mode: "observe",
        trial,
        scorer,
        sessions: new PowSessionService("test-secret-with-more-than-32-bytes"),
        edgeSecret: "edge",
        now: () => now,
      }).middleware,
    );
    app.get("*", (c) => c.json({ normal: true }));
    const path = `/offers/${"a".repeat(32)}`;
    await trial.poll();
    expect(
      (await (await app.request(path, { headers })).json()).error.code,
    ).toBe("SESSION_CHALLENGE_REQUIRED");
    expect(
      (await (await app.request("/items/game", { headers })).json()).normal,
    ).toBe(true);
    expect(
      (
        await (
          await app.request(path, {
            headers: { ...headers, "x-egdata-asn": "other" },
          })
        ).json()
      ).normal,
    ).toBe(true);
    expect(
      (
        await (
          await app.request(path, {
            headers: { ...headers, "x-egdata-edge-secret": "forged" },
          })
        ).json()
      ).normal,
    ).toBe(true);
    now += 60001;
    expect((await (await app.request(path, { headers })).json()).normal).toBe(
      true,
    );
    now = base;
    raw = null;
    await trial.poll();
    expect(trial.matches(fp, path, "GET")).toBe(false);
    get.mockRejectedValueOnce(new Error("offline"));
    await trial.poll();
    expect(trial.matches(fp, path, "GET")).toBe(false);
    trial.close();
    scorer.close();
  });
  it("rejects broad, malformed or long-running trial configurations", () => {
    const trial = {
      id: "trial",
      createdAt: base,
      expiresAt: base + 60000,
      fingerprints: ["a".repeat(64)],
      route: "offer-details",
    };
    expect(parseTrial(JSON.stringify(trial), base)).toBeTruthy();
    for (const patch of [
      { route: "*" },
      { fingerprints: ["*"] },
      { fingerprints: [] },
      { expiresAt: base + 900001 },
      { createdAt: base + 1 },
    ])
      expect(
        parseTrial(JSON.stringify({ ...trial, ...patch }), base),
      ).toBeUndefined();
  });
});
