import type {
  AllowedHttpMethod,
  ApiKeyTier,
  ApiScope,
  CachedKeyMetadata,
  DashboardApiKey,
  DashboardProject,
  EpicSessionUser,
  LimitIncreaseRequestRecord,
} from "./types.js";

// Apply Wrangler migrations before serving traffic; requests never create schema.

function parseJsonArray<T extends string>(
  raw: string | null | undefined,
  fallback: T[] = [],
): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is T => typeof item === "string");
    }
  } catch {
    // ignore malformed json
  }
  return fallback;
}

interface RawApiKeyRow {
  id: string;
  project_id: string;
  owner_epic_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  tier: ApiKeyTier;
  active: number;
  scopes_json: string;
  allowed_ips_json: string;
  allowed_origins_json: string;
  allowed_paths_json: string;
  allowed_methods_json: string;
  custom_rpm: number | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapApiKeyRow(row: RawApiKeyRow): DashboardApiKey {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerEpicId: row.owner_epic_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    tier: row.tier,
    active: Boolean(row.active) && !row.revoked_at,
    scopes: parseJsonArray<ApiScope>(row.scopes_json),
    allowedIps: parseJsonArray<string>(row.allowed_ips_json),
    allowedOrigins: parseJsonArray<string>(row.allowed_origins_json),
    allowedPaths: parseJsonArray<string>(row.allowed_paths_json),
    allowedMethods: parseJsonArray<AllowedHttpMethod>(
      row.allowed_methods_json,
      ["GET", "HEAD"],
    ),
    customRpm: row.custom_rpm,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCachedKeyMetadata(row: RawApiKeyRow): CachedKeyMetadata {
  return {
    keyId: row.id,
    projectId: row.project_id,
    ownerEpicId: row.owner_epic_id,
    name: row.name,
    tier: row.tier,
    active: Boolean(row.active) && !row.revoked_at,
    scopes: parseJsonArray<ApiScope>(row.scopes_json),
    allowedIps: parseJsonArray<string>(row.allowed_ips_json),
    allowedOrigins: parseJsonArray<string>(row.allowed_origins_json),
    allowedPaths: parseJsonArray<string>(row.allowed_paths_json),
    allowedMethods: parseJsonArray<AllowedHttpMethod>(
      row.allowed_methods_json,
      ["GET", "HEAD"],
    ),
    customRpm: row.custom_rpm,
    expiresAt: row.expires_at,
  };
}

export async function upsertEpicUserAndDefaultProject(
  db: D1Database,
  user: EpicSessionUser,
): Promise<DashboardProject[]> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO users (epic_account_id, display_name, avatar_url, preferred_language, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epic_account_id) DO UPDATE SET
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         preferred_language = COALESCE(excluded.preferred_language, users.preferred_language),
         email = COALESCE(excluded.email, users.email),
         updated_at = excluded.updated_at`,
    )
    .bind(
      user.epicAccountId,
      user.displayName,
      user.avatarUrl,
      user.preferredLanguage ?? null,
      user.email ?? null,
      now,
      now,
    )
    .run();

  let projects = await listUserProjects(db, user.epicAccountId);
  if (projects.length === 0) {
    const defaultSlug =
      user.displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "default";
    const created = await createProject(db, {
      ownerEpicId: user.epicAccountId,
      name: `${user.displayName}'s Project`,
      slug: `${defaultSlug}-app`,
      description: "Default egdata API project",
      websiteUrl: "",
    });
    projects = [created];
  }

  return projects;
}

export async function listUserProjects(
  db: D1Database,
  ownerEpicId: string,
): Promise<DashboardProject[]> {
  const { results } = await db
    .prepare(
      `SELECT id, owner_epic_id, name, slug, description, website_url, tier, created_at, updated_at
       FROM projects WHERE owner_epic_id = ? ORDER BY created_at ASC`,
    )
    .bind(ownerEpicId)
    .all<{
      id: string;
      owner_epic_id: string;
      name: string;
      slug: string;
      description: string;
      website_url: string;
      tier: ApiKeyTier;
      created_at: string;
      updated_at: string;
    }>();

  return results.map((r) => ({
    id: r.id,
    ownerEpicId: r.owner_epic_id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    websiteUrl: r.website_url,
    tier: r.tier,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function createProject(
  db: D1Database,
  input: {
    ownerEpicId: string;
    name: string;
    slug: string;
    description: string;
    websiteUrl: string;
  },
): Promise<DashboardProject> {
  const id = `prj_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO projects (id, owner_epic_id, name, slug, description, website_url, tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'free', ?, ?)`,
    )
    .bind(
      id,
      input.ownerEpicId,
      input.name,
      input.slug,
      input.description,
      input.websiteUrl,
      now,
      now,
    )
    .run();

  return {
    id,
    ownerEpicId: input.ownerEpicId,
    name: input.name,
    slug: input.slug,
    description: input.description,
    websiteUrl: input.websiteUrl,
    tier: "free",
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateProject(
  db: D1Database,
  ownerEpicId: string,
  projectId: string,
  input: { name: string; description: string; websiteUrl: string },
): Promise<DashboardProject | null> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE projects SET name = ?, description = ?, website_url = ?, updated_at = ?
       WHERE id = ? AND owner_epic_id = ?`,
    )
    .bind(
      input.name,
      input.description,
      input.websiteUrl,
      now,
      projectId,
      ownerEpicId,
    )
    .run();

  const projects = await listUserProjects(db, ownerEpicId);
  return projects.find((p) => p.id === projectId) ?? null;
}

export async function listUserApiKeys(
  db: D1Database,
  ownerEpicId: string,
  projectId?: string,
): Promise<DashboardApiKey[]> {
  const query = projectId
    ? db
        .prepare(
          `SELECT * FROM api_keys WHERE owner_epic_id = ? AND project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
        )
        .bind(ownerEpicId, projectId)
    : db
        .prepare(
          `SELECT * FROM api_keys WHERE owner_epic_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
        )
        .bind(ownerEpicId);

  const { results } = await query.all<RawApiKeyRow>();
  return results.map(mapApiKeyRow);
}

export async function findRawKeyByHash(
  db: D1Database,
  keyHash: string,
): Promise<RawApiKeyRow | null> {
  return db
    .prepare(`SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1`)
    .bind(keyHash)
    .first<RawApiKeyRow>();
}

export async function findRawKeyByIdAndOwner(
  db: D1Database,
  keyId: string,
  ownerEpicId: string,
): Promise<RawApiKeyRow | null> {
  return db
    .prepare(
      `SELECT * FROM api_keys WHERE id = ? AND owner_epic_id = ? LIMIT 1`,
    )
    .bind(keyId, ownerEpicId)
    .first<RawApiKeyRow>();
}

export async function insertApiKey(
  db: D1Database,
  input: {
    id: string;
    projectId: string;
    ownerEpicId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    tier: ApiKeyTier;
    scopes: ApiScope[];
    allowedIps: string[];
    allowedOrigins: string[];
    allowedPaths: string[];
    allowedMethods: AllowedHttpMethod[];
    expiresAt: string | null;
  },
): Promise<DashboardApiKey> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO api_keys (
        id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active,
        scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.projectId,
      input.ownerEpicId,
      input.name,
      input.keyPrefix,
      input.keyHash,
      input.tier,
      JSON.stringify(input.scopes),
      JSON.stringify(input.allowedIps),
      JSON.stringify(input.allowedOrigins),
      JSON.stringify(input.allowedPaths),
      JSON.stringify(input.allowedMethods),
      input.expiresAt,
      now,
      now,
    )
    .run();

  const row = await findRawKeyByIdAndOwner(db, input.id, input.ownerEpicId);
  if (!row) {
    throw new Error("Failed to read created API key");
  }
  return mapApiKeyRow(row);
}

export async function updateApiKeyPermissions(
  db: D1Database,
  ownerEpicId: string,
  keyId: string,
  updates: {
    name?: string;
    active?: boolean;
    scopes?: ApiScope[];
    allowedIps?: string[];
    allowedOrigins?: string[];
    allowedPaths?: string[];
    allowedMethods?: AllowedHttpMethod[];
    expiresAt?: string | null;
  },
): Promise<{
  updated: DashboardApiKey;
  keyHash: string;
  cached: CachedKeyMetadata;
} | null> {
  const current = await findRawKeyByIdAndOwner(db, keyId, ownerEpicId);
  if (!current || current.revoked_at) return null;

  const now = new Date().toISOString();
  const nextName = updates.name ?? current.name;
  const nextActive =
    updates.active !== undefined ? (updates.active ? 1 : 0) : current.active;
  const nextScopes = updates.scopes
    ? JSON.stringify(updates.scopes)
    : current.scopes_json;
  const nextIps = updates.allowedIps
    ? JSON.stringify(updates.allowedIps)
    : current.allowed_ips_json;
  const nextOrigins = updates.allowedOrigins
    ? JSON.stringify(updates.allowedOrigins)
    : current.allowed_origins_json;
  const nextPaths = updates.allowedPaths
    ? JSON.stringify(updates.allowedPaths)
    : current.allowed_paths_json;
  const nextMethods = updates.allowedMethods
    ? JSON.stringify(updates.allowedMethods)
    : current.allowed_methods_json;
  const nextExpires =
    updates.expiresAt !== undefined ? updates.expiresAt : current.expires_at;

  await db
    .prepare(
      `UPDATE api_keys SET
        name = ?,
        active = ?,
        scopes_json = ?,
        allowed_ips_json = ?,
        allowed_origins_json = ?,
        allowed_paths_json = ?,
        allowed_methods_json = ?,
        expires_at = ?,
        updated_at = ?
       WHERE id = ? AND owner_epic_id = ?`,
    )
    .bind(
      nextName,
      nextActive,
      nextScopes,
      nextIps,
      nextOrigins,
      nextPaths,
      nextMethods,
      nextExpires,
      now,
      keyId,
      ownerEpicId,
    )
    .run();

  const refreshed = await findRawKeyByIdAndOwner(db, keyId, ownerEpicId);
  if (!refreshed) return null;

  return {
    updated: mapApiKeyRow(refreshed),
    keyHash: refreshed.key_hash,
    cached: toCachedKeyMetadata(refreshed),
  };
}

export async function revokeAndDeleteApiKey(
  db: D1Database,
  ownerEpicId: string,
  keyId: string,
): Promise<{ keyHash: string } | null> {
  const existing = await findRawKeyByIdAndOwner(db, keyId, ownerEpicId);
  if (!existing) return null;

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE api_keys SET active = 0, revoked_at = ?, updated_at = ? WHERE id = ? AND owner_epic_id = ?`,
    )
    .bind(now, now, keyId, ownerEpicId)
    .run();

  return { keyHash: existing.key_hash };
}

export async function touchApiKeyLastUsed(
  db: D1Database,
  keyId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
    .bind(now, keyId)
    .run();
}

export async function insertLimitRequest(
  db: D1Database,
  input: {
    ownerEpicId: string;
    projectId: string;
    contactEmail: string;
    requestedTier: "pro" | "enterprise" | "custom";
    requestedRpm: number;
    expectedMonthlyRequests: number;
    useCase: string;
    websiteUrl: string;
    emailDeliveryStatus: string;
  },
): Promise<LimitIncreaseRequestRecord | null> {
  const id = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();

  const inserted = await db
    .prepare(
      `INSERT INTO limit_requests (
        id, owner_epic_id, project_id, contact_email, requested_tier,
        requested_rpm, expected_monthly_requests, use_case, website_url, status, email_delivery_status, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM limit_requests WHERE owner_epic_id=? AND project_id=? AND status='pending')
          AND (SELECT COUNT(*) FROM limit_requests WHERE owner_epic_id=? AND created_at>=?) < 3`,
    )
    .bind(
      id,
      input.ownerEpicId,
      input.projectId,
      input.contactEmail,
      input.requestedTier,
      input.requestedRpm,
      input.expectedMonthlyRequests,
      input.useCase,
      input.websiteUrl,
      input.emailDeliveryStatus,
      now,
      input.ownerEpicId,
      input.projectId,
      input.ownerEpicId,
      new Date(Date.now() - 86_400_000).toISOString(),
    )
    .run();

  if (inserted.meta.changes === 0) return null;

  return {
    id,
    ownerEpicId: input.ownerEpicId,
    projectId: input.projectId,
    contactEmail: input.contactEmail,
    requestedTier: input.requestedTier,
    requestedRpm: input.requestedRpm,
    expectedMonthlyRequests: input.expectedMonthlyRequests,
    useCase: input.useCase,
    websiteUrl: input.websiteUrl,
    status: "pending",
    emailDeliveryStatus: input.emailDeliveryStatus,
    createdAt: now,
  };
}

export async function listUserLimitRequests(
  db: D1Database,
  ownerEpicId: string,
): Promise<LimitIncreaseRequestRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT lr.*, p.name as project_name
       FROM limit_requests lr
       LEFT JOIN projects p ON p.id = lr.project_id
       WHERE lr.owner_epic_id = ?
       ORDER BY lr.created_at DESC
       LIMIT 25`,
    )
    .bind(ownerEpicId)
    .all<{
      id: string;
      owner_epic_id: string;
      project_id: string;
      project_name: string | null;
      contact_email: string;
      requested_tier: "pro" | "enterprise" | "custom";
      requested_rpm: number;
      expected_monthly_requests: number;
      use_case: string;
      website_url: string;
      status: "pending" | "approved" | "declined";
      email_delivery_status: string;
      created_at: string;
    }>();

  return results.map((r) => ({
    id: r.id,
    ownerEpicId: r.owner_epic_id,
    projectId: r.project_id,
    projectName: r.project_name ?? undefined,
    contactEmail: r.contact_email,
    requestedTier: r.requested_tier,
    requestedRpm: r.requested_rpm,
    expectedMonthlyRequests: r.expected_monthly_requests,
    useCase: r.use_case,
    websiteUrl: r.website_url,
    status: r.status,
    emailDeliveryStatus: r.email_delivery_status,
    createdAt: r.created_at,
  }));
}
