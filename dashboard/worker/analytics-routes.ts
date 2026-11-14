import { Hono } from "hono";
import { z } from "zod";
import { queryDashboardAnalytics, queryUsageTable } from "./analytics.js";
import { requireDashboardUser } from "./epic-auth.js";
import { isDashboardAdmin } from "./limit-reviews.js";
import type { DashboardEnv, EpicSessionUser } from "./types.js";

const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9_.:@-]{1,96}$/)
  .optional();
const isoTimestamp = z.iso
  .datetime()
  .refine(
    (value) =>
      Date.parse(value) <= Date.now() + 60_000 &&
      Date.parse(value) >= Date.now() - 60 * 86400_000,
    "Invalid reporting window",
  );

const baseFilters = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  scope: z.enum(["project", "all"]).default("project"),
  apiVersion: z.enum(["all", "legacy", "v1"]).default("all"),
  projectId: identifier,
  keyId: identifier,
  route: z.string().min(1).max(180).optional(),
  method: z
    .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    .optional(),
  statusClass: z.enum(["all", "2xx", "3xx", "4xx", "5xx"]).optional(),
  statusCode: z
    .string()
    .regex(/^[1-5]\d{2}$/)
    .optional(),
  limitOutcome: z
    .string()
    .regex(/^[a-z0-9_]{1,32}$/)
    .optional(),
  cacheStatus: z
    .string()
    .regex(/^[A-Z0-9_]{1,32}$/)
    .optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  clientCategory: z
    .enum(["browser", "application", "bot", "other", "unknown"])
    .optional(),
  originPresence: z.enum(["present", "direct"]).optional(),
  policyFamily: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/i)
    .optional(),
  excludeConsole: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  start: isoTimestamp.optional(),
  end: isoTimestamp.optional(),
});

const validateWindow = (
  value: { start?: string; end?: string },
  ctx: z.RefinementCtx,
) => {
  if (!value.start) return;
  const startMs = Date.parse(value.start);
  const endMs = value.end ? Date.parse(value.end) : Date.now();
  if (endMs <= startMs || endMs - startMs > 31 * 86400_000) {
    ctx.addIssue({
      code: "custom",
      message: "Invalid reporting window",
    });
  }
};

const filters = baseFilters.superRefine(validateWindow);
const tableFilters = baseFilters
  .extend({
    dimension: z
      .enum([
        "endpoints",
        "projects",
        "keys",
        "origins",
        "ips",
        "userAgents",
        "statusCodes",
        "limitOutcomes",
        "cacheStatuses",
        "policies",
      ])
      .default("endpoints"),
    search: z.string().trim().max(180).optional(),
    minRequests: z.coerce.number().int().min(0).max(1_000_000).default(0),
    sort: z
      .enum([
        "requests",
        "cacheHitRate",
        "errors",
        "errorRate",
        "rateLimited",
        "blockedPolicy",
        "avgLatencyMs",
        "p50LatencyMs",
        "p95LatencyMs",
        "p99LatencyMs",
        "label",
      ])
      .default("requests"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine(validateWindow);

export const analyticsRoutes = new Hono<{
  Bindings: DashboardEnv;
  Variables: { user: EpicSessionUser };
}>();
analyticsRoutes.use("*", requireDashboardUser);
for (const path of ["/", "/table"] as const) {
  analyticsRoutes.get(path, async (c) => {
    const parsed = (path === "/table" ? tableFilters : filters).safeParse(
      c.req.query(),
    );
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid usage filters, time range, or pagination.",
          },
        },
        400,
      );
    const user = c.get("user");
    if (parsed.data.scope === "all" && !(await isDashboardAdmin(c.env, user))) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Administrator access required for all-project usage.",
          },
        },
        403,
      );
    }
    const params = {
      ...parsed.data,
      ownerEpicId: parsed.data.scope === "all" ? null : user.epicAccountId,
    };
    try {
      return c.json(
        path === "/table"
          ? await queryUsageTable(c.env, params)
          : await queryDashboardAnalytics(c.env, params),
      );
    } catch (error) {
      console.error("Dashboard analytics unavailable", { path, error });
      return c.json(
        {
          error: {
            code: "ANALYTICS_UNAVAILABLE",
            message: "Usage history is temporarily unavailable. Please retry.",
          },
        },
        503,
      );
    }
  });
}
