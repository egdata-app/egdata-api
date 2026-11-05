import { describe, expect, it } from "vitest";
import { telemetryRedisOptions } from "../src/services/anti-abuse-runtime.js";

describe("telemetry Redis placement", () => {
  it("prefers a dedicated target and never inherits remote credentials or TLS", () => {
    expect(
      telemetryRedisOptions({
        ANTI_ABUSE_REDIS_HOST: "private-telemetry",
        CACHE_REDIS_HOST: "private-cache",
        CACHE_REDIS_PASSWORD: "cache-password",
        REDISHOST: "remote-shared",
        REDISPASSWORD: "shared-password",
        REDISTLS: "true",
      }),
    ).toEqual({
      host: "private-telemetry",
      port: 6379,
      username: undefined,
      password: undefined,
      tls: undefined,
    });
  });
  it("reuses the private response-cache configuration before shared Redis", () => {
    expect(
      telemetryRedisOptions({
        CACHE_REDIS_HOST: "private-cache",
        CACHE_REDIS_PORT: "6380",
        CACHE_REDIS_USER: "telemetry",
        CACHE_REDIS_PASSWORD: "private-password",
        CACHE_REDIS_TLS: "true",
        REDISHOST: "remote-shared",
      }),
    ).toEqual({
      host: "private-cache",
      port: 6380,
      username: "telemetry",
      password: "private-password",
      tls: {},
    });
    expect(telemetryRedisOptions({ REDISHOST: "legacy" }).host).toBe("legacy");
  });
  it("rejects partial or malformed local configurations instead of silently using remote Redis", () => {
    expect(() =>
      telemetryRedisOptions({ ANTI_ABUSE_REDIS_PASSWORD: "secret" }),
    ).toThrow("HOST");
    expect(() => telemetryRedisOptions({ CACHE_REDIS_PORT: "6379" })).toThrow(
      "HOST",
    );
    expect(() =>
      telemetryRedisOptions({
        ANTI_ABUSE_REDIS_HOST: "local",
        ANTI_ABUSE_REDIS_PORT: "65536",
      }),
    ).toThrow("PORT");
    expect(() =>
      telemetryRedisOptions({
        ANTI_ABUSE_REDIS_HOST: "local",
        ANTI_ABUSE_REDIS_TLS: "yes",
      }),
    ).toThrow("TLS");
  });
});
