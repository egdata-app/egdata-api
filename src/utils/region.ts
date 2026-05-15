import { regions } from "./countries.js";

/**
 * Resolve an Epic country code (e.g. "US", "FR", "AR") to the region key
 * that Epic prices it in (e.g. "US", "EURO", "AR"). Falls back to "US"
 * for unknown or missing input.
 *
 * This logic is duplicated in ~15 call sites across routes/resolvers; the
 * canonical implementation lives here so it can be tested in isolation.
 */
export function countryToRegion(
  country: string | undefined | null,
  fallback = "US",
): string {
  if (!country) return fallback;
  return (
    Object.keys(regions).find((r) => regions[r].countries.includes(country)) ??
    fallback
  );
}
