import { describe, expect, it } from "vitest";
import { buildUsageChartPoints } from "../src/components/usage/UsageCharts";
import type { UsageMetrics } from "../worker/analytics-types";

function bucketMetrics(requests: number, cacheHits: number): UsageMetrics {
  return {
    requests,
    cacheHits,
    cacheHitRate: requests ? Math.round((cacheHits / requests) * 100) : 0,
    rateLimited: 0,
    blockedPolicy: 0,
    errors: 0,
    errorRate: 0,
    avgLatencyMs: 10,
    p50LatencyMs: 10,
    p95LatencyMs: 20,
    p99LatencyMs: 30,
  };
}

describe("buildUsageChartPoints", () => {
  const baseData = {
    start: "2026-11-01T00:00:00.000Z",
    end: "2026-11-05T00:00:00.000Z",
    bucketMinutes: 1440,
    timeseries: [
      {
        bucket: "2026-11-02T00:00:00.000Z",
        ...bucketMetrics(120, 40),
      },
      {
        bucket: "2026-11-04T00:00:00.000Z",
        ...bucketMetrics(80, 60),
      },
    ],
  };

  it("keeps missing intervals null in non-cumulative mode", () => {
    const points = buildUsageChartPoints(baseData, false);
    expect(points.map((p) => p.requests)).toEqual([null, 120, null, 80]);
    expect(points.map((p) => p.cacheHits)).toEqual([null, 40, null, 60]);
  });

  it("accumulates requests and cacheHits across the ongoing month in cumulative mode", () => {
    const points = buildUsageChartPoints(baseData, true);
    expect(points.map((p) => p.requests)).toEqual([0, 120, 120, 200]);
    expect(points.map((p) => p.cacheHits)).toEqual([0, 40, 40, 100]);
    expect(points.map((p) => p.quotaRequests)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("accumulates admitted free-project quotaRequests separately when quotaTimeseries is provided", () => {
    const points = buildUsageChartPoints(
      {
        ...baseData,
        quotaTimeseries: [
          { bucket: "2026-11-02T00:00:00.000Z", requests: 90 },
          { bucket: "2026-11-04T00:00:00.000Z", requests: 30 },
        ],
      },
      true,
    );
    expect(points.map((p) => p.requests)).toEqual([0, 120, 120, 200]);
    expect(points.map((p) => p.quotaRequests)).toEqual([0, 90, 90, 120]);
  });

  it("aligns previousTimeseries and separates HIT vs MISS latency and error status buckets", () => {
    const points = buildUsageChartPoints(
      {
        start: "2026-11-01T00:00:00.000Z",
        end: "2026-11-03T00:00:00.000Z",
        bucketMinutes: 1440,
        timeseries: [
          {
            bucket: "2026-11-01T00:00:00.000Z",
            ...bucketMetrics(100, 75),
            rateLimited: 2,
            status2xx: 85,
            status3xx: 5,
            status4xx: 7,
            status5xx: 3,
            avgHitLatencyMs: 8,
            avgMissLatencyMs: 240,
          },
        ],
        previousTimeseries: [
          {
            bucket: "2026-11-01T00:00:00.000Z",
            requests: 50,
            errors: 4,
            avgLatencyMs: 12,
            p95LatencyMs: 30,
          },
        ],
      },
      false,
    );
    expect(points[0]).toMatchObject({
      requests: 100,
      status2xx3xx: 90,
      status4xxOther: 5,
      status5xx: 3,
      avgHitLatencyMs: 8,
      avgMissLatencyMs: 240,
      prevRequests: 50,
    });
    expect(points[1].requests).toBeNull();
  });
});
