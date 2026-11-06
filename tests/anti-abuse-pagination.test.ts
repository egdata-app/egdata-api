import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createAntiAbuse,
  extractFingerprint,
} from "../src/middleware/anti-abuse.js";
import {
  AbuseObservations,
  type SummaryRow,
} from "../src/services/abuse-observation.js";
import { offerHydrationResource } from "../src/services/abuse-operations.js";
import {
  type AbuseEvent,
  type AbuseResource,
  AbuseScorer,
  analyzeEvents,
} from "../src/services/abuse-scorer.js";
import { searchAbuseResource } from "../src/services/abuse-search.js";
import { PowSessionService } from "../src/services/pow-session.js";

const base = 1800000000000;
const path = "/sandboxes/fn/offers";
function pageEvent(
  page: number,
  i: number,
  title = "",
  sandbox = "fn",
): AbuseEvent & { resources: AbuseResource[] } {
  const resource = searchAbuseResource({ title }, page, 100, sandbox, "en");
  if (!resource) throw new Error("Invalid pagination fixture");
  return {
    at: base + i * 10,
    route: `/sandboxes/${sandbox}/offers`,
    deep: true,
    support: false,
    mismatch: 0,
    method: "GET",
    resources: [
      {
        ...resource,
        route: `/sandboxes/${sandbox}/offers:${resource.route.split(":")[1]}`,
        search: false,
      },
    ],
  };
}
const shuffled = [1, 8, 3, 10, 5, 2, 9, 4, 7, 6];

describe("unordered pagination and route hammering", () => {
  it("detects exactly ten distinct pages before the old twelve-event warm-up", () => {
    const events = shuffled.map((page, i) => pageEvent(page, i));
    expect(analyzeEvents(events.slice(0, 9)).score).toBe(0);
    expect(analyzeEvents(events)).toEqual({
      score: 0.65,
      reasons: ["deep-only", "page-sweep"],
    });
    expect(analyzeEvents([...events].reverse())).toEqual(analyzeEvents(events));
    expect(
      analyzeEvents(events.map((e) => ({ ...e, at: base }))).reasons,
    ).toContain("page-sweep");
  });

  it("does not combine unrelated filters, sandboxes or GraphQL resource IDs", () => {
    for (const dimension of ["filters", "sandbox", "id"]) {
      const events = Array.from({ length: 18 }, (_, i) => {
        const group = String(Math.floor(i / 9));
        const event = pageEvent(
          9 - (i % 9),
          i,
          dimension === "filters" ? group : "",
          dimension === "sandbox" ? group : "fn",
        );
        if (dimension === "id")
          event.resources = [
            { route: "/graphql/Query.offer", itemId: group, page: 9 - (i % 9) },
          ];
        return event;
      });
      expect(analyzeEvents(events).score).toBe(0);
    }
  });

  it("ignores duplicate and invalid pages for breadth", () => {
    const events = Array.from({ length: 18 }, (_, i) =>
      pageEvent(9 - (i % 9), i),
    );
    for (const page of [
      undefined,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const extra = pageEvent(1, events.length);
      extra.resources[0].page = page;
      expect(analyzeEvents([...events, extra]).reasons).not.toContain(
        "page-sweep",
      );
    }
  });

  it("promotes 120 repeated logical requests but not 119, sharing the sweep cap", () => {
    const events = Array.from({ length: 120 }, (_, i) => pageEvent(1, i));
    expect(analyzeEvents(events.slice(0, 119)).score).toBe(0.4);
    expect(analyzeEvents(events).score).toBeCloseTo(0.85);
    expect(analyzeEvents(events).reasons).toContain("route-hammering");
    const pages = events.map((_e, i) => pageEvent(i + 1, i));
    expect(analyzeEvents(pages).reasons).toEqual(
      expect.arrayContaining([
        "page-sweep",
        "route-hammering",
        "sequential-pages",
      ]),
    );
    expect(analyzeEvents(pages).score).toBeCloseTo(0.85);
  });

  it("does not reset route volume on filter changes or multiply GraphQL aliases", () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      pageEvent(1, i, `filter-${i}`),
    );
    expect(analyzeEvents(events).reasons).toContain("route-hammering");
    const aliases = events.slice(0, 60).map((e) => ({
      ...e,
      resources: Array.from({ length: 32 }, () => ({
        route: "/graphql/Query.offer",
        itemId: "same-offer",
      })),
    }));
    expect(analyzeEvents(aliases).reasons).not.toContain("route-hammering");
    const ids = events.map((e, i) => ({
      ...e,
      resources: [{ route: "/graphql/Query.offer", itemId: String(i % 2) }],
    }));
    expect(analyzeEvents(ids).reasons).not.toContain("route-hammering");
  });

  it("keeps normal pagination and 120 hydration subrequests below the threshold", () => {
    expect(
      analyzeEvents(
        shuffled
          .slice(0, 8)
          .map((p, i) => ({ ...pageEvent(p, i), at: base + i * 7000 })),
      ).score,
    ).toBe(0);
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
    const events = Array.from({ length: 8 }, (_, i) =>
      routes.map((route, j) => {
        const path = `/offers/${i.toString(16).padStart(32, "0")}/${route}`;
        return {
          at: base + i * 6000 + j * 10,
          route: path,
          deep: true,
          support: false,
          mismatch: 0,
          ...offerHydrationResource(path, "GET", new URLSearchParams()),
        };
      }),
    ).flat();
    expect(events).toHaveLength(120);
    expect(analyzeEvents(events).score).toBe(0);
  });

  it("detects count-then-concurrent-pages with only the last 128 events retained", async () => {
    let now = base;
    const scorer = new AbuseScorer(undefined, () => now);
    try {
      for (let i = 0; i < 1300; i++) {
        // Groups of ten reordered pages; initial page is 1, subsequent batch is queued.
        const page = Math.floor(i / 10) * 10 + shuffled[i % 10];
        now = base + (i ? 500 : 0) + Math.floor(i / 40) * 1000 + (i % 40) * 5;
        scorer.enqueue(["fp:python"], { ...pageEvent(page, i), at: now });
        await scorer.drain();
      }
      expect(scorer.risk(["fp:python"])).toBeCloseTo(0.85);
      expect(scorer.reasons(["fp:python"])).toEqual(
        expect.arrayContaining(["page-sweep", "route-hammering"]),
      );
      now += 60000;
      scorer.enqueue(["fp:python"], { ...pageEvent(1, 0), at: now });
      await scorer.drain();
      expect(scorer.risk(["fp:python"])).toBe(0);
    } finally {
      scorer.close();
    }
  });

  it("leaves observe-mode responses cacheable above 0.8 and records both reasons", async () => {
    let now = base;
    const scorer = new AbuseScorer(undefined, () => now);
    const headers = {
      "user-agent": "Python/3.12 aiohttp/3.14.4",
      "x-egdata-edge-secret": "edge",
      "x-egdata-tls-version": "TLSv1.3",
      "x-egdata-tls-cipher": "AEAD-AES128-GCM-SHA256",
      "x-egdata-asn": "49334",
    };
    const fp = extractFingerprint(
      new Request("https://api.test", { headers }),
      { edgeSecret: "edge" },
    ).fingerprintHash;
    const rows: SummaryRow[] = [];
    const observations = new AbuseObservations(
      {
        write: async (batch) => {
          rows.push(...batch);
        },
      },
      () => now,
    );
    const app = new Hono();
    app.use(
      "*",
      createAntiAbuse({
        mode: "observe",
        scorer,
        edgeSecret: "edge",
        now: () => now,
        sessions: new PowSessionService(
          "test-secret-with-more-than-32-bytes",
          () => now,
        ),
      }).middleware,
    );
    app.get(path, (c) => {
      const event = pageEvent(Number(c.req.query("page")), 0);
      c.get("antiAbuseCatalog")?.(event.resources[0]);
      observations.record(c.get("antiAbuseObservation"), 200, 10, true);
      c.header("Cache-Control", "public, max-age=300");
      return c.json({ count: 130000, page: Number(c.req.query("page")) });
    });
    try {
      for (let i = 0; i < 121; i++) {
        now = base + i * 10;
        const page = Math.floor(i / 10) * 10 + shuffled[i % 10];
        const response = await app.request(
          `${path}?page=${page}&limit=100&noise=${i}`,
          {
            headers: {
              ...headers,
              "cf-connecting-ip": `192.0.2.${i % 250}`,
              "user-agent": `Python/3.12 aiohttp/3.14.${i % 5}`,
            },
          },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=300",
        );
        expect(await response.json()).toEqual({ count: 130000, page });
        await scorer.drain();
      }
      expect(scorer.risk([`fp:${fp}`])).toBeCloseTo(0.85);
      await observations.flush();
      for (const reason of ["page-sweep", "route-hammering"])
        expect(
          Object.keys(rows[0].values).some((key) =>
            key.endsWith(`|reason:${reason}`),
          ),
        ).toBe(true);
    } finally {
      scorer.close();
      await observations.close();
    }
  });
});
