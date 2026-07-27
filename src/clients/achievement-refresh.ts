import {
  type AcceptedJobApiSubmission,
  createJobApiRequestId,
  submitJobApiRequest,
} from "./job-api.js";
import client from "./redis.js";

export interface TemporalAchievementRefreshMetadata
  extends AcceptedJobApiSubmission {
  acceptedAt: string;
  jobType: "achievement-refresh";
  orchestrator: "temporal";
  timestamp: number;
}

export interface AchievementRefreshRequestResult {
  metadata?: TemporalAchievementRefreshMetadata;
  reusedCooldown: boolean;
}

export interface AchievementRefreshDependencies {
  cacheGet?: (key: string) => Promise<string | null>;
  cacheSet?: (
    key: string,
    value: string,
    ttlMs: number,
    onlyIfAbsent: boolean,
  ) => Promise<unknown>;
  createRequestId?: () => string;
  now?: () => number;
  submit?: typeof submitJobApiRequest;
}

type CooldownSlot = {
  requestId: string;
  timestamp: number;
};

function parseStoredRecord(
  raw: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} cache entry is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} cache entry must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function storedTimestamp(raw: string, label: string): number {
  const timestamp = parseStoredRecord(raw, label).timestamp;
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0
  ) {
    throw new Error(`${label} cache entry has an invalid timestamp`);
  }
  return timestamp;
}

export function achievementRefreshRemainingTime(
  raw: string | null,
  ttlMs: number,
  now = Date.now(),
): number {
  if (raw === null) return 0;
  const timestamp = storedTimestamp(raw, "Achievement refresh status");
  return Math.max(0, ttlMs - (now - timestamp));
}

function parseCooldownSlot(raw: string): CooldownSlot {
  const record = parseStoredRecord(raw, "Achievement refresh cooldown");
  if (
    typeof record.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(record.requestId) ||
    typeof record.timestamp !== "number" ||
    !Number.isSafeInteger(record.timestamp) ||
    record.timestamp <= 0
  ) {
    throw new Error("Achievement refresh cooldown cache entry is invalid");
  }
  return {
    requestId: record.requestId,
    timestamp: record.timestamp,
  };
}

export async function requestAchievementRefresh(
  accountId: string,
  ttlMs: number,
  dependencies: AchievementRefreshDependencies = {},
): Promise<AchievementRefreshRequestResult> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Achievement refresh cooldown must be a positive integer");
  }

  const cacheGet = dependencies.cacheGet ?? ((key: string) => client.get(key));
  const cacheSet =
    dependencies.cacheSet ??
    ((key: string, value: string, duration: number, onlyIfAbsent: boolean) =>
      onlyIfAbsent
        ? client.set(key, value, "PX", duration, "NX")
        : client.set(key, value, "PX", duration));
  const createRequestId = dependencies.createRequestId ?? createJobApiRequestId;
  const now = dependencies.now ?? Date.now;
  const submit = dependencies.submit ?? submitJobApiRequest;
  const statusKey = `refresh-achievements:${accountId}`;
  const cooldownKey = `refresh-achievements:temporal-cooldown:${accountId}`;

  const existingStatus = await cacheGet(statusKey);
  if (achievementRefreshRemainingTime(existingStatus, ttlMs, now()) > 0) {
    return { reusedCooldown: true };
  }

  const proposedSlot: CooldownSlot = {
    requestId: createRequestId(),
    timestamp: now(),
  };
  await cacheSet(cooldownKey, JSON.stringify(proposedSlot), ttlMs, true);

  const storedSlot = await cacheGet(cooldownKey);
  if (storedSlot === null) {
    throw new Error("Achievement refresh cooldown could not be established");
  }
  const slot = parseCooldownSlot(storedSlot);
  const elapsedBeforeSubmit = now() - slot.timestamp;
  if (elapsedBeforeSubmit < 0 || elapsedBeforeSubmit >= ttlMs) {
    throw new Error("Achievement refresh cooldown expired before submission");
  }

  const accepted = await submit(
    "achievement-refresh",
    { accountId },
    { requestId: slot.requestId },
  );
  const acceptedAt = now();
  const metadata: TemporalAchievementRefreshMetadata = {
    ...accepted,
    acceptedAt: new Date(acceptedAt).toISOString(),
    jobType: "achievement-refresh",
    orchestrator: "temporal",
    timestamp: slot.timestamp,
  };
  const remainingTtl = Math.max(1, ttlMs - (acceptedAt - slot.timestamp));
  await cacheSet(statusKey, JSON.stringify(metadata), remainingTtl, false);

  return {
    metadata,
    reusedCooldown: false,
  };
}
