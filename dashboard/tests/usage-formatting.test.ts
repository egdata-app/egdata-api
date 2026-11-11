import { describe, expect, it } from "vitest";
import { comparison, usageCsv } from "../src/lib/usage";
import type { UsageRow } from "../worker/analytics-types";

describe("usage exports and comparisons", () => {
  it("escapes CSV quotes/newlines and prevents formula injection", () => {
    const csv = usageCsv([
      {
        label: '=HYPERLINK("https://example.com")',
        detail: 'a,"b"\nnext',
        requests: 12,
      } as UsageRow,
    ]);
    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(csv).toContain('"a,""b""\nnext"');
  });
  it("does not invent percentages when a previous period is missing or zero", () => {
    expect(comparison(10, undefined)).toBe("Comparison unavailable");
    expect(comparison(10, 0)).toBe("New activity vs previous period");
    expect(comparison(0, 0)).toBe("No change vs previous period");
    expect(comparison(20, 10)).toBe("+100.0% vs previous period");
    expect(comparison(12, 10, true)).toBe("+2.0 pp vs previous period");
  });
});
