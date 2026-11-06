import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createAntiAbuse,
  extractFingerprint,
  isProtectedPath,
  tarpitDelay,
} from "../src/middleware/anti-abuse.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import {
  type AbuseEvent,
  AbuseScorer,
  ExpiringLru,
  type RiskStore,
  scoreEvents,
} from "../src/services/abuse-scorer.js";
import {
  PowSessionService,
  verifyProofOfWork,
} from "../src/services/pow-session.js";

const secret = "test-only-secret-with-at-least-32-bytes";
const edgeSecret = "test-edge-secret";
const baseTime = 1_800_000_000_000;

function headers(extra: Record<string, string> = {}) {
  return {
    "user-agent": "Chrome/130.0",
    accept: "application/json",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-ch-ua": "Chromium",
    "x-egdata-edge-secret": edgeSecret,
    "x-egdata-tls-cipher": "AEAD-AES128-GCM-SHA256",
    "x-egdata-tls-version": "TLSv1.3",
    "x-egdata-http-protocol": "HTTP/2",
    "x-egdata-asn": "1234",
    "cf-ja4": "t13d1516h2_test_test",
    ...extra,
  };
}

function solve(challenge: string, difficulty = 16) {
  for (let nonce = 0; ; nonce++)
    if (verifyProofOfWork(challenge, String(nonce), difficulty))
      return String(nonce);
}

function fixture(
  options: {
    mode?: "observe" | "enforce";
    canaries?: boolean;
    store?: RiskStore;
  } = {},
) {
  let clock = baseTime;
  const now = () => clock;
  const sessions = new PowSessionService(secret, now);
  const scorer = new AbuseScorer(options.store, now);
  const delay = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
  const anti = createAntiAbuse({
    mode: options.mode ?? "enforce",
    sessions,
    scorer,
    now,
    edgeSecret,
    delay,
    random: () => 0.5,
    canaries: options.canaries,
  });
  const app = new Hono();
  const handler = vi.fn((c) =>
    c.json({ elements: [{ id: "real" }], total: 1 }),
  );
  app.use("*", anti.middleware);
  app.post("/auth/challenge", anti.challenge);
  app.use("*", responseEtag);
  app.use("*", edgeCacheHeaders);
  app.get("*", handler);
  const request = (path: string, extra: Record<string, string> = {}) =>
    app.request(path, { headers: headers(extra) });
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    app.request("/auth/challenge", {
      method: "POST",
      headers: headers({ "content-type": "application/json", ...extra }),
      body: JSON.stringify(body),
    });
  const handshake = async () => {
    const challenge = await (await post({})).json();
    const response = await post({
      challenge: challenge.challenge,
      nonce: solve(challenge.challenge, challenge.difficulty),
    });
    const result = await response.json();
    return { ...result, response } as {
      token: string;
      expiresAt: number;
      response: Response;
    };
  };
  return {
    app,
    scorer,
    sessions,
    handler,
    delay,
    request,
    post,
    handshake,
    now,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("transport fingerprint", () => {
  it("ignores client-supplied JA3/JA4 by default even with a valid edge secret", () => {
    const fingerprint = (extra: Record<string, string>) =>
      extractFingerprint(
        new Request("https://api.test/items", { headers: headers(extra) }),
        { edgeSecret },
      );
    const baseline = fingerprint({});
    expect(
      fingerprint({ "cf-ja3-hash": "spoofed-ja3", "cf-ja4": "spoofed-ja4" })
        .fingerprintHash,
    ).toBe(baseline.fingerprintHash);
    const noTransport = new Request("https://api.test/items", {
      headers: {
        "x-egdata-edge-secret": edgeSecret,
        "cf-ja3-hash": "spoofed-ja3",
        "cf-ja4": "spoofed-ja4",
      },
    });
    expect(
      extractFingerprint(noTransport, { edgeSecret }).trustedTransport,
    ).toBe(false);
  });

  it("only accepts forwarded bot headers with explicit opt-in and edge authentication", () => {
    const fingerprint = (extra: Record<string, string>) =>
      extractFingerprint(
        new Request("https://api.test/items", { headers: headers(extra) }),
        { edgeSecret, trustBotHeaders: true },
      );
    expect(
      fingerprint({ "cf-ja4": "different-profile" }).fingerprintHash,
    ).not.toBe(fingerprint({}).fingerprintHash);
    expect(
      fingerprint({ "cf-ja4": "", "cf-ja3-hash": "first-ja3" }).fingerprintHash,
    ).not.toBe(
      fingerprint({ "cf-ja4": "", "cf-ja3-hash": "second-ja3" })
        .fingerprintHash,
    );
    expect(
      fingerprint({ "x-egdata-edge-secret": "invalid", "cf-ja4": "first" })
        .fingerprintHash,
    ).toBe(
      fingerprint({ "x-egdata-edge-secret": "invalid", "cf-ja4": "second" })
        .fingerprintHash,
    );
  });

  it("uses native Cloudflare bot properties without trusting forwarded bot headers", () => {
    const fingerprint = (ja4: string, header: string) => {
      const request = new Request("https://api.test/items", {
        headers: headers({ "cf-ja4": header }),
      });
      Object.assign(request, { cf: { asn: 1234, botManagement: { ja4 } } });
      return extractFingerprint(request);
    };
    expect(fingerprint("native-profile", "spoofed").trustedTransport).toBe(
      true,
    );
    expect(fingerprint("native-profile", "spoofed").fingerprintHash).toBe(
      fingerprint("native-profile", "other-spoof").fingerprintHash,
    );
    expect(fingerprint("native-profile", "spoofed").fingerprintHash).not.toBe(
      fingerprint("other-native-profile", "spoofed").fingerprintHash,
    );
  });

  it("groups rotating IPs and UA values, including after the cookie/header handshake", () => {
    const a = extractFingerprint(
      new Request("https://api.test/items", {
        headers: headers({ "cf-connecting-ip": "1.2.3.4" }),
      }),
      { edgeSecret },
    );
    const b = extractFingerprint(
      new Request("https://api.test/auth/challenge", {
        headers: headers({
          "cf-connecting-ip": "9.8.7.6",
          "user-agent": "python-requests",
          cookie: "x=y",
          "x-egdata-session": "token",
          "content-type": "application/json",
        }),
      }),
      { edgeSecret },
    );
    expect(a.fingerprintHash).toBe(b.fingerprintHash);
    expect(a.trustedTransport).toBe(true);
  });

  it("uses authenticated header order and ASN, and rejects spoofed edge signals", () => {
    const fingerprint = (extra: Record<string, string>) =>
      extractFingerprint(
        new Request("https://api.test", { headers: headers(extra) }),
        { edgeSecret },
      );
    expect(
      fingerprint({ "x-egdata-header-order": "accept,user-agent" })
        .fingerprintHash,
    ).not.toBe(
      fingerprint({ "x-egdata-header-order": "user-agent,accept" })
        .fingerprintHash,
    );
    expect(fingerprint({ "x-egdata-asn": "99" }).fingerprintHash).not.toBe(
      fingerprint({}).fingerprintHash,
    );
    expect(
      fingerprint({ "x-egdata-edge-secret": "spoof" }).trustedTransport,
    ).toBe(false);
    const raw = new Request("https://api.test", {
      headers: { "user-agent": "Chrome/130" },
    });
    Object.assign(raw, {
      cf: {
        tlsCipher: "AES128-SHA",
        tlsVersion: "TLSv1.2",
        httpProtocol: "HTTP/1.1",
        asn: 1234,
      },
    });
    expect(extractFingerprint(raw).mismatches).toEqual([
      "chrome-without-client-hints",
      "browser-legacy-transport",
    ]);
  });
});

describe("stateless PoW sessions", () => {
  it("binds a proof to its fingerprint and purpose, rejects tampering and fixes replay lifetime", async () => {
    let now = baseTime;
    const service = new PowSessionService(secret, () => now);
    const fp = "a".repeat(64);
    const challenge = await service.challenge(fp, 0);
    const nonce = solve(challenge.challenge);
    expect(await service.verify(challenge.challenge, fp)).toBeNull();
    expect(
      await service.redeem(challenge.challenge, nonce, "b".repeat(64)),
    ).toBeNull();
    expect(
      await service.redeem(challenge.challenge, nonce, fp, 0.6),
    ).toBeNull();
    const redeemed = await service.redeem(challenge.challenge, nonce, fp);
    expect(redeemed).not.toBeNull();
    now += 1000;
    expect((await service.redeem(challenge.challenge, nonce, fp))?.token).toBe(
      redeemed?.token,
    );
    expect(await service.verify(`x${redeemed?.token}`, fp)).toBeNull();
    expect(
      await service.verify(redeemed?.token ?? "", "b".repeat(64)),
    ).toBeNull();
    now += 60_000;
    expect(await service.redeem(challenge.challenge, nonce, fp)).toBeNull();
    now = baseTime + 600_000;
    expect(await service.verify(redeemed?.token ?? "", fp)).toBeNull();
    expect((await service.challenge(fp, 0.6)).difficulty).toBe(20);
    expect(verifyProofOfWork(challenge.challenge, "a".repeat(65), 16)).toBe(
      false,
    );
    expect(() => new PowSessionService("short")).toThrow();
  });
});

function event(at: number, page: number): AbuseEvent {
  return {
    at,
    deep: true,
    support: false,
    route: "/offers",
    page,
    mismatch: 0,
  };
}

describe("sliding feature aggregation", () => {
  it("detects a cross-session pagination sweep and decays after 60 seconds", async () => {
    let now = baseTime;
    const scorer = new AbuseScorer(undefined, () => now);
    for (let page = 1; page <= 35; page++) {
      scorer.enqueue(
        ["fp:shared", `session:rotated-${page}`],
        event(now, page),
      );
      now += 100;
    }
    await scorer.drain();
    expect(scorer.risk(["fp:shared"])).toBeGreaterThan(0.8);
    expect(scorer.risk(["session:rotated-1"])).toBe(0);
    now += 60_001;
    expect(scorer.risk(["fp:shared"])).toBe(0);
    scorer.close();
  });

  it("scores unique ID sweeps, but never convicts a deep-only slow reader", () => {
    expect(
      scoreEvents(
        Array.from({ length: 40 }, (_, i) => ({
          ...event(i * 100, 1),
          itemId: `item${i}`,
        })),
      ),
    ).toBeGreaterThan(0.8);
    expect(
      scoreEvents(Array.from({ length: 20 }, (_, i) => event(i * 3000, 1))),
    ).toBeLessThanOrEqual(0.5);
    expect(
      scoreEvents(
        Array.from({ length: 30 }, (_, i) => ({
          ...event(i * i * 30, i),
          deep: false,
          support: true,
        })),
      ),
    ).toBeLessThanOrEqual(0.5);
  });

  it("falls back locally on Redis errors and bounds the queue and LRU", async () => {
    const store = { append: vi.fn().mockRejectedValue(new Error("offline")) };
    const scorer = new AbuseScorer(store, () => baseTime);
    for (let i = 0; i < 2100; i++)
      scorer.enqueue(["fp:shared"], event(baseTime + i, i));
    expect(scorer.stats.dropped).toBe(52);
    await scorer.drain();
    expect(scorer.risk(["fp:shared"])).toBeGreaterThan(0.8);
    expect(store.append).toHaveBeenCalledTimes(1);
    const lru = new ExpiringLru<number>(2, () => 0);
    lru.set("a", 1, 100);
    lru.set("b", 2, 100);
    lru.get("a");
    lru.set("c", 3, 100);
    expect(lru.get("b")).toBeUndefined();
    scorer.close();
  });
});

describe("Hono integration", () => {
  it("keeps sessions valid when clients alter ignored bot headers", async () => {
    const f = fixture();
    const { token } = await f.handshake();
    const response = await f.request("/items", {
      "x-egdata-session": token,
      "cf-ja3-hash": "spoofed-ja3",
      "cf-ja4": "spoofed-ja4",
    });
    expect((await response.json()).total).toBe(1);
    expect(f.handler).toHaveBeenCalledTimes(1);
    f.scorer.close();
  });

  it("serves clean desktop clients without sessions, including invalid or expired optional tokens", async () => {
    const f = fixture();
    const desktopHeaders: Record<string, string> = headers({
      "user-agent": "ExampleDesktop/1.0",
    });
    for (const name of ["sec-fetch-site", "sec-fetch-mode", "sec-ch-ua"])
      delete desktopHeaders[name];
    for (const path of [
      "/offers",
      "/offers/game/prices",
      "/items/game",
      "/sellers/seller",
      "/other?page=2",
      "/graphql",
      "/catalog/hydrate",
      "/%6fffers?page=1",
    ]) {
      const res = await f.app.request(path, { headers: desktopHeaders });
      expect(res.status).toBe(200);
      expect((await res.json()).elements[0].id).toBe("real");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(
      (
        await (
          await f.request("/items/game", { "x-egdata-session": "invalid" })
        ).json()
      ).total,
    ).toBe(1);
    const { token } = await f.handshake();
    f.tick(600_000);
    expect(
      (
        await (
          await f.request("/items/game", { "x-egdata-session": token })
        ).json()
      ).total,
    ).toBe(1);
    expect(f.delay).not.toHaveBeenCalled();
    f.scorer.close();
  });

  it("gates suspicious root, nested and pagination requests with HTTP 200 without querying the catalog", async () => {
    const f = fixture();
    vi.spyOn(f.scorer, "risk").mockReturnValue(0.6);
    for (const path of [
      "/offers",
      "/offers/x/prices",
      "/items/x",
      "/sellers/x",
      "/other?page=2",
      "/graphql",
      "/catalog/hydrate",
      "/%6fffers?page=1",
    ]) {
      const res = await f.request(path);
      expect(res.status).toBe(200);
      expect((await res.json()).error.code).toBe("SESSION_CHALLENGE_REQUIRED");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(f.handler).not.toHaveBeenCalled();
    expect(isProtectedPath("/offers/")).toBe(true);
    f.scorer.close();
  });

  it("requires a valid bound session when suspicious and allows on-demand PoW recovery", async () => {
    const f = fixture();
    const risk = vi.spyOn(f.scorer, "risk").mockReturnValue(0.6);
    for (const token of [undefined, "invalid"]) {
      const res = await f.request(
        "/items/game",
        token ? { "x-egdata-session": token } : {},
      );
      expect((await res.json()).error.code).toBe("SESSION_CHALLENGE_REQUIRED");
    }
    const challenge = await (await f.post({})).json();
    expect(challenge.difficulty).toBe(20);
    const { token } = await (
      await f.post({
        challenge: challenge.challenge,
        nonce: solve(challenge.challenge, challenge.difficulty),
      })
    ).json();
    expect(typeof token).toBe("string");
    expect(
      (
        await (
          await f.request("/items/game", { "x-egdata-session": token })
        ).json()
      ).total,
    ).toBe(1);
    expect(
      (
        await (
          await f.request("/items/game", {
            "x-egdata-session": token,
            "x-egdata-asn": "99",
          })
        ).json()
      ).error.code,
    ).toBe("SESSION_CHALLENGE_REQUIRED");
    f.tick(30_000);
    expect(
      (
        await (
          await f.request("/items/game", { "x-egdata-session": token })
        ).json()
      ).error.code,
    ).toBe("SESSION_CHALLENGE_REQUIRED");
    risk.mockReturnValue(0);
    // Historical risk in a valid, early-expired token must not force a clean
    // client into an endless chain of harder challenges.
    expect(
      (
        await (
          await f.request("/items/game", { "x-egdata-session": token })
        ).json()
      ).total,
    ).toBe(1);
    expect((await (await f.request("/items/game")).json()).total).toBe(1);
    expect(
      (await (await f.post({}, { "x-egdata-session": token })).json())
        .difficulty,
    ).toBe(16);
    f.scorer.close();
  });

  it("continues aggregating tokenless traffic and stops challenging when evidence expires", async () => {
    const f = fixture();
    const fingerprint = extractFingerprint(
      new Request("https://api.test/items", { headers: headers() }),
      { edgeSecret },
    );
    const key = `fp:${fingerprint.fingerprintHash}`;
    // An irregularly timed unique-ID sweep scores 0.65 without robotic timing.
    for (let i = 0; i < 30; i++) {
      const res = await f.request(`/items/game-${i}`);
      expect((await res.json()).total).toBe(1);
      await f.scorer.drain();
      f.tick(i % 2 ? 900 : 100);
    }
    expect(f.scorer.risk([key])).toBeCloseTo(0.65);
    expect(
      (await (await f.request("/items/next-game")).json()).error.code,
    ).toBe("SESSION_CHALLENGE_REQUIRED");
    await f.scorer.drain();
    f.tick(60_001);
    expect((await (await f.request("/items/next-game")).json()).total).toBe(1);
    f.scorer.close();
  });

  it("keeps observe mode passive even for a suspicious tokenless client", async () => {
    const f = fixture({ mode: "observe" });
    vi.spyOn(f.scorer, "risk").mockReturnValue(1);
    expect((await (await f.request("/items/game")).json()).total).toBe(1);
    expect(f.delay).not.toHaveBeenCalled();
    f.scorer.close();
  });

  it("does not let a valid session bypass confirmed abuse", async () => {
    const f = fixture();
    const { token } = await f.handshake();
    vi.spyOn(f.scorer, "risk").mockReturnValue(0.81);
    expect(
      (
        await (
          await f.request("/items/game", { "x-egdata-session": token })
        ).json()
      ).elements,
    ).toEqual([]);
    expect(f.delay).toHaveBeenCalledTimes(1);
    expect(f.handler).not.toHaveBeenCalled();
    f.scorer.close();
  });

  it("accepts sessions across IP/UA rotation while preserving normal cache headers and ETags", async () => {
    const f = fixture();
    const { token, response } = await f.handshake();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    const res = await f.request("/offers?page=1", {
      "x-egdata-session": token,
      "cf-connecting-ip": "8.8.8.8",
      "user-agent": "rotated",
    });
    expect((await res.json()).elements[0].id).toBe("real");
    expect(res.headers.get("cdn-cache-control")).toContain("public");
    expect(res.headers.get("etag")).toBeTruthy();
    const revalidated = await f.request("/offers?page=1", {
      "if-none-match": res.headers.get("etag") ?? "missing-etag",
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    const cookieRes = await f.request("/items", {
      cookie: `__Host-egdata-session=${token}`,
    });
    expect((await cookieRes.json()).total).toBe(1);
    f.scorer.close();
  });

  it("tarpits rotating clients after pagination sweeps without calling downstream", async () => {
    const f = fixture({ mode: "observe" });
    for (let page = 1; page <= 30; page++) {
      await f.request(`/offers?page=${page}`, {
        "cf-connecting-ip": `192.0.2.${page}`,
        "user-agent": `scraper-${page}`,
      });
      f.tick(100);
    }
    await f.scorer.drain();
    const enforced = createAntiAbuse({
      mode: "enforce",
      sessions: f.sessions,
      scorer: f.scorer,
      edgeSecret,
      delay: f.delay,
      random: () => 0,
      now: f.now,
    });
    const app = new Hono();
    app.use("*", enforced.middleware);
    const downstream = vi.fn((c) => c.json({ secret: "catalog" }));
    app.get("*", downstream);
    const response = await app.request("/offers?page=31", {
      headers: headers({
        "user-agent": "new agent",
        "cf-connecting-ip": "203.0.113.99",
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).elements).toEqual([]);
    expect(downstream).not.toHaveBeenCalled();
    expect(f.delay.mock.calls[0][0]).toBe(3000);
    f.scorer.close();
  });

  it("expires suspicious sessions early and raises the next challenge difficulty", async () => {
    const f = fixture();
    const { token } = await f.handshake();
    vi.spyOn(f.scorer, "risk").mockReturnValue(0.6);
    expect(
      (await (await f.request("/items", { "x-egdata-session": token })).json())
        .total,
    ).toBe(1);
    f.tick(30_000);
    expect(
      (await (await f.request("/items", { "x-egdata-session": token })).json())
        .error.code,
    ).toBe("SESSION_CHALLENGE_REQUIRED");
    expect(
      (await (await f.post({}, { "x-egdata-session": token })).json())
        .difficulty,
    ).toBe(20);
    f.scorer.close();
  });

  it("injects a canary after list generation and immediately traps its lookup", async () => {
    const f = fixture({ canaries: true });
    const { token } = await f.handshake();
    const ordinary = await f.request("/items");
    const canaryResponse = await f.request("/items", {
      "x-egdata-session": token,
      "if-none-match": ordinary.headers.get("etag") ?? "missing-etag",
    });
    expect(canaryResponse.status).toBe(200);
    expect(canaryResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(canaryResponse.headers.get("cdn-cache-control")).toBe("no-store");
    expect(canaryResponse.headers.get("etag")).toBeNull();
    const list = await canaryResponse.json();
    const canary = list.elements.find(
      (item: { synthetic?: boolean }) => item.synthetic,
    );
    expect(canary.id).toMatch(/^egcanary_[a-f0-9]{32}$/);
    const response = await f.request(`/items/${canary.id}`, {
      "x-egdata-session": token,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).elements).toEqual([]);
    expect(f.delay).toHaveBeenCalledTimes(1);
    expect(f.handler).toHaveBeenCalledTimes(2);
    f.scorer.close();
  });

  it("does not convict a forged canary or pool untrusted transport clients", async () => {
    const f = fixture();
    const { token } = await f.handshake();
    const response = await f.request(`/items/egcanary_${"0".repeat(32)}`, {
      "x-egdata-session": token,
    });
    expect((await response.json()).total).toBe(1);
    for (let i = 1; i <= 30; i++) {
      await f.request(`/offers?page=${i}`, {
        "x-egdata-edge-secret": "forged",
      });
      f.tick(100);
    }
    await f.scorer.drain();
    expect(f.delay).not.toHaveBeenCalled();
    f.scorer.close();
  });

  it("returns before a blocked telemetry store and cancels tarpit timers on disconnect", async () => {
    let unblock: (() => void) | undefined;
    const store: RiskStore = {
      append: async (_, e) => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return { events: [e], trapped: false };
      },
    };
    const f = fixture({ mode: "observe", store });
    expect((await f.request("/items")).status).toBe(200);
    const drained = f.scorer.drain();
    expect(unblock).toBeDefined();
    unblock?.();
    await drained;
    const controller = new AbortController();
    const delay = tarpitDelay(5000, controller.signal);
    controller.abort();
    await delay;
    f.scorer.close();
  });

  it("rejects oversized challenge input before cryptographic processing", async () => {
    const f = fixture();
    expect((await f.post({ nonce: "a".repeat(5000) })).status).toBe(400);
    f.scorer.close();
  });

  it("protects sales without pagination and never caches mitigation responses", async () => {
    const f = fixture();
    const risk = vi.spyOn(f.scorer, "risk").mockReturnValue(0.6);
    for (const path of ["/sales", "/active-sales", "/%73ales"]) {
      expect(isProtectedPath(path)).toBe(true);
      const response = await f.request(path, { "if-none-match": "anything" });
      expect((await response.json()).error.code).toBe(
        "SESSION_CHALLENGE_REQUIRED",
      );
      expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
        "no-store",
      );
      expect(response.headers.get("etag")).toBeNull();
    }
    risk.mockReturnValue(1);
    const response = await f.request("/sales");
    expect((await response.json()).elements).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(f.handler).not.toHaveBeenCalled();
    f.scorer.close();
  });

  it("keeps the clean/suspicious/confirmed threshold boundaries exact", async () => {
    const f = fixture();
    const risk = vi.spyOn(f.scorer, "risk").mockReturnValue(0.5);
    expect((await (await f.request("/items")).json()).total).toBe(1);
    risk.mockReturnValue(0.5001);
    expect((await (await f.request("/items")).json()).error.code).toBe(
      "SESSION_CHALLENGE_REQUIRED",
    );
    risk.mockReturnValue(0.8);
    expect((await (await f.request("/items")).json()).error.code).toBe(
      "SESSION_CHALLENGE_REQUIRED",
    );
    expect(f.delay).not.toHaveBeenCalled();
    risk.mockReturnValue(0.8001);
    expect((await (await f.request("/items")).json()).elements).toEqual([]);
    expect(f.delay).toHaveBeenCalledTimes(1);
    f.scorer.close();
  });

  it("preserves cookie continuity for early expiry without trusted edge signals", async () => {
    const f = fixture();
    const extra = { "x-egdata-edge-secret": "untrusted" };
    const challenge = await (await f.post({}, extra)).json();
    const redeemed = await (
      await f.post(
        { challenge: challenge.challenge, nonce: solve(challenge.challenge) },
        extra,
      )
    ).json();
    const cookie = `__Host-egdata-session=${redeemed.token}`;
    vi.spyOn(f.scorer, "risk").mockImplementation((keys) =>
      keys.some((key) => key.startsWith("session:")) ? 0.6 : 0,
    );
    f.tick(30_000);
    const response = await f.request("/items", { ...extra, cookie });
    expect((await response.json()).error.code).toBe(
      "SESSION_CHALLENGE_REQUIRED",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(
      (await (await f.post({}, { ...extra, cookie })).json()).difficulty,
    ).toBe(20);
    f.scorer.close();
  });
});
