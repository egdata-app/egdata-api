export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE = 10_000;

function normalizeMax(value: number, fallback: number) {
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function toFiniteNumber(value: number) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Clamp a user supplied page size to a positive integer within `max`.
 *
 * Missing, non-numeric (NaN/Infinity) values fall back to `fallback`; values
 * below 1 (including negative numbers) are raised to 1; values above `max`
 * are lowered to `max`.
 */
export function clampPageSize(
  value: number | null | undefined,
  fallback: number = DEFAULT_PAGE_SIZE,
  max: number = MAX_PAGE_SIZE,
): number {
  const resolvedMax = normalizeMax(max, MAX_PAGE_SIZE);
  const resolvedFallback = clampInteger(fallback, 1, resolvedMax);

  if (value === null || value === undefined) {
    return resolvedFallback;
  }

  const numeric = toFiniteNumber(value);

  if (numeric === null) {
    return resolvedFallback;
  }

  return clampInteger(numeric, 1, resolvedMax);
}

/**
 * Clamp a user supplied page number to a positive integer no greater than
 * `max` (defaults to 10,000).
 */
export function clampPage(
  value: number | null | undefined,
  max: number = MAX_PAGE,
): number {
  const resolvedMax = normalizeMax(max, MAX_PAGE);

  if (value === null || value === undefined) {
    return 1;
  }

  const numeric = toFiniteNumber(value);

  if (numeric === null) {
    return 1;
  }

  return clampInteger(numeric, 1, resolvedMax);
}

export function resolvePagination(
  limit: number | null | undefined,
  page: number | null | undefined,
  fallbackLimit: number = DEFAULT_PAGE_SIZE,
  maxLimit: number = MAX_PAGE_SIZE,
) {
  const resolvedLimit = clampPageSize(limit, fallbackLimit, maxLimit);
  const resolvedPage = clampPage(page);

  return {
    limit: resolvedLimit,
    page: resolvedPage,
    skip: (resolvedPage - 1) * resolvedLimit,
  };
}
