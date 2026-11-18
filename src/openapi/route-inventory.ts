import policy from "../../openapi/route-policy.json" with { type: "json" };
import type { Method, Visibility } from "./types.js";

export type RouteClassification = {
  method?: Method | "*";
  path: string;
  visibility: Visibility | "public-deferred" | "non-json";
  reason: string;
};

export const routeClassifications: RouteClassification[] = policy.routeClassifications as RouteClassification[];
