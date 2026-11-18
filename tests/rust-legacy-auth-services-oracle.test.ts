import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { it, vi, afterAll } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import auth from "../src/routes/auth.js";
import usersService from "../src/routes/users-service.js";

type Setup = {
  db?: Record<string, unknown>;
  http?: Array<{
    status: number;
    result?: unknown;
    raw?: string;
    unavailable?: boolean;
  }>;
  fault?: string;
  inserted?: boolean;
  state?: string | null;
};
type Input = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
};
const io = vi.hoisted(() => ({
  setup: {} as Setup,
  trace: [] as unknown[],
  http: [] as unknown[],
  queue: [] as NonNullable<Setup["http"]>,
}));
function wire(value: unknown): unknown {
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, wire(v)]),
    );
  return value;
}
function recordCall(
  call: Record<string, unknown>,
  result: unknown,
  operation: string,
) {
  if (operation === io.setup.fault) {
    io.trace.push({ call: wire(call), error: true });
    throw Error("fixture storage unavailable");
  }
  io.trace.push({ call: wire(call), result: wire(result) });
  return result;
}
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (collection: string) => ({
        findOne: async (query: unknown) =>
          recordCall(
            { collection, method: "one", query, options: {} },
            io.setup.db?.[collection] ?? null,
            collection + ".one",
          ),
        updateOne: async (
          query: unknown,
          update: unknown,
          opts?: { upsert?: boolean },
        ) =>
          recordCall(
            {
              collection,
              method: "update",
              query,
              options: { update, ...(opts?.upsert ? { upsert: true } : {}) },
            },
            {
              modifiedCount: io.setup.inserted ? 0 : 1,
              upsertedId: io.setup.inserted
                ? new ObjectId("000000000000000000000012")
                : null,
            },
            collection + ".update",
          ),
        insertOne: async (query: unknown) =>
          recordCall(
            { collection, method: "insert", query, options: {} },
            { acknowledged: true },
            collection + ".insert",
          ),
      }),
    },
  },
}));
vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: async (key: string) =>
      recordCall({ method: "get", key }, io.setup.state ?? null, "redis.get"),
  },
}));
vi.mock("../src/clients/discord.js", () => ({ discord: {} }));
vi.mock("../src/clients/telegram.js", () => ({ telegramBotService: {} }));
vi.mock("../src/utils/auth.js", () => ({
  getLinkedEpicSession: async (headers: Headers) =>
    headers.get("cookie") === "better-auth.session_token=valid"
      ? {
          epicAccountId: "fixture-owner",
          user: { email: "independent-address@fixture.invalid" },
          session: { id: "fixture-session" },
        }
      : null,
}));

it("captures verified local token and state operations through the Hono auth router", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv(
    "JWT_PUBLIC_KEY",
    fileURLToPath(
      new URL(
        "../rust/oracles/account-fixture-rsa-public.pem",
        import.meta.url,
      ),
    ),
  );
  vi.stubEnv("EPIC_CLIENT_ID", "fixture-client");
  vi.stubEnv("EPIC_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("CF_IMAGES_KEY", "fixture-images-key");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const reply = io.queue.shift();
    if (!reply) throw Error("Unexpected provider request");
    const form = init.body instanceof FormData ? init.body : null;
    const file = form?.get("file");
    io.http.push({
      request: {
        method: init.method ?? "GET",
        url: String(url),
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: form ? undefined : init.body?.toString(),
        multipart:
          file && typeof file !== "string"
            ? {
                field: "file",
                name: file.name,
                type: file.type,
                contents: await file.text(),
              }
            : undefined,
      },
      ...reply,
    });
    if (reply.unavailable) throw Error("fixture provider unavailable");
    if (reply.raw !== undefined)
      return new Response(reply.raw, { status: reply.status });
    return Response.json(reply.result, { status: reply.status });
  });
  const now = new Date("2026-06-01T12:00:00Z");
  const key = readFileSync(
    new URL("../rust/oracles/account-fixture-rsa-private.pem", import.meta.url),
  );
  const sign = (claims: Record<string, unknown>) =>
    jwt.sign({ ...claims, exp: 4102444800 }, key, {
      algorithm: "RS256",
      noTimestamp: true,
    });
  const inner = sign({
    sub: "fixture-owner",
    iss: "https://api.epicgames.dev/epic/id",
    appid: "fixture-app",
    aud: "fixture-client",
  });
  const expiresAt = new Date("2026-06-15T12:00:00Z");
  const refreshExpiresAt = new Date("2026-07-01T12:00:00Z");
  const envelope = sign({
    access_token: inner,
    refresh_token: "fixture-refresh",
    jti: "fixture-jti",
    expires_at: expiresAt.toISOString(),
    refresh_expires_at: refreshExpiresAt.toISOString(),
  });
  const active = {
    status: 200,
    result: { active: true, account_id: "fixture-owner" },
  };
  const profile = {
    accountId: "fixture-owner",
    displayName: "Fixture user",
    preferredLanguage: "en",
  };
  const app = new Hono()
    .route("/auth", auth)
    .route("/users-service", usersService);
  const cases: unknown[] = [];
  async function record(name: string, request: Input, setup: Setup = {}) {
    io.setup = setup;
    io.trace = [];
    io.http = [];
    io.queue = [...(setup.http ?? [])];
    const response = await app.request(request.path, {
      method: request.method,
      headers: request.headers,
      body: request.rawBody ?? JSON.stringify(request.body),
    });
    if (io.queue.length) throw Error("Unused provider replies: " + name);
    const expected = await captureResponse(response);
    const extra = Object.fromEntries(
      [
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-max-age",
        "vary",
      ]
        .map((k) => [k, response.headers.get(k)])
        .filter(([, v]) => v !== null),
    );
    cases.push({
      name,
      request,
      response: expected,
      cors: extra,
      trace: io.trace,
      http: io.http,
    });
  }
  const bearer = { authorization: "Bearer " + inner };
  const serviceHeaders = { authorization: "Bearer eg1~" + inner };
  for (const [method, path, body] of [
    ["GET", "/users-service", undefined],
    [
      "POST",
      "/users-service/playtime",
      [
        {
          accountId: "fixture-owner",
          artifactId: "fixture-artifact",
          totalTime: 12,
        },
        { accountId: "other-fixture", artifactId: "not-owned", totalTime: 1 },
      ],
    ],
    [
      "POST",
      "/users-service/ownership",
      [{ id: "fixture-offer", namespace: "fixture-game" }],
    ],
  ] as const) {
    const request = { method, path, body, headers: serviceHeaders };
    for (const [label, verification] of Object.entries({
      inactive: {
        status: 200,
        result: { active: false, account_id: "fixture-owner" },
      },
      mismatch: {
        status: 200,
        result: { active: true, account_id: "other-fixture" },
      },
      invalid: { status: 200, raw: "[" },
      unavailable: { status: 503, unavailable: true },
      rejected: { status: 401, result: {} },
    }))
      await record("user service " + path + " " + label, request, {
        http: [verification],
      });
    const replies =
      path === "/users-service/ownership"
        ? [
            active,
            {
              status: 200,
              result: {
                data: {
                  Entitlements: {
                    cartOffersValidation: {
                      fullyOwnedOffers: [
                        { namespace: "fixture-game", offerId: "fixture-offer" },
                      ],
                    },
                  },
                },
              },
            },
          ]
        : [active];
    await record("verified user service " + path, request, { http: replies });
  }
  const avatar = {
    method: "POST",
    path: "/auth/avatar",
    headers: {
      cookie: "better-auth.session_token=valid",
      "content-type": "multipart/form-data; boundary=fixture-boundary",
    },
    rawBody:
      '--fixture-boundary\r\nContent-Disposition: form-data; name="avatar"; filename="sample.webp"\r\nContent-Type: image/webp\r\n\r\nsynthetic fixture\r\n--fixture-boundary--\r\n',
  };
  const image = {
    status: 200,
    result: {
      result: {
        id: "fixture-image",
        variants: ["https://example.invalid/fixture"],
      },
    },
  };
  await record("linked account avatar upload", avatar, { http: [image] });
  await record("linked account avatar storage unavailable", avatar, {
    http: [image],
    fault: "epic.update",
  });
  await record("linked account image rejected", avatar, {
    http: [{ status: 400, result: { error: "fixture" } }],
  });
  await record("linked account image service unavailable", avatar, {
    http: [{ status: 503, unavailable: true }],
  });
  await record("linked account image response invalid", avatar, {
    http: [{ status: 200, raw: "[" }],
  });
  const account = { method: "GET", path: "/auth", headers: bearer };
  await record("verified account current", account, {
    db: { epic: profile },
    http: [active],
  });
  await record("verified account first lookup", account, {
    http: [active, { status: 200, result: [profile] }],
  });
  await record("verified account profile unavailable", account, {
    http: [active, { status: 200, result: [] }],
  });
  await record("verified account read unavailable", account, {
    http: [active],
    fault: "epic.one",
  });
  await record("verified account write unavailable", account, {
    http: [active, { status: 200, result: [profile] }],
    fault: "epic.insert",
  });
  await record("provider token declined", account, {
    http: [{ status: 401, result: { error: "token rejected" } }],
  });
  for (const status of [200, 503]) {
    await record("provider verification invalid JSON " + status, account, {
      http: [{ status, raw: "[" }],
    });
  }
  await record("provider token inactive", account, {
    http: [
      { status: 200, result: { active: false, account_id: "fixture-owner" } },
    ],
  });
  const refreshToken = sign({
    sub: "fixture-owner",
    iss: "fixture",
    jti: "owned-fixture-token",
  });
  const persistV1 = {
    method: "POST",
    path: "/auth/persist",
    headers: bearer,
    body: { refreshToken },
  };
  const introspected = {
    status: 200,
    result: { active: true, account_id: "fixture-owner", expires_in: 3600 },
  };
  for (const [name, upstream] of Object.entries({
    unavailable: { status: 503, unavailable: true },
    "invalid JSON": { status: 200, raw: "[" },
  })) {
    await record("verified persist access provider " + name, persistV1, {
      http: [active, upstream],
    });
    await record("verified persist refresh provider " + name, persistV1, {
      http: [active, introspected, upstream],
    });
  }
  for (const inserted of [true, false]) {
    await record(
      "verified persist " + (inserted ? "inserted" : "updated"),
      persistV1,
      { inserted, http: [active, introspected, introspected] },
    );
  }
  await record("verified persist storage unavailable", persistV1, {
    fault: "tokens.update",
    http: [active, introspected, introspected],
  });
  await record("verified persist inactive refresh", persistV1, {
    http: [
      active,
      introspected,
      {
        status: 200,
        result: { active: false, account_id: "fixture-owner", expires_in: 0 },
      },
    ],
  });
  const v2 = { authorization: "Bearer " + envelope };
  const persist = { method: "POST", path: "/auth/v2/persist", headers: v2 };
  const refresh = { method: "GET", path: "/auth/v2/refresh", headers: v2 };
  for (const [name, upstream] of Object.entries({
    "provider unavailable": { status: 503, unavailable: true },
    "invalid provider JSON": { status: 503, raw: "<upstream unavailable>" },
    "null provider response": { status: 200, result: null },
    "empty provider value": { status: 200, result: false },
    "empty provider row": { status: 200, result: [null] },
    "keyed provider row": { status: 200, result: { "0": profile } },
    "provider error object": {
      status: 503,
      result: { error: "fixture unavailable" },
    },
  })) {
    await record("verified account " + name, account, {
      http: [active, upstream],
    });
    await record("signed persist " + name, persist, { http: [upstream] });
  }
  await record("signed persist existing", persist, { db: { epic: profile } });
  await record("signed persist new", persist, {
    http: [{ status: 200, result: [profile] }],
  });
  await record("signed persist empty profile", persist, {
    http: [{ status: 200, result: [] }],
  });
  await record("signed persist token write failed", persist, {
    fault: "tokens.update",
  });
  await record("signed persist account lookup failed", persist, {
    fault: "epic.one",
  });
  await record("signed persist profile write failed", persist, {
    http: [{ status: 200, result: [profile] }],
    fault: "epic.update",
  });
  const tokens = {
    accessToken: "fixture-existing",
    refreshToken: "fixture-refresh",
    expiresAt,
    refreshExpiresAt,
  };
  await record("signed refresh current", refresh, { db: { tokens } });
  await record("signed refresh absent optional fields", refresh, {
    db: { tokens: { expiresAt } },
  });
  await record("signed refresh exact expiry", refresh, {
    db: { tokens: { ...tokens, expiresAt: now } },
  });
  await record("signed refresh missing", refresh);
  await record("signed refresh storage unavailable", refresh, {
    fault: "tokens.one",
  });
  await record("signed refresh provider declined", refresh, {
    db: { tokens: { ...tokens, expiresAt: new Date(0) } },
    http: [{ status: 401, result: { error: "fixture expired" } }],
  });
  const validate = {
    method: "POST",
    path: "/auth/v2/validate-state",
    body: { state: "LOCAL-FIXTURE" },
  };
  await record("state code present", validate, { state: "true" });
  await record("state code missing", validate);
  await record("state code empty", validate, { state: "" });
  await record("state storage unavailable", validate, { fault: "redis.get" });
  await record("state body invalid JSON", { ...validate, rawBody: "[" });
  await record("state body null", { ...validate, body: null });
  for (const origin of [
    "https://egdata.app",
    "http://localhost:3000",
    "https://example.invalid",
  ]) {
    await record("logout " + origin, {
      method: "GET",
      path: "/auth/logout",
      headers: { origin },
    });
  }
  assertOracle("legacy-auth-services-http-node", cases);
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
