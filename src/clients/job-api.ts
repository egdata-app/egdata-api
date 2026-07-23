import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export type JobApiJobType =
  | "offer-regen"
  | "item-regen"
  | "achievement-refresh";

export interface AcceptedJobApiSubmission {
  jobId: string;
  workflowId: string;
  statusUrl: string;
  deduplicated: boolean;
}

export interface JobApiClientConfig {
  baseUrl: string;
  keyId: string;
  secret: string;
}

export interface JobApiSigningInput {
  keyId: string;
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  url: string;
  idempotencyKey?: string;
  body: Uint8Array;
}

interface JobApiRuntimeOptions {
  config?: JobApiClientConfig;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  nonce?: () => string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export interface JobApiRequestOptions extends JobApiRuntimeOptions {
  requestId?: string;
}

export interface JobApiBatchOptions extends JobApiRuntimeOptions {
  concurrency?: number;
  requestId?: string;
}

const endpointByJobType: Record<JobApiJobType, string> = {
  "offer-regen": "/v1/jobs/offer-regens",
  "item-regen": "/v1/jobs/item-regens",
  "achievement-refresh": "/v1/jobs/achievement-refreshes",
};

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const noncePattern = /^[A-Za-z0-9_-]{16,128}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const externalJobIdPattern =
  /^api-(?:offer-regen|item-regen|achievement-refresh)-[a-f0-9]{64}$/u;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: "JOB_API_BASE_URL" | "JOB_API_KEY_ID" | "JOB_API_SECRET",
): string {
  const rawValue = environment[name];
  if (!rawValue || !rawValue.trim()) {
    throw new Error(`${name} is required for job submission`);
  }
  return name === "JOB_API_SECRET" ? rawValue : rawValue.trim();
}

export function loadJobApiClientConfig(
  environment: NodeJS.ProcessEnv = process.env,
): JobApiClientConfig {
  const rawBaseUrl = requiredEnvironmentValue(environment, "JOB_API_BASE_URL");
  const keyId = requiredEnvironmentValue(environment, "JOB_API_KEY_ID");
  const secret = requiredEnvironmentValue(environment, "JOB_API_SECRET");

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("JOB_API_BASE_URL must be an absolute URL");
  }
  if (
    !["http:", "https:"].includes(parsedBaseUrl.protocol) ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash
  ) {
    throw new Error(
      "JOB_API_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  if (!keyIdPattern.test(keyId)) {
    throw new Error(
      "JOB_API_KEY_ID must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}",
    );
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JOB_API_SECRET must contain at least 32 bytes");
  }

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/u, ""),
    keyId,
    secret,
  };
}

function canonicalJobApiRequest(
  input: Omit<JobApiSigningInput, "secret">,
): string {
  const url = new URL(input.url);
  return [
    "egdata-job-api-v1",
    input.keyId,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    input.idempotencyKey ?? "",
    sha256(input.body),
  ].join("\n");
}

export function createJobApiSignature(input: JobApiSigningInput): string {
  return createHmac("sha256", input.secret)
    .update(canonicalJobApiRequest(input), "utf8")
    .digest("hex");
}

export function createJobApiRequestId(): string {
  return randomUUID();
}

export function createJobApiNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function createJobApiIdempotencyKey(input: {
  jobType: JobApiJobType;
  requestId: string;
  itemIndex: number;
  payload: unknown;
}): string {
  if (!Number.isSafeInteger(input.itemIndex) || input.itemIndex < 0) {
    throw new Error("Job API item index must be a non-negative safe integer");
  }
  const body = JSON.stringify(input.payload);
  if (body === undefined) {
    throw new Error("Job API payload must be JSON serializable");
  }
  return [
    "egdata-api",
    input.jobType,
    sha256(input.requestId).slice(0, 32),
    input.itemIndex,
    sha256(body).slice(0, 32),
  ].join(":");
}

export class JobApiRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JobApiRequestError";
  }
}

function validateAcceptedSubmission(value: unknown): AcceptedJobApiSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JobApiRequestError(
      "Job API returned an invalid acceptance body",
      true,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.jobId !== "string" ||
    !externalJobIdPattern.test(record.jobId) ||
    typeof record.workflowId !== "string" ||
    record.workflowId !== record.jobId ||
    typeof record.statusUrl !== "string" ||
    record.statusUrl.length === 0 ||
    typeof record.deduplicated !== "boolean"
  ) {
    throw new JobApiRequestError(
      "Job API returned incomplete acceptance metadata",
      true,
    );
  }
  return {
    jobId: record.jobId,
    workflowId: record.workflowId,
    statusUrl: record.statusUrl,
    deduplicated: record.deduplicated,
  };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function submitJobApi(
  jobType: JobApiJobType,
  payload: unknown,
  idempotencyKey: string,
  options: JobApiRuntimeOptions,
): Promise<AcceptedJobApiSubmission> {
  if (!idempotencyKeyPattern.test(idempotencyKey)) {
    throw new Error("Job API idempotency key is invalid");
  }

  const config = options.config ?? loadJobApiClientConfig();
  const body = JSON.stringify(payload);
  if (body === undefined) {
    throw new Error("Job API payload must be JSON serializable");
  }
  const bodyBytes = new TextEncoder().encode(body);
  const url = `${config.baseUrl}${endpointByJobType[jobType]}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? 2;
  const nonce = options.nonce ?? createJobApiNonce;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 1_250;

  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5
  ) {
    throw new Error("Job API maxAttempts must be an integer between 1 and 5");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Job API timeoutMs must be a positive integer");
  }

  let lastError: JobApiRequestError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestNonce = nonce();
    if (!noncePattern.test(requestNonce)) {
      throw new Error("Job API nonce must contain 16-128 URL-safe characters");
    }
    const timestamp = String(Math.floor(now() / 1000));
    const signature = createJobApiSignature({
      keyId: config.keyId,
      secret: config.secret,
      timestamp,
      nonce: requestNonce,
      method: "POST",
      url,
      idempotencyKey,
      body: bodyBytes,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "x-api-key-id": config.keyId,
            "x-api-nonce": requestNonce,
            "x-api-signature": `sha256=${signature}`,
            "x-api-timestamp": timestamp,
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        throw new JobApiRequestError(
          "Job API request failed before acceptance was confirmed",
          true,
          undefined,
          { cause: error },
        );
      }

      const responseText = await response.text();
      if (response.status !== 202) {
        const details = responseText.trim().slice(0, 500);
        throw new JobApiRequestError(
          `Job API rejected the submission with HTTP ${response.status}${
            details ? `: ${details}` : ""
          }`,
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          response.status,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch (error) {
        throw new JobApiRequestError(
          "Job API returned a non-JSON acceptance body",
          true,
          response.status,
          { cause: error },
        );
      }
      return validateAcceptedSubmission(parsed);
    } catch (error) {
      const requestError =
        error instanceof JobApiRequestError
          ? error
          : new JobApiRequestError(
              "Job API response could not be verified",
              true,
              undefined,
              { cause: error },
            );
      lastError = requestError;
      if (!requestError.retryable || attempt === maxAttempts) {
        throw requestError;
      }
    } finally {
      clearTimeout(timeout);
    }

    await sleep(100 * 2 ** (attempt - 1));
  }

  throw lastError ?? new JobApiRequestError("Job API submission failed", false);
}

export async function submitJobApiRequest(
  jobType: JobApiJobType,
  payload: unknown,
  options: JobApiRequestOptions = {},
): Promise<AcceptedJobApiSubmission> {
  const requestId = options.requestId ?? createJobApiRequestId();
  const idempotencyKey = createJobApiIdempotencyKey({
    jobType,
    requestId,
    itemIndex: 0,
    payload,
  });
  return submitJobApi(jobType, payload, idempotencyKey, options);
}

export async function submitJobApiBatch(
  jobType: JobApiJobType,
  payloads: readonly unknown[],
  options: JobApiBatchOptions = {},
): Promise<AcceptedJobApiSubmission[]> {
  const concurrency = options.concurrency ?? 8;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  ) {
    throw new Error(
      "Job API batch concurrency must be an integer between 1 and 32",
    );
  }
  if (payloads.length === 0) return [];

  const config = options.config ?? loadJobApiClientConfig();
  const requestId = options.requestId ?? createJobApiRequestId();
  const results = new Array<AcceptedJobApiSubmission>(payloads.length);
  const failures: Error[] = [];
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < payloads.length) {
      const itemIndex = nextIndex;
      nextIndex += 1;
      const payload = payloads[itemIndex];
      const idempotencyKey = createJobApiIdempotencyKey({
        jobType,
        requestId,
        itemIndex,
        payload,
      });
      try {
        results[itemIndex] = await submitJobApi(
          jobType,
          payload,
          idempotencyKey,
          { ...options, config },
        );
      } catch (error) {
        failures.push(
          new Error(`Job API batch item ${itemIndex} was not accepted`, {
            cause: error,
          }),
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, payloads.length) }, async () =>
      worker(),
    ),
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${payloads.length} job submissions were not durably accepted`,
    );
  }
  return results;
}
