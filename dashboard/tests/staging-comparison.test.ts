import { afterEach, expect, it, vi } from "vitest";
import { compareStagingOrigin } from "../worker/staging-comparison.js";
import type { DashboardEnv } from "../worker/types.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture() {
  const env: Partial<DashboardEnv> = {
    RATE_LIMIT_ENVIRONMENT: "staging",
    RUST_SHADOW_ORIGIN: "https://mirror.example",
    RUST_SHADOW_TOKEN: "fixture-token",
    API_PROXY_HOST: "public.example",
  };
  const req = new Request("https://public.example/v1/offers?country=ES");
  const primary = new URL("https://node.example/v1/offers?country=ES");
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  const headers = new Headers({
    Cookie: "private",
    Authorization: "private",
    "x-egdata-key-id": "private",
    "x-egdata-request-id": "test-request",
    "x-egdata-key-tier": "free",
    "x-egdata-authenticated": "1",
  });
  return { env: env as DashboardEnv, req, primary, ctx, headers };
}
it("compares served reads in the background and isolates mirror credentials", async () => {
  const { env, req, primary, ctx, headers } = fixture();
  const fetch = vi.fn(async () => new Response("different"));
  vi.stubGlobal("fetch", fetch);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const res = new Response("primary");
  compareStagingOrigin(env, ctx, primary, req, headers, res, "listOffers");
  expect(await res.text()).toBe("primary");
  await vi.mocked(ctx.waitUntil).mock.calls[0][0];
  expect(fetch).toHaveBeenCalledWith(
    "https://mirror.example/v1/offers?country=ES",
    expect.objectContaining({ redirect: "manual" }),
  );
  const forwarded = (
    fetch.mock.calls as unknown as [string, RequestInit][]
  )[0][1].headers as Headers;
  expect(forwarded.get("x-egdata-origin-token")).toBe("fixture-token");
  expect(forwarded.get("x-egdata-key-id")).toBe("key_staging_mirror");
  expect(forwarded.get("x-egdata-authenticated")).toBe("1");
  expect(forwarded.has("authorization") || forwarded.has("cookie")).toBe(false);
  expect(log).toHaveBeenCalledWith(
    "rust-origin-comparison",
    expect.objectContaining({ operationId: "listOffers", body: "different" }),
  );
});
it("keeps writes, looped hosts and production requests on the primary origin", () => {
  const { env, req, primary, ctx, headers } = fixture();
  const compare = (e: DashboardEnv, r: Request) =>
    compareStagingOrigin(
      e,
      ctx,
      primary,
      r,
      headers,
      new Response("ok"),
      "listOffers",
    );
  compare(env, new Request(req, { method: "POST" }));
  compare({ ...env, RATE_LIMIT_ENVIRONMENT: "production" }, req);
  compare({ ...env, RUST_SHADOW_ORIGIN: primary.origin }, req);
  compare({ ...env, RUST_SHADOW_ORIGIN: undefined }, req);
  expect(ctx.waitUntil).not.toHaveBeenCalled();
});

it("distinguishes search and health durations from data and validator differences", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const timed = async (body: unknown, tag = "W/", status = 200) => {
    const text = JSON.stringify(body);
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)),
    );
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return new Response(text, {
      status,
      headers: { etag: tag + '"' + hex + '"' },
    });
  };
  const search = (ms: number, total = 1) => ({
    data: [],
    meta: { result: { tookMs: ms, total } },
  });
  const health = (ms: number) => ({
    data: {
      services: {
        redis: { status: "ok", latencyMs: ms },
        mongodb: { status: "error", latencyMs: null },
      },
    },
  });
  const fast = await timed(search(2));
  const slow = await timed(search(5));
  const searchReads = [
    "searchOffers",
    "searchChangelog",
    "multisearchOffers",
    "multisearchItems",
    "multisearchSellers",
  ];
  for (const [operation, source, shadow, body, headersChanged] of [
    ...searchReads.map(
      (operation) =>
        [operation, fast.clone(), slow.clone(), "timing-only", []] as const,
    ),
    [
      "searchFreeGames",
      await timed(search(2)),
      await timed(search(5), ""),
      "timing-only",
      ["etag"],
    ],
    [
      "searchFreeGames",
      await timed(search(2)),
      await timed(search(5, 2)),
      "different",
      ["etag"],
    ],
    [
      "searchOffers",
      await timed(search(2)),
      new Response(JSON.stringify(search(5)), { headers: { etag: '"stale"' } }),
      "different",
      ["etag"],
    ],
    [
      "getHealth",
      await timed(health(3), "W/", 503),
      await timed(health(12), "W/", 503),
      "timing-only",
      [],
    ],
    [
      "listOffers",
      await timed(search(2)),
      await timed(search(5)),
      "different",
      ["etag"],
    ],
  ] as const) {
    const { env, req, primary, ctx, headers } = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => shadow),
    );
    compareStagingOrigin(env, ctx, primary, req, headers, source, operation);
    await vi.mocked(ctx.waitUntil).mock.calls[0][0];
    expect(log).toHaveBeenLastCalledWith(
      "rust-origin-comparison",
      expect.objectContaining({ operationId: operation, body, headersChanged }),
    );
  }
});
