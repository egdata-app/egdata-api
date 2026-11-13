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
const filters = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  scope: z.enum(["project", "all"]).default("project"),
  apiVersion: z.enum(["all", "legacy", "v1"]).default("all"),
  projectId: identifier,
  keyId: identifier,
  route: z.string().min(1).max(180).optional(),
  method: z
    .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    .optional(),
  end: z.iso
    .datetime()
    .refine(
      (value) =>
        Date.parse(value) <= Date.now() + 60_000 &&
        Date.parse(value) >= Date.now() - 60 * 86400_000,
      "Invalid reporting window",
    )
    .optional(),
});
const tableFilters = filters.extend({
  dimension: z
    .enum(["endpoints", "projects", "keys", "origins", "ips", "userAgents"])
    .default("endpoints"),
  search: z.string().trim().max(180).optional(),
  sort: z
    .enum([
      "requests",
      "cacheHitRate",
      "rateLimited",
      "blockedPolicy",
      "errorRate",
      "avgLatencyMs",
      "p95LatencyMs",
    ])
    .default("requests"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

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
