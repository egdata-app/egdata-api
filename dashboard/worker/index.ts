import { Hono } from "hono";
import { z } from "zod";
import { queryDashboardAnalytics, recordApiTelemetry } from "./analytics.js";
import { generateApiKeySecret, sha256Hex } from "./crypto.js";
import {
  createProject,
  insertApiKey,
  insertLimitRequest,
  listUserApiKeys,
  listUserLimitRequests,
  listUserProjects,
  revokeAndDeleteApiKey,
  updateApiKeyPermissions,
  updateProject,
  upsertEpicUserAndDefaultProject,
} from "./db.js";
import { sendLimitIncreaseRequestEmail } from "./email.js";
import {
  clearDashboardSessionCookie,
  handleEpicOAuthCallback,
  readDashboardSession,
  requireDashboardUser,
  startEpicOAuthRedirect,
} from "./epic-auth.js";
import { removeKeyFromKv, syncKeyToKv } from "./key-cache.js";
import { isValidIpOrCidr } from "./permissions.js";
import { handleEdgeApiProxy } from "./proxy.js";
import {
  type AllowedHttpMethod,
  API_SCOPES,
  type ApiScope,
  type CachedKeyMetadata,
  type DashboardEnv,
  type EpicSessionUser,
  HTTP_METHODS,
} from "./types.js";

type AppContext = {
  Bindings: DashboardEnv;
  Variables: {
    user: EpicSessionUser;
  };
};

const dashboardApi = new Hono<AppContext>();

dashboardApi.use("/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// ---------------------------------------------------------
// Epic Games Authentication Routes
// ---------------------------------------------------------
dashboardApi.get("/auth/epic/login", (c) => startEpicOAuthRedirect(c));
dashboardApi.get("/auth/epic/callback", (c) => handleEpicOAuthCallback(c));

dashboardApi.post("/auth/logout", (c) => {
  clearDashboardSessionCookie(c);
  return c.json({ ok: true });
});

dashboardApi.get("/auth/session", async (c) => {
  const user = await readDashboardSession(c);
  const isLocal =
    c.req.url.includes("localhost") ||
    c.req.url.includes("127.0.0.1") ||
    c.env.ENABLE_DEV_AUTH === "true";
  const hasEpicCredentials = Boolean(
    c.env.EPIC_CLIENT_ID && c.env.EPIC_CLIENT_SECRET,
  );

  if (!user) {
    return c.json({
      authenticated: false,
      user: null,
      projects: [],
      oauthConfigured: hasEpicCredentials,
      devAuthAvailable: !hasEpicCredentials && isLocal,
    });
  }

  const projects = await upsertEpicUserAndDefaultProject(c.env.DB, user);
  return c.json({
    authenticated: true,
    user,
    projects,
    oauthConfigured: hasEpicCredentials,
    devAuthAvailable: !hasEpicCredentials && isLocal,
  });
});

// ---------------------------------------------------------
// Protected Dashboard Routes (Require Epic Games Session)
// ---------------------------------------------------------
dashboardApi.use("/projects/*", requireDashboardUser);
dashboardApi.use("/projects", requireDashboardUser);
dashboardApi.use("/keys/*", requireDashboardUser);
dashboardApi.use("/keys", requireDashboardUser);
dashboardApi.use("/analytics/*", requireDashboardUser);
dashboardApi.use("/analytics", requireDashboardUser);
dashboardApi.use("/limit-requests/*", requireDashboardUser);
dashboardApi.use("/limit-requests", requireDashboardUser);

const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(64),
  description: z.string().trim().max(240).optional().default(""),
  websiteUrl: z.string().trim().max(200).optional().default(""),
});

dashboardApi.get("/projects", async (c) => {
  const user = c.get("user");
  const projects = await listUserProjects(c.env.DB, user.epicAccountId);
  return c.json({ projects });
});

dashboardApi.post("/projects", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: { code: "VALIDATION_ERROR", message: "Invalid project fields." },
      },
      400,
    );
  }

  const existing = await listUserProjects(c.env.DB, user.epicAccountId);
  if (existing.length >= 10) {
    return c.json(
      {
        error: {
          code: "PROJECT_LIMIT_REACHED",
          message: "Maximum of 10 projects per account.",
        },
      },
      400,
    );
  }

  const slug =
    parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";

  const project = await createProject(c.env.DB, {
    ownerEpicId: user.epicAccountId,
    name: parsed.data.name,
    slug,
    description: parsed.data.description,
    websiteUrl: parsed.data.websiteUrl,
  });

  return c.json({ project }, 201);
});

dashboardApi.patch("/projects/:projectId", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const body = await c.req.json().catch(() => null);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: { code: "VALIDATION_ERROR", message: "Invalid project fields." },
      },
      400,
    );
  }

  const updated = await updateProject(
    c.env.DB,
    user.epicAccountId,
    projectId,
    parsed.data,
  );
  if (!updated) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Project not found." } },
      404,
    );
  }

  return c.json({ project: updated });
});

// ---------------------------------------------------------
// API Keys CRUD & Fine-Grained Permissions
// ---------------------------------------------------------
const permissionsFields = {
  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1, "Select at least one permission scope")
    .default([...API_SCOPES]),
  allowedIps: z
    .array(z.string().trim().min(1).max(64))
    .max(50)
    .default([])
    .refine((ips) => ips.every((ip) => isValidIpOrCidr(ip)), {
      message:
        "Each IP rule must be a valid IPv4/IPv6 address or CIDR range (e.g. 203.0.113.0/24).",
    }),
  allowedOrigins: z
    .array(z.string().trim().min(1).max(200))
    .max(50)
    .default([]),
  allowedPaths: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  allowedMethods: z
    .array(z.enum(HTTP_METHODS))
    .min(1, "Select at least one allowed HTTP method")
    .default(["GET", "HEAD"]),
  expiresAt: z.string().datetime().nullable().optional().default(null),
};

const createKeySchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(2).max(64),
  ...permissionsFields,
});

const updateKeySchema = z.object({
  name: z.string().trim().min(2).max(64).optional(),
  active: z.boolean().optional(),
  scopes: permissionsFields.scopes.optional(),
  allowedIps: permissionsFields.allowedIps.optional(),
  allowedOrigins: permissionsFields.allowedOrigins.optional(),
  allowedPaths: permissionsFields.allowedPaths.optional(),
  allowedMethods: permissionsFields.allowedMethods.optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

dashboardApi.get("/keys", async (c) => {
  const user = c.get("user");
  const projectId = c.req.query("projectId") || undefined;
  const keys = await listUserApiKeys(c.env.DB, user.epicAccountId, projectId);
  return c.json({ keys });
});

dashboardApi.post("/keys", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue =
      parsed.error.issues[0]?.message || "Invalid API key configuration.";
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: firstIssue } },
      400,
    );
  }

  const projects = await listUserProjects(c.env.DB, user.epicAccountId);
  const project = projects.find((p) => p.id === parsed.data.projectId);
  if (!project) {
    return c.json(
      { error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } },
      404,
    );
  }

  const existingKeys = await listUserApiKeys(
    c.env.DB,
    user.epicAccountId,
    project.id,
  );
  if (existingKeys.length >= 25) {
    return c.json(
      {
        error: {
          code: "KEY_LIMIT_REACHED",
          message: "Maximum of 25 active keys per project.",
        },
      },
      400,
    );
  }

  const { rawKey, keyPrefix } = generateApiKeySecret();
  const keyHash = await sha256Hex(rawKey);
  const id = `key_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const created = await insertApiKey(c.env.DB, {
    id,
    projectId: project.id,
    ownerEpicId: user.epicAccountId,
    name: parsed.data.name,
    keyPrefix,
    keyHash,
    tier: project.tier,
    scopes: parsed.data.scopes as ApiScope[],
    allowedIps: parsed.data.allowedIps,
    allowedOrigins: parsed.data.allowedOrigins,
    allowedPaths: parsed.data.allowedPaths,
    allowedMethods: parsed.data.allowedMethods as AllowedHttpMethod[],
    expiresAt: parsed.data.expiresAt ?? null,
  });

  const cachedMeta: CachedKeyMetadata = {
    keyId: created.id,
    projectId: created.projectId,
    ownerEpicId: created.ownerEpicId,
    name: created.name,
    tier: created.tier,
    active: true,
    scopes: created.scopes,
    allowedIps: created.allowedIps,
    allowedOrigins: created.allowedOrigins,
    allowedPaths: created.allowedPaths,
    allowedMethods: created.allowedMethods,
    customRpm: created.customRpm,
    expiresAt: created.expiresAt,
  };

  await syncKeyToKv(c.env, keyHash, cachedMeta);

  return c.json(
    {
      key: created,
      secret: rawKey,
    },
    201,
  );
});

dashboardApi.patch("/keys/:keyId", async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("keyId");
  const body = await c.req.json().catch(() => null);
  const parsed = updateKeySchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue =
      parsed.error.issues[0]?.message || "Invalid permission settings.";
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: firstIssue } },
      400,
    );
  }

  const result = await updateApiKeyPermissions(
    c.env.DB,
    user.epicAccountId,
    keyId,
    {
      name: parsed.data.name,
      active: parsed.data.active,
      scopes: parsed.data.scopes as ApiScope[] | undefined,
      allowedIps: parsed.data.allowedIps,
      allowedOrigins: parsed.data.allowedOrigins,
      allowedPaths: parsed.data.allowedPaths,
      allowedMethods: parsed.data.allowedMethods as
        | AllowedHttpMethod[]
        | undefined,
      expiresAt: parsed.data.expiresAt,
    },
  );

  if (!result) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "API key not found." } },
      404,
    );
  }

  if (result.updated.active) {
    await syncKeyToKv(c.env, result.keyHash, result.cached);
  } else {
    await removeKeyFromKv(c.env, result.keyHash);
  }

  return c.json({ key: result.updated });
});

dashboardApi.delete("/keys/:keyId", async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("keyId");
  const revoked = await revokeAndDeleteApiKey(
    c.env.DB,
    user.epicAccountId,
    keyId,
  );
  if (!revoked) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "API key not found." } },
      404,
    );
  }

  await removeKeyFromKv(c.env, revoked.keyHash);
  return c.json({ ok: true, id: keyId });
});

// ---------------------------------------------------------
// Analytics Queries + Demo Traffic Seeder (for local testing)
// ---------------------------------------------------------
dashboardApi.get("/analytics", async (c) => {
  const user = c.get("user");
  const rangeHours = Number(c.req.query("hours") || "24");
  const projectId = c.req.query("projectId") || undefined;
  const keyId = c.req.query("keyId") || undefined;

  const summary = await queryDashboardAnalytics(c.env, {
    ownerEpicId: user.epicAccountId,
    projectId,
    keyId,
    rangeHours,
  });

  return c.json(summary);
});

dashboardApi.post("/analytics/simulate", async (c) => {
  const user = c.get("user");
  const keys = await listUserApiKeys(c.env.DB, user.epicAccountId);
  const sampleKey = keys[0];
  if (!sampleKey) {
    return c.json(
      {
        error: {
          code: "NO_KEYS",
          message: "Create an API key first to simulate traffic.",
        },
      },
      400,
    );
  }

  const routes = [
    "/offers/{id}",
    "/search/v2/search",
    "/free-games",
    "/offers/top-sellers",
    "/items/{id}",
    "/graphql",
  ];
  const statuses = [
    { status: 200, cache: "HIT", outcome: "ok" },
    { status: 200, cache: "HIT", outcome: "ok" },
    { status: 200, cache: "HIT", outcome: "ok" },
    { status: 200, cache: "MISS", outcome: "ok" },
    { status: 304, cache: "REVALIDATED", outcome: "ok" },
    { status: 429, cache: "EDGE_BLOCK", outcome: "rate_limited" },
    { status: 403, cache: "EDGE_BLOCK", outcome: "origin_denied" },
  ];
  const origins = [
    "https://egdata.app",
    "https://tracker.example.dev",
    "(direct)",
  ];
  const ips = ["203.0.113.42", "198.51.100.17", "192.0.2.88"];
  const uas = [
    "egdata-sdk-js/2.1.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Chrome/131.0",
    "PriceBot/1.4 (+https://tracker.example.dev)",
  ];

  for (let i = 0; i < 36; i++) {
    const pick = statuses[i % statuses.length];
    recordApiTelemetry(c.env, {
      ownerEpicId: user.epicAccountId,
      keyId: sampleKey.id,
      projectId: sampleKey.projectId,
      routeTemplate: routes[i % routes.length],
      method: "GET",
      statusCode: pick.status,
      cacheStatus: pick.cache,
      limitOutcome: pick.outcome,
      origin: origins[i % origins.length],
      clientIp: ips[i % ips.length],
      userAgent: uas[i % uas.length],
      country: i % 2 === 0 ? "US" : "ES",
      latencyMs: pick.cache === "HIT" ? 2 + (i % 5) : 38 + (i % 40),
    });
  }

  return c.json({ ok: true, generated: 36 });
});

// ---------------------------------------------------------
// Rate Limit Increase Request + Cloudflare Email Sending
// ---------------------------------------------------------
const limitRequestSchema = z.object({
  projectId: z.string().min(1),
  contactEmail: z.string().email("Enter a valid contact email address."),
  requestedTier: z.enum(["pro", "enterprise", "custom"]),
  requestedRpm: z.number().int().min(150).max(500_000),
  expectedMonthlyRequests: z.number().int().min(10_000).max(10_000_000_000),
  websiteUrl: z.string().trim().max(200).optional().default(""),
  useCase: z
    .string()
    .trim()
    .min(
      20,
      "Describe your integration and expected traffic patterns (at least 20 characters).",
    )
    .max(3000),
});

dashboardApi.get("/limit-requests", async (c) => {
  const user = c.get("user");
  const requests = await listUserLimitRequests(c.env.DB, user.epicAccountId);
  return c.json({ requests });
});

dashboardApi.post("/limit-requests", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const parsed = limitRequestSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue =
      parsed.error.issues[0]?.message || "Invalid request payload.";
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: firstIssue } },
      400,
    );
  }

  const projects = await listUserProjects(c.env.DB, user.epicAccountId);
  const project = projects.find((p) => p.id === parsed.data.projectId);
  if (!project) {
    return c.json(
      { error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } },
      404,
    );
  }

  const tempId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const emailResult = await sendLimitIncreaseRequestEmail(c.env, {
    requestId: tempId,
    user,
    project,
    contactEmail: parsed.data.contactEmail,
    requestedTier: parsed.data.requestedTier,
    requestedRpm: parsed.data.requestedRpm,
    expectedMonthlyRequests: parsed.data.expectedMonthlyRequests,
    useCase: parsed.data.useCase,
    websiteUrl: parsed.data.websiteUrl,
  });

  const saved = await insertLimitRequest(c.env.DB, {
    ownerEpicId: user.epicAccountId,
    projectId: project.id,
    contactEmail: parsed.data.contactEmail,
    requestedTier: parsed.data.requestedTier,
    requestedRpm: parsed.data.requestedRpm,
    expectedMonthlyRequests: parsed.data.expectedMonthlyRequests,
    useCase: parsed.data.useCase,
    websiteUrl: parsed.data.websiteUrl,
    emailDeliveryStatus: emailResult.status,
  });

  return c.json({ request: saved, emailDelivery: emailResult }, 201);
});

// ---------------------------------------------------------
// Top-Level Worker Entrypoint: Dual-Mode Edge Gateway + Dashboard SPA
// ---------------------------------------------------------
const rootApp = new Hono<AppContext>();

rootApp.route("/_dashboard/api", dashboardApi);

export default {
  async fetch(
    request: Request,
    env: DashboardEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // 1. Dashboard internal API & Epic OAuth callbacks
    if (
      url.pathname === "/_dashboard/api" ||
      url.pathname.startsWith("/_dashboard/api/")
    ) {
      return rootApp.fetch(request, env, ctx);
    }

    // 2. Local/Explicit `/proxy/*` testing path -> Edge API Key Gateway
    if (url.pathname === "/proxy" || url.pathname.startsWith("/proxy/")) {
      return handleEdgeApiProxy(request, env, ctx, { stripPrefix: "/proxy" });
    }

    // 3. When deployed directly on `api.egdata.app`, intercept ALL traffic at the edge!
    if (
      env.API_PROXY_HOST &&
      url.hostname.toLowerCase() === env.API_PROXY_HOST.toLowerCase()
    ) {
      return handleEdgeApiProxy(request, env, ctx);
    }

    // 4. Otherwise serve the Developer Dashboard SPA static assets
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
