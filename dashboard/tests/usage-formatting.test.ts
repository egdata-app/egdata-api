import { describe, expect, it } from "vitest";
import {
  comparison,
  deriveUsageInsights,
  usageCsv,
} from "../src/lib/usage";
import type { AnalyticsDashboardSummary, UsageRow } from "../worker/analytics-types";

describe("usage exports and comparisons", () => {
  it("escapes CSV quotes/newlines and prevents formula injection and includes developer columns", () => {
    const csv = usageCsv([
      {
        id: "ep-1",
        label: '=HYPERLINK("https://example.com")',
        detail: 'a,"b"\nnext',
        operationId: "offers.getOffer",
        expensive: "search",
        requests: 12,
        cacheHits: 6,
        cacheHitRate: 50,
        rateLimited: 0,
        blockedPolicy: 0,
        errors: 1,
        errorRate: 8.3,
        avgLatencyMs: 25,
        p50LatencyMs: 20,
        p95LatencyMs: 80,
        p99LatencyMs: 110,
        avgResponseBytes: 4096,
      } as UsageRow,
    ]);
    expect(csv).toContain('"Operation ID","Expensive policy"');
    expect(csv).toContain('"Avg payload bytes"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(csv).toContain('"a,""b""\nnext"');
    expect(csv).toContain('"offers.getOffer","search"');
    expect(csv).toContain('"4096"');
  });

  it("does not invent percentages when a previous period is missing or zero", () => {
    expect(comparison(10, undefined)).toBe("Comparison unavailable");
    expect(comparison(10, 0)).toBe("New activity vs previous period");
    expect(comparison(0, 0)).toBe("No change vs previous period");
    expect(comparison(20, 10)).toBe("+100.0% vs previous period");
    expect(comparison(12, 10, true)).toBe("+2.0 pp vs previous period");
  });

  it("derives actionable developer insights for burst throttling, policy blocks, low cache hit rate, 5xx errors, and cache gap", () => {
    const summary: AnalyticsDashboardSummary = {
      source: "cloudflare_analytics_engine",
      scope: "project",
      rangeHours: 24,
      start: "2026-11-10T12:00:00.000Z",
      end: "2026-11-11T12:00:00.000Z",
      bucketMinutes: 60,
      totals: {
        requests: 1000,
        cacheHits: 200,
        cacheMisses: 800,
        cacheHitRate: 20,
        rateLimited: 120,
        blockedPolicy: 25,
        errors: 180,
        errorRate: 18,
        avgLatencyMs: 320,
        p50LatencyMs: 250,
        p95LatencyMs: 1400,
        p99LatencyMs: 2100,
        avgHitLatencyMs: 15,
        avgMissLatencyMs: 680,
      },
      previous: {
        requests: 500,
        cacheHits: 300,
        cacheHitRate: 60,
        rateLimited: 0,
        blockedPolicy: 0,
        errors: 10,
        errorRate: 2,
        avgLatencyMs: 80,
        p50LatencyMs: 60,
        p95LatencyMs: 180,
        p99LatencyMs: 240,
      },
      timeseries: [
        {
          bucket: "2026-11-11T11:00:00.000Z",
          requests: 400,
          cacheHits: 80,
          cacheHitRate: 20,
          rateLimited: 120,
          blockedPolicy: 25,
          errors: 180,
          errorRate: 45,
          avgLatencyMs: 320,
          p50LatencyMs: 250,
          p95LatencyMs: 1400,
          p99LatencyMs: 2100,
        },
      ],
      cacheBreakdown: [],
      limitOutcomes: [
        { outcome: "scope_denied", requests: 25 },
        { outcome: "rate_limited", requests: 120 },
        { outcome: "ok", requests: 855 },
      ],
      statusCodes: [],
      endpoints: [],
      busiestEndpoints: [
        {
          id: "GET:/v1/search",
          label: "GET /v1/search",
          detail: "search.searchOffers",
          route: "/v1/search",
          method: "GET",
          requests: 300,
          cacheHits: 10,
          cacheHitRate: 3.3,
          rateLimited: 20,
          blockedPolicy: 0,
          errors: 40,
          errorRate: 13.3,
          avgLatencyMs: 800,
          p50LatencyMs: 700,
          p95LatencyMs: 1600,
          p99LatencyMs: 2100,
        },
      ],
      projects: [],
      keys: [],
    };

    const insights = deriveUsageInsights(summary, {
      rpmLimit: 60,
      monthlyUsed: 9000,
      monthlyAllowance: 10000,
      monthlyResetAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    const ids = insights.map((i) => i.id);
    expect(ids).toContain("burst-rate-limit");
    expect(ids).toContain("policy-denied");
    expect(ids).toContain("quota-burn");
    expect(ids).toContain("low-cache-hit");
  });
});
