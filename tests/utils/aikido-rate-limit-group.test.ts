import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAikidoRateLimitGroup } from "../../src/utils/aikido-rate-limit-group.js";

const originalEnv = { ...process.env };

function makeHeaders(headers: Record<string, string>) {
  return new Headers(headers);
}

describe("getAikidoRateLimitGroup", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("builds a stable anonymous group from Cloudflare IP and User-Agent", () => {
    const headers = makeHeaders({
      "cf-connecting-ip": "203.0.113.10",
      "user-agent": "python-requests/2.32.5",
      "accept-language": "en-US",
      "cf-ipcountry": "KZ",
    });

    const first = getAikidoRateLimitGroup(headers);
    const second = getAikidoRateLimitGroup(headers);

    expect(first).toBe(second);
    expect(first).toMatch(/^anon:[A-Za-z0-9_-]+$/);
    expect(first).not.toContain("203.0.113.10");
    expect(first).not.toContain("python-requests");
  });

  it("uses the first X-Forwarded-For address when Cloudflare IP is absent", () => {
    const directCloudflare = getAikidoRateLimitGroup(
      makeHeaders({
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "python-requests/2.32.5",
      }),
    );
    const forwarded = getAikidoRateLimitGroup(
      makeHeaders({
        "x-forwarded-for": "203.0.113.10, 198.51.100.20",
        "user-agent": "python-requests/2.32.5",
      }),
    );

    expect(forwarded).toBe(directCloudflare);
  });

  it("changes the group when the User-Agent changes", () => {
    const python = getAikidoRateLimitGroup(
      makeHeaders({
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "python-requests/2.32.5",
      }),
    );
    const browser = getAikidoRateLimitGroup(
      makeHeaders({
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "Mozilla/5.0",
      }),
    );

    expect(python).not.toBe(browser);
  });

  it("falls back to normal Zen IP grouping when a secret is unavailable", () => {
    delete process.env.JWT_SECRET;

    expect(
      getAikidoRateLimitGroup(
        makeHeaders({
          "cf-connecting-ip": "203.0.113.10",
          "user-agent": "python-requests/2.32.5",
        }),
      ),
    ).toBeUndefined();
  });

  it("falls back to normal Zen IP grouping without IP or User-Agent", () => {
    expect(
      getAikidoRateLimitGroup(makeHeaders({ "user-agent": "Mozilla/5.0" })),
    ).toBeUndefined();
    expect(
      getAikidoRateLimitGroup(
        makeHeaders({ "cf-connecting-ip": "203.0.113.10" }),
      ),
    ).toBeUndefined();
  });
});
