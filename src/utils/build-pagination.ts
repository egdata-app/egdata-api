export const MAX_BUILD_PAGINATION_OFFSET = 100_000;
export const MAX_BUILD_PAGE = MAX_BUILD_PAGINATION_OFFSET + 1;

export function parseBuildInteger(
  value: string | undefined,
  fallback: number,
  maximum = 100,
): number | null {
  const parsed =
    value === undefined
      ? fallback
      : /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : null;
}

export function buildPaginationOffset(
  page: number,
  limit: number,
): number | null {
  const offset = (page - 1) * limit;
  return Number.isSafeInteger(offset) && offset <= MAX_BUILD_PAGINATION_OFFSET
    ? offset
    : null;
}
