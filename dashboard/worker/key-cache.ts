import { findRawKeyByHash, toCachedKeyMetadata } from "./db.js";
import type { CachedKeyMetadata, DashboardEnv } from "./types.js";

const KV_KEY_PREFIX = "apikey:";
const MEMORY_TTL_MS = 30_000;
const MAX_MEMORY_KEYS = 2_000;

interface MemoryEntry {
  value: CachedKeyMetadata | null;
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryEntry>();

function setMemoryEntry(
  keyHash: string,
  value: CachedKeyMetadata | null,
): void {
  if (memoryCache.size >= MAX_MEMORY_KEYS) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) {
      memoryCache.delete(oldest);
    }
  }
  memoryCache.set(keyHash, {
    value,
    expiresAt: Date.now() + MEMORY_TTL_MS,
  });
}

export function invalidateLocalKeyCache(keyHash: string): void {
  memoryCache.delete(keyHash);
}

export async function syncKeyToKv(
  env: DashboardEnv,
  keyHash: string,
  meta: CachedKeyMetadata,
): Promise<void> {
  await env.API_KEYS_KV.put(`${KV_KEY_PREFIX}${keyHash}`, JSON.stringify(meta));
  setMemoryEntry(keyHash, meta);
}

export async function removeKeyFromKv(
  env: DashboardEnv,
  keyHash: string,
): Promise<void> {
  await env.API_KEYS_KV.delete(`${KV_KEY_PREFIX}${keyHash}`);
  setMemoryEntry(keyHash, null);
}

export async function resolveApiKeyMetadata(
  env: DashboardEnv,
  ctx: ExecutionContext,
  keyHash: string,
): Promise<CachedKeyMetadata | null> {
  const now = Date.now();
  const mem = memoryCache.get(keyHash);
  if (mem && mem.expiresAt > now) {
    return mem.value;
  }

  const fromKv = await env.API_KEYS_KV.get<CachedKeyMetadata>(
    `${KV_KEY_PREFIX}${keyHash}`,
    {
      type: "json",
      cacheTtl: 60,
    },
  );

  if (fromKv) {
    setMemoryEntry(keyHash, fromKv);
    return fromKv;
  }

  // Fallback to D1 if KV hasn't been hydrated yet
  const raw = await findRawKeyByHash(env.DB, keyHash);
  if (!raw || raw.revoked_at || !raw.active) {
    setMemoryEntry(keyHash, null);
    return null;
  }

  const hydrated = toCachedKeyMetadata(raw);
  setMemoryEntry(keyHash, hydrated);
  ctx.waitUntil(
    env.API_KEYS_KV.put(`${KV_KEY_PREFIX}${keyHash}`, JSON.stringify(hydrated)),
  );
  return hydrated;
}
