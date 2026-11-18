import { it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";

const clients = vi.hoisted(
  () => [] as Array<{ options: Record<string, unknown>; keys: string[] }>,
);
vi.mock("ioredis", () => ({
  Redis: class {
    keys: string[] = [];
    constructor(public options: Record<string, unknown>) {
      clients.push(this);
    }
    on() {}
    get(key: string) {
      this.keys.push(key);
      return Promise.resolve(null);
    }
  },
}));

it("records shared and dedicated cache connection options from the Node clients", async () => {
  const inputs: Record<string, string>[] = [
    {},
    { REDISHOST: "", REDISPORT: "", REDISUSER: "", REDISPASSWORD: "" },
    {
      REDISHOST: " local host ",
      REDISPORT: "\uFEFF+06380suffix",
      REDISTLS: " true ",
    },
    { REDISPORT: "0x18EB!", REDISTLS: "true", REDISPASSWORD: "  @/ pass  " },
    { REDISPORT: "1e3" },
    { REDISPORT: "6379.5" },
    { REDISPORT: "0" },
    ...["letters", "-1", "65536", "0x", "9".repeat(400), "-0"].map(
      (REDISPORT) => ({ REDISPORT }),
    ),
    {
      CACHE_REDIS_HOST: "\uFEFF",
      CACHE_REDIS_USER: "\uFEFF",
      RESPONSE_CACHE_PREFIX: "\uFEFF v3: \uFEFF",
    },
    {
      CACHE_REDIS_HOST: " \uFEFFcache\uFEFF ",
      CACHE_REDIS_PORT: " 06380 ",
      CACHE_REDIS_USER: " u ",
      CACHE_REDIS_PASSWORD: " p ",
      CACHE_REDIS_TLS: " true ",
    },
    { CACHE_REDIS_PORT: "6379" },
    { CACHE_REDIS_HOST: "cache", CACHE_REDIS_PORT: "+6379" },
    { CACHE_REDIS_HOST: "cache", CACHE_REDIS_PORT: "0" },
    { CACHE_REDIS_HOST: "cache", CACHE_REDIS_TLS: "yes" },
  ];
  const cases = [];
  try {
    for (const input of inputs) {
      vi.resetModules();
      clients.length = 0;
      for (const key of new Set(inputs.flatMap(Object.keys)))
        vi.stubEnv(key, input[key]);
      let cache: unknown;
      try {
        const { default: wrapped } = await import(
          "../src/clients/response-cache.js"
        );
        await wrapped.get("test");
        cache = {
          dedicated: clients.length === 2 ? options(1) : null,
          key: clients.at(-1)?.keys[0],
        };
      } catch (error) {
        cache = { error: (error as Error).message };
      }
      function options(index: number) {
        const opts = clients[index].options;
        return {
          host: opts.host,
          port:
            typeof opts.port === "number" && !Number.isFinite(opts.port)
              ? String(opts.port)
              : opts.port,
          tls: Boolean(opts.tls),
          username: opts.username ?? null,
          password: opts.password ?? null,
        };
      }
      cases.push({ input, shared: options(0), cache });
    }
  } finally {
    vi.unstubAllEnvs();
  }
  assertOracle("redis-connection-config-node", cases);
});
