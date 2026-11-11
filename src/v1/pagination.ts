import type { Filter } from "mongodb";
import { badRequest } from "./errors.js";

type MongoFilter = Filter<Record<string, any>>;

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_MAX_LIMIT = MAX_PAGE_LIMIT;

export function parseLimit(
  raw: string | undefined,
  maximum = MAX_PAGE_LIMIT,
): number {
  if (raw === undefined || raw === "") return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw badRequest(
      "INVALID_LIMIT",
      `The \`limit\` parameter must be an integer between 1 and ${maximum}.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw badRequest(
      "INVALID_LIMIT",
      `The \`limit\` parameter must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

export type Pagination = {
  limit: number;
  cursor: string | null;
};

export function parsePagination(
  query: Record<string, string | undefined>,
  maximum = MAX_PAGE_LIMIT,
): Pagination {
  const limit = parseLimit(query.limit, maximum);
  const cursor = query.cursor?.trim() || null;
  if (cursor && cursor.length > 4096) {
    throw badRequest("INVALID_CURSOR", "The cursor is too long.");
  }
  return { limit, cursor };
}

export type PageMeta = {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export function pageMeta(
  limit: number,
  hasMore: boolean,
  nextCursor: string | null,
): PageMeta {
  return { limit, hasMore, nextCursor };
}

/**
 * Fetches `limit + 1` docs for an "is there another page" check, then trims.
 */
export function trimPage<T>(
  rows: T[],
  limit: number,
): {
  items: T[];
  hasMore: boolean;
} {
  if (rows.length > limit) {
    return { items: rows.slice(0, limit), hasMore: true };
  }
  return { items: rows, hasMore: false };
}

export type MongoSortField = {
  field: string;
  direction: 1 | -1;
  /** Where null/missing values appear in the sort. */
  nulls: "first" | "last";
};

const equalCondition = (field: string, value: unknown) =>
  value === null ? { [field]: null } : { [field]: { $eq: value } };

/**
 * Builds the lexicographic "after this tuple" filter for a MongoDB keyset
 * scan. Null/missing ordering is explicit so a cursor can never skip or repeat
 * documents containing null sort values.
 */
export function mongoKeysetFilter(
  sort: MongoSortField[],
  last: Array<string | number | null>,
): MongoFilter {
  if (sort.length === 0 || sort.length !== last.length) {
    throw badRequest("INVALID_CURSOR", "The cursor sort tuple is invalid.");
  }

  const clauses: MongoFilter[] = [];

  for (let index = 0; index < sort.length; index++) {
    const { field, direction, nulls } = sort[index];
    const value = last[index];
    const comparison = direction === -1 ? "$lt" : "$gt";
    const alternatives: MongoFilter[] = [];

    if (value === null) {
      if (nulls === "first") {
        // Every non-null value sorts after the null group.
        alternatives.push({ [field]: { $ne: null } });
      }
    } else {
      alternatives.push({ [field]: { [comparison]: value } });
      if (nulls === "last") {
        // Nulls sort after every non-null value in this direction.
        alternatives.push({ [field]: null });
      }
    }

    const prefix: MongoFilter[] = [];
    for (let prior = 0; prior < index; prior++) {
      prefix.push(equalCondition(sort[prior].field, last[prior]));
    }

    for (const alternative of alternatives) {
      clauses.push(
        prefix.length > 0
          ? ({ $and: [...prefix, alternative] } as MongoFilter)
          : alternative,
      );
    }
  }

  if (clauses.length === 0) {
    // The final tuple has nothing after it; a caller should not request a next
    // page, but an impossible filter is safer than returning duplicates.
    return { _id: { $exists: false } } as MongoFilter;
  }

  return clauses.length === 1 ? clauses[0] : ({ $or: clauses } as MongoFilter);
}

export function mongoSortSpec(sort: MongoSortField[]): Record<string, 1 | -1> {
  return Object.fromEntries(
    sort.map((entry) => [entry.field, entry.direction]),
  );
}
