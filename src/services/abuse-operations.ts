import type { AbuseEvent, AbuseResource } from "./abuse-scorer.js";

// Only non-paginated offer hydration reads are eligible. Repeated reads of the
// SAME subroute remain separate work; distinct offers never collapse together.
const hydrationRoutes = new Set([
  "",
  "price",
  "assets",
  "tops",
  "features",
  "reviews",
  "reviews/permissions",
  "polls",
  "has-regular",
  "in-bundle",
  "media",
  "suggestions",
  "regional-price",
  "price-history",
  "hltb",
  "igdb",
  "genres",
  "age-rating",
  "price/fairness",
  "collections/top-new-releases",
  "collections/top-sellers",
  "collections/most-played",
  "collections/top-wishlisted",
  "collections/most-popular",
]);

export function offerHydrationResource(
  path: string,
  method: string,
  query: URLSearchParams,
): Partial<AbuseResource> {
  const match = /^\/offers\/([a-f0-9]{32})(?:\/(.*))?$/.exec(path);
  if (method !== "GET" || !match || !hydrationRoutes.has(match[2] ?? ""))
    return {};
  if (
    ["offset", "cursor", "limit"].some((key) => query.has(key)) ||
    (query.has("page") && query.get("page") !== "1")
  )
    return {};
  return { hydrationId: match[1], hydrationRoute: match[2] || "offer" };
}

/** Pure, bounded projection of the existing 60s window. No extra Redis state. */
export function logicalOperations(events: AbuseEvent[]): AbuseEvent[] {
  const operations: AbuseEvent[] = [];
  const hydration = new Map<string, { at: number; routes: Set<string> }>();
  let previousSearch: { at: number; operation: AbuseEvent } | undefined;
  for (const event of events) {
    const resources = event.resources?.length ? event.resources : [event];
    const resource = resources.length === 1 ? resources[0] : undefined;
    if (resource?.search) {
      if (previousSearch && event.at - previousSearch.at < 800) {
        // Retain only the final title of a typing chain, not every prefix hash.
        previousSearch.operation.resources = [resource];
        previousSearch.at = event.at;
        continue;
      }
      const operation = { ...event, resources: [resource] };
      previousSearch = { at: event.at, operation };
      operations.push(operation);
      continue;
    }
    if (resource?.hydrationId && resource.hydrationRoute) {
      const previous = hydration.get(resource.hydrationId);
      if (previous && event.at - previous.at < 2000) {
        if (!previous.routes.has(resource.hydrationRoute)) {
          previous.routes.add(resource.hydrationRoute);
          continue;
        }
      } else {
        hydration.set(resource.hydrationId, {
          at: event.at,
          routes: new Set([resource.hydrationRoute]),
        });
      }
    }
    operations.push(event);
  }
  return operations;
}
