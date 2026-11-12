import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_HEADER, CONSOLE_TTL_MS } from "../worker/console-sessions";
import { signHmacToken } from "../worker/crypto";
import worker from "../worker/index";
import type { DashboardEnv } from "../worker/types";
import { resolveV1Route } from "../worker/v1-routes";
import { generatedV1Routes } from "../worker/v1-routes.generated";
import { sqliteD1 } from "./fixtures/sqlite";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  const { db, sqlite } = sqliteD1();
  for (const file of [
    "0001_initial.sql",
    "0002_endpoint_alerts.sql",
    "0003_console_sessions.sql",
    "0004_limit_request_reviews.sql",
    "0005_dashboard_session_revocations.sql",
  ])
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  sqlite.exec(
    "INSERT INTO users(epic_account_id,display_name) VALUES('alice','Alice'),('bob','Bob'); INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('prj_a','alice','A','a'),('prj_b','bob','B','b');",
  );
  const secret = "test-dashboard-session-secret-at-least-32";
  const login = async (id: string, iat = Date.now()) =>
    `egdata_dash_session=${await signHmacToken({ user: { epicAccountId: id, displayName: id }, iat, exp: iat + 86400000 }, secret)}`;
  const cookie = await login("alice");
  const used = new Map<string, number>();
  const admit = vi.fn(
    async (input: {
      keyId: string;
      projectId: string;
      policies: Array<{ name: string; limit: number }>;
      usage?: unknown;
    }) => {
      const n = (used.get(input.projectId) ?? 0) + 1;
      used.set(input.projectId, n);
      const allowed = n <= 2;
      return {
        allowed,
        retryAfter: 60,
        exhaustedPolicy: allowed ? null : "global",
        policies: input.policies.map((p) => ({
          ...p,
          remaining: Math.max(0, p.limit - n),
          resetAt: Date.now() + 60000,
        })),
      };
    },
  );
  const telemetry = vi.fn();
  const env = {
    DB: db,
    DASHBOARD_SESSION_SECRET: secret,
    DASHBOARD_ORIGIN: "https://devs.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    ORIGIN_AUTH_TOKEN: "origin-test",
    RATE_LIMIT_ENVIRONMENT: "test",
    USAGE_TRACKING_ENABLED: "true",
    ANALYTICS: { writeDataPoint: telemetry },
    API_KEYS_KV: { get: vi.fn(async () => null) },
    API_KEY_RATE_LIMITER: {
      idFromName: vi.fn((n) => n),
      get: vi.fn(() => ({ admit })),
    },
  } as unknown as DashboardEnv;
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  const upstream = vi.fn(
    async (_url: string, init: RequestInit) =>
      new Response(
        JSON.stringify({
          headers: Object.fromEntries(new Headers(init.headers)),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", upstream);
  function request(path: string, init: RequestInit = {}) {
    return worker.fetch(
      new Request(`https://devs.egdata.app${path}`, {
        ...init,
        headers: {
          cookie,
          origin: "https://devs.egdata.app",
          "Sec-Fetch-Site": "same-origin",
          ...init.headers,
        },
      }),
      env,
      ctx,
    );
  }
  async function start(
    project = "prj_a",
    headers: Record<string, string> = {},
  ) {
    const r = await request(`/_dashboard/api/console-sessions/${project}`, {
      method: "POST",
      headers,
    });
    return {
      response: r,
      ...((await r.json()) as {
        token: string;
        expiresAt: number;
        projectId: string;
      }),
    };
  }
  const run = (
    token: string,
    headers: Record<string, string> = {},
    path = "/proxy/v1/offers/genres",
  ) => request(path, { headers: { [CONSOLE_HEADER]: token, ...headers } });
  return {
    env,
    sqlite,
    login,
    cookie,
    start,
    run,
    request,
    upstream,
    admit,
    telemetry,
    ctx,
  };
}

describe("project console credentials", () => {
  it("uses the project's approved custom limit without renewing the console session", async () => {
    const s = await setup();
    const session = await s.start();
    s.sqlite.exec(
      "UPDATE projects SET tier='enterprise',custom_rpm=4321 WHERE id='prj_a'",
    );
    expect((await s.run(session.token)).status).toBe(200);
    expect(s.admit.mock.calls[0][0].policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "global", limit: 4321 }),
      ]),
    );
  });
  it("attributes every registered concrete route to its own operation", () => {
    for (const route of generatedV1Routes) {
      const path = route.path.replace(/\{[^}]+\}/g, "example-id");
      for (const method of route.methods) {
        expect(
          resolveV1Route(path, method)?.operationId,
          `${method} ${path}`,
        ).toBe(route.operationId);
      }
    }
  });
  it("requires an owned project, live login and same-origin browser context to create a session", async () => {
    const s = await setup();
    expect((await s.start("prj_b")).response.status).toBe(404);
    expect((await s.start("prj_a", { cookie: "" })).response.status).toBe(401);
    expect(
      (await s.start("prj_a", { origin: "https://evil.example" })).response
        .status,
    ).toBe(403);
    expect(
      (await s.start("prj_a", { "Sec-Fetch-Site": "cross-site" })).response
        .status,
    ).toBe(403);
    const issued = await s.start();
    expect(issued.response.status).toBe(201);
    expect(issued.response.headers.get("cache-control")).toBe("no-store");
    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(CONSOLE_TTL_MS);
    expect(
      JSON.stringify(s.sqlite.prepare("SELECT * FROM console_sessions").all()),
    ).not.toContain(issued.token);
    expect(s.sqlite.prepare("SELECT COUNT(*) n FROM api_keys").get()?.n).toBe(
      0,
    );
  });

  it("attributes usage to the project, strips secrets and keeps quotas stable across renewal", async () => {
    const s = await setup();
    const first = await s.start();
    const r = await s.run(first.token);
    expect(r.status).toBe(200);
    const data = (await r.json()) as { headers: Record<string, string> };
    expect(data.headers[CONSOLE_HEADER.toLowerCase()]).toBeUndefined();
    expect(data.headers.cookie).toBeUndefined();
    expect(data.headers["x-egdata-key-id"]).toBe("console_prj_a");
    expect(data.headers["x-egdata-key-project"]).toBe("prj_a");
    expect(s.admit.mock.calls[0][0].usage).toEqual({
      projectId: "prj_a",
      operationId: "listOfferGenres",
    });
    expect(s.telemetry.mock.calls[0][0].blobs.slice(0, 2)).toEqual([
      "console_prj_a",
      "prj_a",
    ]);
    const second = await s.start();
    expect((await s.run(first.token)).status).toBe(401);
    expect((await s.run(second.token)).status).toBe(200);
    const third = await s.start();
    expect((await s.run(third.token)).status).toBe(429);
    expect(s.upstream).toHaveBeenCalledTimes(2);
    expect(s.env.API_KEY_RATE_LIMITER.idFromName).toHaveBeenLastCalledWith(
      "project:test:prj_a",
    );
  });

  it("rejects a copied token outside its browser login, dashboard host, and v1 console", async () => {
    const s = await setup();
    const { token } = await s.start();
    const rejectedHeaders: Record<string, string>[] = [
      { cookie: "" },
      { cookie: await s.login("bob") },
      { cookie: await s.login("alice", Date.now() + 1) },
      { "Sec-Fetch-Site": "cross-site" },
      { origin: "https://evil.example" },
      { "X-API-Key": "egk_other" },
    ];
    for (const headers of rejectedHeaders) {
      expect((await s.run(token, headers)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await s.run(token, {}, "/proxy/offers/genres")).status).toBe(403);
    expect(
      (
        await worker.fetch(
          new Request("https://api.egdata.app/proxy/v1/offers/genres", {
            headers: {
              [CONSOLE_HEADER]: token,
              cookie: s.cookie,
              origin: "https://devs.egdata.app",
              "Sec-Fetch-Site": "same-origin",
            },
          }),
          s.env,
          s.ctx,
        )
      ).status,
    ).toBe(403);
    expect((await s.run(token, {}, "/proxy/v1/not-registered")).status).toBe(
      404,
    );
    expect(s.admit).not.toHaveBeenCalled();
  });

  it("expires at ten minutes and rejects removed ownership without quota admission", async () => {
    const s = await setup();
    const issued = await s.start();
    vi.spyOn(Date, "now").mockReturnValue(issued.expiresAt);
    expect((await s.run(issued.token)).status).toBe(401);
    vi.restoreAllMocks();
    const renewed = await s.start();
    s.sqlite.exec("UPDATE projects SET owner_epic_id='bob' WHERE id='prj_a'");
    expect((await s.run(renewed.token)).status).toBe(401);
    expect(s.admit).not.toHaveBeenCalled();
  });

  it("ends a session without allowing a delayed end request to delete its replacement; logout revokes it", async () => {
    const s = await setup();
    const old = await s.start();
    const fresh = await s.start();
    await s.request("/_dashboard/api/console-sessions/prj_a", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: old.token }),
    });
    expect((await s.run(fresh.token)).status).toBe(200);
    await s.request("/_dashboard/api/console-sessions/prj_a", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fresh.token }),
    });
    expect((await s.run(fresh.token)).status).toBe(401);
    const last = await s.start();
    expect(
      (await s.request("/_dashboard/api/auth/logout", { method: "POST" }))
        .status,
    ).toBe(200);
    expect((await s.run(last.token)).status).toBe(401);
  });
});
