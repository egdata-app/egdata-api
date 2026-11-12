import type { DocEntry } from "./types";

/**
 * Written guides are copied from `apps/docs/content/docs` so the dashboard can
 * render them without depending on the separate docs app at runtime.
 */
export const guideDocs: DocEntry[] = [
  {
    slug: "get-started",
    kind: "guide",
    title: "Get started",
    description: "Make your first request to the egdata API.",
    category: "Start here",
    order: 1,
  },
  {
    slug: "versioned-api",
    kind: "guide",
    title: "Versioned v1 API",
    description:
      "API keys, exact quotas, cursor pagination, and the RFC 9457 error contract for /v1.",
    category: "Start here",
    order: 2,
  },
  {
    slug: "api-reference",
    kind: "index",
    title: "API reference",
    description:
      "Browse every deployed v1 operation, its schemas, and its change history.",
    category: "Start here",
    order: 3,
  },
  {
    slug: "offer-search",
    kind: "guide",
    title: "Find games",
    description: "Search the catalog, combine filters, and order results.",
    category: "Find data",
    order: 1,
  },
  {
    slug: "natural-language-search",
    kind: "guide",
    title: "Natural-language search",
    description: "Find games by describing what you are looking for.",
    category: "Find data",
    order: 2,
  },
  {
    slug: "game-details",
    kind: "guide",
    title: "Game details",
    description:
      "Load an offer, discover its items, and follow catalog relationships.",
    category: "Find data",
    order: 3,
  },
  {
    slug: "price-availability",
    kind: "guide",
    title: "Prices",
    description: "Read current regional prices, discounts, and price history.",
    category: "Find data",
    order: 4,
  },
  {
    slug: "free-games",
    kind: "guide",
    title: "Free games",
    description:
      "Find active and upcoming giveaways with regional restrictions.",
    category: "Find data",
    order: 5,
  },
  {
    slug: "regions-pagination-errors",
    kind: "guide",
    title: "Request essentials",
    description:
      "Choose a country and locale, page through results, and handle errors.",
    category: "Request essentials",
    order: 1,
  },
  {
    slug: "api-console",
    kind: "guide",
    title: "API console sessions",
    description:
      "Try v1 operations with short-lived, project-scoped console access.",
    category: "Request essentials",
    order: 2,
  },
  {
    slug: "anti-abuse",
    kind: "guide",
    title: "API sessions and abuse protection",
    description:
      "Initialize proof-of-work sessions and handle conditional catalog protection.",
    category: "Request essentials",
    order: 3,
  },
  {
    slug: "track-changes",
    kind: "guide",
    title: "Track changes",
    description:
      "Retrieve catalog updates for an offer and its related records.",
    category: "Track changes",
    order: 1,
  },
  {
    slug: "developer-alerts",
    kind: "guide",
    title: "API explorer and endpoint alerts",
    description:
      "Inspect deployed v1 operations and merged changes relevant to your project.",
    category: "Track changes",
    order: 2,
  },
  {
    slug: "endpoint-history",
    kind: "guide",
    title: "Endpoint histories",
    description: "Dated API behavior changes, independent of deployment.",
    category: "Track changes",
    order: 3,
  },
  {
    slug: "histories",
    kind: "guide",
    title: "Legacy operation histories",
    description:
      "Find dated history for operations that are no longer in the deployed contract.",
    category: "Track changes",
    order: 4,
  },
  {
    slug: "graphql-profiles",
    kind: "guide",
    title: "GraphQL profiles",
    description:
      "Select public profile highlights, games, and recent activity.",
    category: "Advanced",
    order: 1,
  },
  {
    slug: "catalog-hydration",
    kind: "guide",
    title: "Catalog hydration",
    description:
      "Incrementally retrieve catalog records and relationships for discovered roots.",
    category: "Advanced",
    order: 2,
  },
  {
    slug: "launcher-record-resolution",
    kind: "guide",
    title: "Launcher record resolution",
    description:
      "Resolve parsed Windows build metadata to matching launcher records.",
    category: "Advanced",
    order: 3,
  },
  {
    slug: "v1-problems",
    kind: "guide",
    title: "v1 Problem Details",
    description: "Error fields, stable codes, and client recovery steps.",
    category: "Errors",
    order: 1,
  },
];

const sources = import.meta.glob("../../content/docs/*.md", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const sourceBySlug = new Map(
  Object.entries(sources).map(([path, load]) => [
    path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
    load,
  ]),
);

export function loadGuideSource(slug: string): Promise<string> | null {
  const load = sourceBySlug.get(slug);
  return load ? load() : null;
}
