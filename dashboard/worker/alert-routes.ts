import { Hono } from "hono";
import { z } from "zod";
import { requireDashboardUser } from "./epic-auth.js";
import {
  signHmacToken,
  verifyHmacToken,
  timingSafeStringEqual,
} from "./crypto.js";
import {
  importMergedRecord,
  listAlerts,
  markAllRead,
  markRead,
  mergeLabel,
  projectOwned,
} from "./endpoint-alerts.js";
import type { DashboardEnv, EpicSessionUser } from "./types.js";

type Context = { Bindings: DashboardEnv; Variables: { user: EpicSessionUser } };

export const alertRoutes = new Hono<Context>();

alertRoutes.use("/*", requireDashboardUser);

alertRoutes.use("/:projectId/*", async (c, next) => {
  if (
    !(await projectOwned(
      c.env.DB,
      c.req.param("projectId")!,
      c.get("user").epicAccountId,
    ))
  ) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Project not found." } },
      404,
    );
  }
  c.header("Cache-Control", "no-store");
  if (
    c.req.method !== "GET" &&
    c.req.header("origin") !== new URL(c.req.url).origin
  ) {
    return c.json(
      {
        error: {
          code: "ORIGIN_DENIED",
          message: "Same-origin request required.",
        },
      },
      403,
    );
  }
  await next();
});

const filterSchema = z.object({
  unread: z.enum(["true", "false"]).optional(),
  endpoint: z
    .string()
    .regex(/^[A-Za-z][\w.-]*$/)
    .optional(),
  type: z
    .enum(["added", "changed", "fixed", "deprecated", "removed", "security"])
    .optional(),
  compatibility: z.enum(["breaking", "compatible"]).optional(),
  before: z.coerce.number().int().positive().optional(),
});

alertRoutes.get("/:projectId/inbox", async (c) => {
  const filters = filterSchema.safeParse(c.req.query());
  if (!filters.success) {
    return c.json({ error: { message: "Invalid filters" } }, 400);
  }
  const projectId = c.req.param("projectId");
  const userId = c.get("user").epicAccountId;
  const data = await listAlerts(c.env.DB, projectId, userId, {
    ...filters.data,
    unread: filters.data.unread === "true",
  });
  if (!c.env.DASHBOARD_SESSION_SECRET) {
    return c.json({ error: { message: "Session signing unavailable" } }, 503);
  }
  const cutoffToken = await signHmacToken(
    {
      projectId,
      userId,
      cutoff: data.cutoff,
      expiresAt: Date.now() + 15 * 60_000,
    },
    c.env.DASHBOARD_SESSION_SECRET,
  );
  const failures = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM tracking_health WHERE id LIKE 'outbox:%' OR id = 'deadLetter'`,
  ).first<{ count: number }>();
  return c.json({
    ...data,
    cutoffToken,
    trackingStartedAt: c.env.USAGE_TRACKING_STARTED_AT || null,
    trackingEnabled: c.env.USAGE_TRACKING_ENABLED === "true",
    trackingDegraded: (failures?.count ?? 0) > 0,
    label: mergeLabel,
  });
});

alertRoutes.post("/:projectId/read-all", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !c.env.DASHBOARD_SESSION_SECRET ||
    typeof body?.cutoffToken !== "string"
  ) {
    return c.json({ error: { message: "Valid cutoff token required" } }, 400);
  }
  const token = await verifyHmacToken<{
    projectId: string;
    userId: string;
    cutoff: number;
    expiresAt: number;
  }>(body.cutoffToken, c.env.DASHBOARD_SESSION_SECRET);
  if (
    !token ||
    token.projectId !== c.req.param("projectId") ||
    token.userId !== c.get("user").epicAccountId ||
    !Number.isSafeInteger(token.cutoff) ||
    token.cutoff < 0 ||
    token.expiresAt < Date.now()
  ) {
    return c.json({ error: { message: "Invalid or expired cutoff" } }, 400);
  }
  await markAllRead(c.env.DB, token.projectId, token.userId, token.cutoff);
  return c.json({ ok: true });
});

alertRoutes.post("/:projectId/:recordId/read", async (c) => {
  await markRead(
    c.env.DB,
    c.req.param("projectId"),
    c.get("user").epicAccountId,
    c.req.param("recordId"),
  );
  return c.json({ ok: true });
});

alertRoutes.get("/:projectId/keys/:keyId", async (c) => {
  const key = await c.env.DB.prepare(
    `SELECT id, name, key_prefix AS keyPrefix, revoked_at AS revokedAt, active
       FROM api_keys
      WHERE id = ? AND project_id = ?`,
  )
    .bind(c.req.param("keyId"), c.req.param("projectId"))
    .first<{
      id: string;
      name: string;
      keyPrefix: string;
      revokedAt: string | null;
      active: number;
    }>();
  if (!key) {
    return c.json({ error: { message: "Key not found in this project" } }, 404);
  }
  return c.json({ key });
});

const endpointSchema = z
  .object({
    apiVersion: z.enum(["legacy", "v1"]),
    operationId: z.string().regex(/^[A-Za-z][\w.-]*$/),
    method: z.enum([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]),
    path: z.string().regex(/^\/[^*?:]*$/),
    status: z.enum(["active", "removed"]),
    sources: z.array(z.string()).optional(),
  })
  .strict();

const publicationSchema = z
  .object({
    mergeCommit: z.string().regex(/^[a-f0-9]{40}$/),
    mergedAt: z.number().int().nonnegative(),
    endpoints: z.array(endpointSchema).max(2000),
    records: z
      .array(
        z
          .object({
            record: z.unknown(),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            mergeCommit: z.string().regex(/^[a-f0-9]{40}$/),
            mergedAt: z.number().int(),
          })
          .strict(),
      )
      .max(25),
  })
  .strict();

export async function handleChangeIngestion(
  request: Request,
  env: DashboardEnv,
) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (
    !env.CHANGELOG_INGEST_TOKEN ||
    !timingSafeStringEqual(token, env.CHANGELOG_INGEST_TOKEN)
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Bound the streamed input, regardless of Content-Length or chunked transfer.
  const reader = request.body?.getReader();
  if (!reader) return new Response("Body required", { status: 400 });

  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2_000_000) {
      await reader.cancel();
      return new Response("Too large", { status: 413 });
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  let json: unknown;
  try {
    json = JSON.parse(text || "null");
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (
    json &&
    typeof json === "object" &&
    Object.keys(json).length === 1 &&
    "action" in json &&
    json.action === "receipts"
  ) {
    const receipts = await env.DB.prepare(
      `SELECT id, content_hash AS contentHash FROM change_records WHERE import_complete = 1`,
    ).all<{ id: string; contentHash: string }>();
    return Response.json(
      { receipts: receipts.results },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = publicationSchema.safeParse(json);
  if (!parsed.success) {
    return new Response("Invalid publication", { status: 400 });
  }

  try {
    const { validateChangeRecord } = await import("./change-validation.js");
    const endpoints = new Map(
      parsed.data.endpoints.map((e) => [`${e.apiVersion}:${e.operationId}`, e]),
    );
    if (parsed.data.mergedAt > Date.now() + 60_000) {
      throw new Error("Invalid registry merge timestamp");
    }
    if (endpoints.size !== parsed.data.endpoints.length) {
      throw new Error("Duplicate endpoint IDs");
    }

    const registered = await env.DB.prepare(
      `SELECT endpoint_key, method, path FROM endpoint_registry`,
    ).all<{ endpoint_key: string; method: string; path: string }>();
    for (const stored of registered.results) {
      const proposed = endpoints.get(stored.endpoint_key);
      if (
        proposed &&
        (proposed.method !== stored.method || proposed.path !== stored.path)
      ) {
        throw new Error("Endpoint identity conflict");
      }
    }

    for (const item of parsed.data.records) {
      const record = validateChangeRecord(item.record);
      if (
        record.corrects &&
        !parsed.data.records.some(
          (r) => (r.record as { id?: string })?.id === record.corrects,
        ) &&
        !(await env.DB.prepare(`SELECT id FROM change_records WHERE id = ?`)
          .bind(record.corrects)
          .first())
      ) {
        throw new Error("Unknown correction reference");
      }
      for (const e of record.endpoints) {
        const entry = endpoints.get(`${e.apiVersion}:${e.operationId}`);
        if (!entry || entry.method !== e.method || entry.path !== e.path) {
          throw new Error("Unknown endpoint identity");
        }
        for (const ref of [e.replaces, e.replacement]) {
          if (
            ref &&
            (!endpoints.has(ref) || ref === `${e.apiVersion}:${e.operationId}`)
          ) {
            throw new Error("Unknown replacement identity");
          }
        }
      }
      await importMergedRecord(env.DB, { ...item, record });
    }

    // Status reflects merged history only; deployed executability comes from the live contract.
    await env.DB.batch(
      [...endpoints].map(([key, e]) =>
        env.DB.prepare(
          `INSERT INTO endpoint_registry
             (endpoint_key, api_version, operation_id, method, path, status, last_merged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint_key) DO UPDATE SET
             status = excluded.status,
             last_merged_at = excluded.last_merged_at
           WHERE excluded.last_merged_at >= last_merged_at`,
        ).bind(
          key,
          e.apiVersion,
          e.operationId,
          e.method,
          e.path,
          e.status,
          parsed.data.mergedAt,
        ),
      ),
    );
    return Response.json(
      { ok: true, imported: parsed.data.records.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "change_import_failed",
        message: error instanceof Error ? error.message : "invalid",
      }),
    );
    return new Response("Publication rejected", { status: 409 });
  }
}

export async function publicHistory(env: DashboardEnv) {
  const records = await env.DB.prepare(
    `SELECT record_json, merge_commit, merged_at
       FROM change_records
      WHERE import_complete = 1
      ORDER BY merged_at DESC, id`,
  ).all<{ record_json: string; merge_commit: string; merged_at: number }>();
  const endpoints = await env.DB.prepare(
    `SELECT api_version AS apiVersion,
            operation_id AS operationId,
            method,
            path,
            status
       FROM endpoint_registry
      ORDER BY api_version, operation_id`,
  ).all();
  return Response.json(
    {
      endpoints: endpoints.results,
      records: records.results.map((r) => ({
        record: JSON.parse(r.record_json),
        mergeCommit: r.merge_commit,
        mergedAt: r.merged_at,
      })),
      label: mergeLabel,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
