import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AuthHonoEnv } from "./epic-auth.js";
import { calendarMonths } from "./privacy-retention.js";

// Mounted behind the existing live database admin-role and same-origin guards.
export const privacyRequestRoutes = new Hono<AuthHonoEnv>();
privacyRequestRoutes.use("*", bodyLimit({ maxSize: 8192 }));
privacyRequestRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
const invalid = {
  error: { code: "VALIDATION_ERROR", message: "Invalid privacy case fields." },
};
const conflict = {
  error: {
    code: "CASE_CONFLICT",
    message: "Case missing, resolved, or extension deadline passed.",
  },
};
const reference = z.string().trim().min(1).max(300);

privacyRequestRoutes.get("/", async (c) => {
  const p = z
    .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
    .safeParse(c.req.query());
  if (!p.success) return c.json(invalid, 400);
  const { results } = await c.env.DB.prepare(
    "SELECT *,COALESCE(extended_due_at,due_at) AS response_due_at FROM privacy_requests ORDER BY resolved_at IS NOT NULL,response_due_at,id LIMIT 51 OFFSET ?",
  )
    .bind(p.data.offset)
    .all();
  return c.json({
    requests: results.slice(0, 50),
    hasMore: results.length > 50,
  });
});
privacyRequestRoutes.post("/", async (c) => {
  const p = z
    .object({
      ownerId: z.string().max(128).nullable(),
      caseReference: reference,
      kind: z.enum([
        "access",
        "erasure",
        "rectification",
        "restriction",
        "objection",
        "portability",
      ]),
      receivedAt: z
        .number()
        .int()
        .nonnegative()
        .refine((t) => t <= Date.now()),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json(invalid, 400);
  const id = `privacy_${crypto.randomUUID()}`;
  const due = calendarMonths(p.data.receivedAt, 1);
  await c.env.DB.prepare(
    "INSERT INTO privacy_requests(id,owner_id,case_reference,kind,received_at,due_at,created_by) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      p.data.ownerId,
      p.data.caseReference,
      p.data.kind,
      p.data.receivedAt,
      due,
      c.get("user").epicAccountId,
    )
    .run();
  return c.json({ id, dueAt: due }, 201);
});
privacyRequestRoutes.post("/:id/extend", async (c) => {
  const p = z
    .object({
      reason: z.string().trim().min(10).max(2000),
      notifiedAt: z
        .number()
        .int()
        .nonnegative()
        .refine((t) => t <= Date.now()),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json(invalid, 400);
  const row = await c.env.DB.prepare(
    "SELECT received_at FROM privacy_requests WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{ received_at: number }>();
  if (!row) return c.json(conflict, 409);
  const result = await c.env.DB.prepare(
    "UPDATE privacy_requests SET extended_due_at=?,extension_reason=?,extension_notified_at=? WHERE id=? AND resolved_at IS NULL AND extended_due_at IS NULL AND due_at>=? AND due_at>=? AND received_at<=?",
  )
    .bind(
      calendarMonths(row.received_at, 3),
      p.data.reason,
      p.data.notifiedAt,
      c.req.param("id"),
      Date.now(),
      p.data.notifiedAt,
      p.data.notifiedAt,
    )
    .run();
  return result.meta.changes ? c.json({ ok: true }) : c.json(conflict, 409);
});
privacyRequestRoutes.post("/:id/actions", async (c) => {
  const p = z
    .object({
      store: reference,
      action: z.enum([
        "export",
        "erase",
        "rectify",
        "restrict",
        "notify-recipient",
        "restore-suppression",
        "review-hold",
      ]),
      evidenceReference: reference,
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json(invalid, 400);
  const result = await c.env.DB.prepare(
    "INSERT INTO privacy_actions(id,request_id,store,action,completed_at,actor,evidence_reference) SELECT ?,id,?,?,?,?,? FROM privacy_requests WHERE id=? AND resolved_at IS NULL",
  )
    .bind(
      crypto.randomUUID(),
      p.data.store,
      p.data.action,
      Date.now(),
      c.get("user").epicAccountId,
      p.data.evidenceReference,
      c.req.param("id"),
    )
    .run();
  return result.meta.changes
    ? c.json({ ok: true }, 201)
    : c.json(conflict, 409);
});
privacyRequestRoutes.get("/:id/actions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM privacy_actions WHERE request_id=? ORDER BY completed_at,id LIMIT 500",
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ actions: results });
});
privacyRequestRoutes.post("/:id/resolve", async (c) => {
  const p = z
    .object({ resolution: z.string().trim().min(10).max(2000) })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json(invalid, 400);
  const result = await c.env.DB.prepare(
    "UPDATE privacy_requests SET resolved_at=?,resolution=? WHERE id=? AND resolved_at IS NULL",
  )
    .bind(Date.now(), p.data.resolution, c.req.param("id"))
    .run();
  return result.meta.changes ? c.json({ ok: true }) : c.json(conflict, 409);
});
