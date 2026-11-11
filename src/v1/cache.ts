import client from "../clients/response-cache.js";

/**
 * v1 uses its own response-cache namespace so legacy payload changes cannot
 * leak into the versioned contract (and vice versa).
 */
const PREFIX = "v1:";

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const cached = await client.get(`${PREFIX}${key}`);
    return cached ? (JSON.parse(cached) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    await client.set(
      `${PREFIX}${key}`,
      JSON.stringify(value),
      "EX",
      ttlSeconds,
    );
  } catch {
    // Internal cache failures must not fail a public read.
  }
}

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await loader();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

export const v1CacheKey = (
  operation: string,
  parts: Record<string, unknown>,
): string =>
  `${operation}:${Object.entries(parts)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(":")}`;
