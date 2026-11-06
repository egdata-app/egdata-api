import { createHash } from "node:crypto";
import type { AbuseResource } from "./abuse-scorer.js";

// Only semantic filters affect the traversal identity. Tracking/cache-buster
// parameters, page and facets must not split a sweep into unrelated streams.
const FILTERS = [
  "title",
  "offerType",
  "tags",
  "categories",
  "customAttributes",
  "seller",
  "developerDisplayName",
  "publisherDisplayName",
  "refundType",
  "isCodeRedemptionOnly",
  "excludeBlockchain",
  "onSale",
  "pastGiveaways",
  "isLowestPrice",
  "isLowestPriceEver",
  "sortBy",
  "sortDir",
  "technologies",
  "price",
  "spt",
];

export function normalizedTitleHash(title: unknown): string | undefined {
  if (typeof title !== "string") return;
  const normalized = title
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
  if (Array.from(normalized).length < 3) return;
  return createHash("sha256").update(normalized).digest("hex");
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 3) return null;
  if (typeof value === "string") return value.slice(0, 512);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((v) => canonical(v, depth + 1))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .slice(0, 32)
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  return null;
}

/** Called with the same parsed filters/page/limit used by the search handler. */
export function searchAbuseResource(
  filters: object,
  page: number,
  limit: number,
  region: string,
  locale: string,
): AbuseResource | undefined {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    return;
  const input = filters as Record<string, unknown>;
  const profile = FILTERS.map((key) => [key, canonical(input[key])]);
  const queryHash = createHash("sha256")
    .update(JSON.stringify([region, locale, profile]))
    .digest("hex");
  return {
    route: `/search/v2/search:${queryHash}`,
    page,
    limit: Math.min(limit, 100),
    search: true,
    titleHash: normalizedTitleHash(input.title),
  };
}
