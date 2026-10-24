import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRedis: vi.fn(),
  cache: { get: vi.fn(), set: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
  shared: { get: vi.fn(), set: vi.fn() },
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn((options: unknown) => {
    mocks.createRedis(options);
    return mocks.cache;
  }),
}));
vi.mock("../src/clients/redis.js", () => ({ default: mocks.shared }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const name of [
    "CACHE_REDIS_HOST",
    "CACHE_REDIS_PORT",
    "CACHE_REDIS_USER",
    "CACHE_REDIS_PASSWORD",
    "CACHE_REDIS_TLS",
  ]) {
    vi.stubEnv(name, undefined);
  }
  mocks.cache.get.mockResolvedValue(null);
  mocks.cache.set.mockResolvedValue("OK");
});

afterEach(() => vi.unstubAllEnvs());

describe("dedicated response cache", () => {
  it("disconnects only the dedicated cache during shutdown", async () => {
    vi.stubEnv("CACHE_REDIS_HOST", "private-cache");
    const { disconnectResponseCache } = await import(
      "../src/clients/response-cache.js"
    );
    disconnectResponseCache();
    expect(mocks.cache.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.shared.get).not.toHaveBeenCalled();
    expect(mocks.shared.set).not.toHaveBeenCalled();
  });

  it("preserves the original shared client when no cache is configured", async () => {
    const { default: cache } = await import("../src/clients/response-cache.js");
    expect(cache).toBe(mocks.shared);
    expect(mocks.createRedis).not.toHaveBeenCalled();
  });

  it("uses independent credentials and bounded commands for response data", async () => {
    vi.stubEnv("CACHE_REDIS_HOST", " private-cache ");
    vi.stubEnv("CACHE_REDIS_PASSWORD", "cache-test-password");
    vi.stubEnv("REDISUSER", "shared-user");
    vi.stubEnv("REDISPASSWORD", "shared-test-password");
    vi.stubEnv("REDISTLS", "true");
    mocks.cache.get.mockResolvedValue('{"total":2}');

    const { default: cache } = await import("../src/clients/response-cache.js");
    expect(mocks.createRedis).toHaveBeenCalledWith({
      host: "private-cache",
      port: 6379,
      username: undefined,
      password: "cache-test-password",
      tls: undefined,
      connectTimeout: 1000,
      commandTimeout: 1500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await expect(cache.get("search:v2:test")).resolves.toBe('{"total":2}');
    await expect(
      cache.set("search:v2:test", '{"total":2}', "EX", 60),
    ).resolves.toBe("OK");
    expect(mocks.cache.set).toHaveBeenCalledWith(
      "search:v2:test",
      '{"total":2}',
      "EX",
      60,
    );
    expect(mocks.shared.get).not.toHaveBeenCalled();
    expect(mocks.shared.set).not.toHaveBeenCalled();
  });

  it("supports an explicitly configured TLS cache and username", async () => {
    vi.stubEnv("CACHE_REDIS_HOST", "private-cache");
    vi.stubEnv("CACHE_REDIS_PORT", "6380");
    vi.stubEnv("CACHE_REDIS_USER", "cache-user");
    vi.stubEnv("CACHE_REDIS_TLS", "true");
    await import("../src/clients/response-cache.js");
    expect(mocks.createRedis).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 6380,
        username: "cache-user",
        tls: {},
        password: undefined,
      }),
    );
  });

  it("treats failed reads as misses and skips failed cache writes", async () => {
    vi.stubEnv("CACHE_REDIS_HOST", "private-cache");
    mocks.cache.get.mockRejectedValue(new Error("cache unavailable"));
    mocks.cache.set.mockRejectedValue(new Error("cache unavailable"));
    const { default: cache } = await import("../src/clients/response-cache.js");
    await expect(cache.get("offers:test")).resolves.toBeNull();
    await expect(cache.set("offers:test", "[]", "EX", 60)).resolves.toBeNull();
    expect(mocks.shared.get).not.toHaveBeenCalled();
    expect(mocks.shared.set).not.toHaveBeenCalled();
  });

  it("rejects partial configuration instead of writing responses to shared Redis", async () => {
    vi.stubEnv("CACHE_REDIS_PASSWORD", "cache-test-password");
    await expect(import("../src/clients/response-cache.js")).rejects.toThrow(
      "CACHE_REDIS_HOST is required",
    );
    expect(mocks.createRedis).not.toHaveBeenCalled();
  });

  it.each([
    "0",
    "65536",
    "6379oops",
  ])("rejects invalid cache port %s", async (port) => {
    vi.stubEnv("CACHE_REDIS_HOST", "private-cache");
    vi.stubEnv("CACHE_REDIS_PORT", port);
    await expect(import("../src/clients/response-cache.js")).rejects.toThrow(
      "CACHE_REDIS_PORT",
    );
  });

  it("rejects an ambiguous TLS setting", async () => {
    vi.stubEnv("CACHE_REDIS_HOST", "private-cache");
    vi.stubEnv("CACHE_REDIS_TLS", "yes");
    await expect(import("../src/clients/response-cache.js")).rejects.toThrow(
      "CACHE_REDIS_TLS",
    );
  });
});
