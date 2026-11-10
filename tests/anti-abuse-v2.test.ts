import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createAntiAbuse,
  extractFingerprint,
  isSupportPath,
} from "../src/middleware/anti-abuse.js";
import { apiCors } from "../src/middlewares/cors.js";
import {
  logicalOperations,
  offerHydrationResource,
} from "../src/services/abuse-operations.js";
import {
  type AbuseEvent,
  AbuseScorer,
  analyzeEvents,
} from "../src/services/abuse-scorer.js";
import {
  normalizedTitleHash,
  searchAbuseResource,
} from "../src/services/abuse-search.js";
import {
  PowSessionService,
  verifyProofOfWork,
} from "../src/services/pow-session.js";

const base = 1800000000000;
const id = (i: number) => i.toString(16).padStart(32, "0");
const headers = {
  accept: "application/json",
  "user-agent": "Chrome/156",
  "sec-ch-ua": "Chromium",
  "sec-fetch-site": "same-site",
  "sec-fetch-mode": "cors",
  "x-egdata-edge-secret": "edge",
  "x-egdata-tls-version": "TLSv1.3",
  "x-egdata-tls-cipher": "AEAD-AES128-GCM-SHA256",
  "x-egdata-asn": "1234",
};
function read(at: number, path: string): AbuseEvent {
  return {
    at,
    route: path,
    deep: !isSupportPath(path),
    support: isSupportPath(path),
    mismatch: 0,
    itemId: /^\/offers\/([a-f0-9]{32})/.exec(path)?.[1],
    ...offerHydrationResource(path, "GET", new URLSearchParams()),
  };
}
function search(at: number, title: string, limit = 12): AbuseEvent {
  const resource = searchAbuseResource({ title }, 1, limit, "DE", "en");
  if (!resource) throw new Error("Invalid search fixture");
  return {
    at,
    route: "/search/v2/search",
    deep: true,
    support: false,
    mismatch: 0,
    method: "POST",
    resources: [resource],
  };
}
const sweep = (count = 18) =>
  Array.from({ length: count }, (_, i) =>
    search(base + Math.floor(i / 2) * 3600 + (i % 2 ? 1000 : 0), `game ${i}`),
  );

describe("v2 fingerprint and CORS continuity", () => {
  it("ignores application headers without sorting remaining header order", () => {
    const fp = (names: string[]) =>
      extractFingerprint(new Request("https://api.test", { headers }), {
        edgeSecret: "edge",
        rawHeaderNames: names,
      });
    const rest = fp(["accept", "user-agent", "sec-ch-ua"]);
    const gql = fp([
      "accept",
      "apollo-require-preflight",
      "user-agent",
      "apollographql-client-name",
      "sec-ch-ua",
      "access-control-request-headers",
    ]);
    expect(gql.fingerprintHash).toBe(rest.fingerprintHash);
    expect(gql.headerOrder).toEqual(["accept", "user-agent", "sec-ch-ua"]);
    expect(fp(["user-agent", "accept", "sec-ch-ua"]).fingerprintHash).not.toBe(
      rest.fingerprintHash,
    );
  });

  it("uses the same HMAC session for REST and GraphQL and never scores OPTIONS", async () => {
    const sessions = new PowSessionService(
      "v2-test-secret-with-at-least-32-bytes",
      () => base,
    );
    const scorer = new AbuseScorer(undefined, () => base);
    const enqueue = vi.spyOn(scorer, "enqueue");
    vi.spyOn(scorer, "risk").mockReturnValue(0.65);
    const fp = extractFingerprint(
      new Request("https://api.test", { headers }),
      { edgeSecret: "edge" },
    ).fingerprintHash;
    const challenge = await sessions.challenge(fp, 0);
    let nonce = 0;
    while (
      !verifyProofOfWork(
        challenge.challenge,
        String(nonce),
        challenge.difficulty,
      )
    )
      nonce++;
    const session = await sessions.redeem(
      challenge.challenge,
      String(nonce),
      fp,
    );
    if (!session) throw new Error("Test proof failed");
    const app = new Hono();
    app.use("*", apiCors());
    app.use(
      "*",
      createAntiAbuse({
        mode: "enforce",
        sessions,
        scorer,
        edgeSecret: "edge",
        now: () => base,
      }).middleware,
    );
    app.get("*", (c) => c.json({ ok: true }));
    for (const path of [`/offers/${id(1)}/price`, "/graphql"]) {
      const response = await app.request(path, {
        headers: {
          ...headers,
          "x-egdata-session": session.token,
          ...(path === "/graphql"
            ? { "apollo-require-preflight": "true" }
            : {}),
        },
      });
      expect(await response.json()).toEqual({ ok: true });
    }
    const calls = enqueue.mock.calls.length;
    const preflight = await app.request("/graphql", {
      method: "OPTIONS",
      headers: {
        origin: "https://egdata.app",
        "access-control-request-method": "GET",
        "access-control-request-headers": "apollo-require-preflight",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-max-age")).toBe("600");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "apollo-require-preflight",
    );
    expect(enqueue.mock.calls).toHaveLength(calls);
    await scorer.drain();
    scorer.close();
  });

  it.each([
    "https://egdata.app",
    "https://preview.egdata.app",
    "https://a.b.egdata.app",
    "http://localhost:5173",
    "https://store.epicgames.com",
  ])("permits configured origin %s", async (origin) => {
    const app = new Hono();
    app.use("*", apiCors());
    app.get("*", (c) => c.text("ok"));
    const response = await app.request("/graphql", {
      method: "OPTIONS",
      headers: { origin },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });
  it.each([
    "https://notegdata.app",
    "https://egdata.app.attacker.test",
    "http://preview.egdata.app",
    "https://egdata.app@attacker.test",
    "https://attacker@egdata.app",
    "https://egdata.app/path",
    "https://preview.egdata.app:444",
    "null",
    "invalid",
  ])("rejects origin %s", async (origin) => {
    const app = new Hono();
    app.use("*", apiCors());
    app.get("*", (c) => c.text("ok"));
    const response = await app.request("/graphql", {
      method: "OPTIONS",
      headers: { origin },
    });
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});

describe("logical offer work", () => {
  it("collapses UI fan-out but retains deep-only as a diagnostic without risk", () => {
    const routes = [
      "price",
      "assets",
      "tops",
      "features",
      "reviews",
      "polls",
      "media",
      "suggestions",
      "hltb",
      "igdb",
      "genres",
      "age-rating",
      "in-bundle",
      "has-regular",
      "price-history",
    ];
    const events = Array.from({ length: 6 }, (_, i) =>
      routes.map((route, j) =>
        read(base + i * 6000 + j * 20, `/offers/${id(i)}/${route}`),
      ),
    ).flat();
    expect(logicalOperations(events)).toHaveLength(6);
    expect(analyzeEvents(events)).toEqual({ score: 0, reasons: ["deep-only"] });
  });
  it("combines REST and both named GraphQL reads for the same offer", () => {
    const events = [
      read(base, `/offers/${id(1)}/price`),
      ...["OfferOnly", "OfferPage"].map((name, i) => ({
        at: base + 100 + i * 100,
        route: "/graphql",
        deep: true,
        support: false,
        mismatch: 0,
        resources: [
          {
            route: "/graphql/Query.offer",
            itemId: id(1),
            hydrationId: id(1),
            hydrationRoute: `graphql:${name}`,
          },
        ],
      })),
    ];
    expect(logicalOperations(events)).toHaveLength(1);
    expect(
      logicalOperations([
        ...events,
        read(base + 1999, `/offers/${id(1)}/assets`),
        read(base + 2000, `/offers/${id(1)}/tops`),
      ]),
    ).toHaveLength(2);
  });
  it("does not hide repeated subroutes, different offers or pagination", () => {
    expect(
      logicalOperations([
        read(base, `/offers/${id(1)}/price`),
        read(base + 1, `/offers/${id(1)}/price`),
        read(base + 2, `/offers/${id(2)}/price`),
      ]),
    ).toHaveLength(3);
    expect(
      offerHydrationResource(
        `/offers/${id(1)}/reviews`,
        "GET",
        new URLSearchParams("page=2"),
      ),
    ).toEqual({});
    expect(
      offerHydrationResource(
        `/offers/${id(1)}/unknown`,
        "GET",
        new URLSearchParams(),
      ),
    ).toEqual({});
  });
  it("never calls simultaneous or sub-50ms bursts regular", () => {
    for (const gap of [0, 49])
      expect(
        analyzeEvents(
          Array.from({ length: 12 }, (_, i) =>
            read(base + gap * i, `/offers/${id(i)}/price`),
          ),
        ).reasons,
      ).not.toContain("regular-intervals");
    expect(
      analyzeEvents(
        Array.from({ length: 12 }, (_, i) =>
          read(base + 50 * i, `/offers/${id(i)}/price`),
        ),
      ).reasons,
    ).toContain("regular-intervals");
  });
  it("requires eight logical intervals even with many raw requests", () => {
    const events = Array.from({ length: 8 }, (_, i) => [
      read(base + i * 1000, `/offers/${id(i)}/price`),
      read(base + i * 1000 + 1, `/offers/${id(i)}/assets`),
    ]).flat();
    expect(analyzeEvents(events).reasons).not.toContain("regular-intervals");
    expect(
      analyzeEvents([...events, read(base + 8000, `/offers/${id(8)}/price`)])
        .reasons,
    ).toContain("regular-intervals");
  });
  it("requires 60 distinct IDs and does not count repeated IDs toward the sweep", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      read(
        base + Math.floor(i / 2) * 1000 + (i % 2) * 100,
        `/offers/${id(i)}/regional-price`,
      ),
    );
    expect(analyzeEvents(events.slice(0, 59)).score).toBe(0);
    const repeated = [
      ...events.slice(0, 59),
      read(events[59].at, `/offers/${id(0)}/regional-price`),
    ];
    expect(analyzeEvents(repeated).reasons).not.toContain("unique-id-sweep");
    expect(analyzeEvents(repeated).score).toBeCloseTo(0.4);
    expect(analyzeEvents(events).reasons).toContain("unique-id-sweep");
    expect(analyzeEvents(events).score).toBeCloseTo(0.85);
  });
  it("keeps the regional-price scraper high risk", () => {
    const events = Array.from({ length: 60 }, (_, i) => ({
      ...read(base + i * 1000, `/offers/${id(i)}/regional-price`),
      mismatch: 0.15,
    }));
    expect(analyzeEvents(events).score).toBe(1);
    expect(analyzeEvents(events).reasons).toEqual(
      expect.arrayContaining([
        "unique-id-sweep",
        "high-volume",
        "regular-intervals",
      ]),
    );
  });
  it.each([
    "/collections/top-sellers",
    "/free-games/mobile",
    "/offers/upcoming",
    "/offers/latest-achievements",
  ])("records browse traffic as support: %s", async (path) => {
    const scorer = new AbuseScorer();
    const enqueue = vi.spyOn(scorer, "enqueue");
    const app = new Hono();
    app.use(
      "*",
      createAntiAbuse({
        mode: "observe",
        scorer,
        sessions: new PowSessionService(
          "v2-test-secret-with-at-least-32-bytes",
        ),
        edgeSecret: "edge",
      }).middleware,
    );
    app.get("*", (c) => c.text("ok"));
    await app.request(path, { headers });
    expect(enqueue.mock.calls[0][1]).toMatchObject({
      deep: false,
      support: true,
    });
    await scorer.drain();
    scorer.close();
  });
});

describe("60-second title sweeps", () => {
  it("normalizes titles without retaining text and ignores short titles", () => {
    expect(normalizedTitleHash("  ＧＡＭＥ   Name ")).toBe(
      normalizedTitleHash("game name"),
    );
    for (const title of ["", "  ", "ab", "ＡＢ", null])
      expect(normalizedTitleHash(title)).toBeUndefined();
    expect(JSON.stringify(search(base, "my private title"))).not.toContain(
      "private",
    );
  });
  it("requires 18 titles, 80 percent uniqueness and 25 seconds", () => {
    expect(analyzeEvents(sweep()).score).toBe(0.65);
    expect(analyzeEvents(sweep(17)).reasons).not.toContain(
      "title-lookup-sweep",
    );
    const atBoundary = sweep().map((e, i) => ({
      ...e,
      at: base + (i * 25000) / 17,
    }));
    expect(analyzeEvents(atBoundary).reasons).toContain("title-lookup-sweep");
    expect(
      analyzeEvents(
        atBoundary.map((e) => ({ ...e, at: base + (e.at - base) * 0.999 })),
      ).reasons,
    ).not.toContain("title-lookup-sweep");
    const enough = [
      ...sweep(),
      ...Array.from({ length: 4 }, (_, i) =>
        search(base + 32000 + i * 1800, "game 0"),
      ),
    ];
    expect(analyzeEvents(enough).reasons).toContain("title-lookup-sweep");
    expect(
      analyzeEvents([...enough, search(base + 40000, "game 0")]).reasons,
    ).not.toContain("title-lookup-sweep");
  });
  it("collapses typing chains using the previous search timestamp, not the chain start", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      search(base + i * 799, `typed ${i}`),
    );
    expect(logicalOperations(events)).toHaveLength(1);
    expect(logicalOperations(events)[0].resources?.[0].titleHash).toBe(
      normalizedTitleHash("typed 59"),
    );
    expect(analyzeEvents(events).score).toBe(0);
    const separated = events.map((e, i) => ({ ...e, at: base + i * 800 }));
    expect(logicalOperations(separated)).toHaveLength(60);
    expect(analyzeEvents(separated).reasons).toContain("title-lookup-sweep");
  });
  it("shares a single sweep weight and preserves occasional desktop lookups", () => {
    const events = sweep(30).map((e, i) => ({
      ...e,
      resources: [
        {
          ...e.resources?.[0],
          itemId: id(i),
          route: "/search/stream",
          page: i + 1,
        },
      ],
    }));
    const result = analyzeEvents(events);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["title-lookup-sweep", "sequential-pages"]),
    );
    expect(result.score).toBe(0.65);
    expect(result.reasons).not.toContain("unique-id-sweep");
    expect(analyzeEvents(sweep(6)).score).toBe(0);
  });
});
