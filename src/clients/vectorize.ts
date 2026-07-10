const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_VECTORIZE_INDEX = "egdata-offers";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const CLOUDFLARE_REQUEST_TIMEOUT_MS = 15_000;

type CloudflareError = {
  code?: number;
  message?: string;
};

type CloudflareResponse<T> = {
  success?: boolean;
  result?: T;
  errors?: CloudflareError[];
};

type EmbeddingResult = {
  data?: number[][];
};

export type VectorizeOfferMatch = {
  id: string;
  score: number;
};

type VectorizeQueryResult = {
  count?: number;
  matches?: VectorizeOfferMatch[];
};

type VectorizeConfig = {
  accountId: string;
  apiToken: string;
  indexName: string;
};

export class VectorizeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorizeConfigurationError";
  }
}

export class CloudflareVectorizeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudflareVectorizeError";
    this.status = status;
  }
}

const normalizeEnvValue = (value: string | undefined) => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const getVectorizeConfig = (): VectorizeConfig => {
  const accountId = normalizeEnvValue(process.env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = normalizeEnvValue(process.env.CLOUDFLARE_API_TOKEN);
  const indexName =
    normalizeEnvValue(process.env.VECTORIZE_INDEX_NAME) ??
    DEFAULT_VECTORIZE_INDEX;

  if (!accountId || !apiToken) {
    throw new VectorizeConfigurationError(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for natural-language search.",
    );
  }

  return { accountId, apiToken, indexName };
};

const describeCloudflareErrors = (errors: CloudflareError[] | undefined) =>
  errors
    ?.map(({ code, message }) =>
      [code, message].filter((value) => value !== undefined).join(": "),
    )
    .filter(Boolean)
    .join(", ");

const requestCloudflare = async <T>(
  url: string,
  apiToken: string,
  body: unknown,
  operation: string,
): Promise<T> => {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CloudflareVectorizeError(
      `${operation} request failed.`,
      undefined,
      {
        cause: error,
      },
    );
  }

  let payload: CloudflareResponse<T>;

  try {
    payload = (await response.json()) as CloudflareResponse<T>;
  } catch (error) {
    throw new CloudflareVectorizeError(
      `${operation} returned an invalid response.`,
      response.status,
      { cause: error },
    );
  }

  if (
    !response.ok ||
    payload.success === false ||
    payload.result === undefined
  ) {
    const details = describeCloudflareErrors(payload.errors);
    throw new CloudflareVectorizeError(
      `${operation} failed${details ? `: ${details}` : "."}`,
      response.status,
    );
  }

  return payload.result;
};

const generateEmbedding = async (
  query: string,
  config: VectorizeConfig,
): Promise<number[]> => {
  const result = await requestCloudflare<EmbeddingResult>(
    `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(config.accountId)}/ai/run/${EMBEDDING_MODEL}`,
    config.apiToken,
    { text: query },
    "Workers AI embedding generation",
  );
  const embedding = result.data?.[0];

  if (
    !embedding ||
    embedding.length === 0 ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new CloudflareVectorizeError(
      "Workers AI embedding generation returned an invalid embedding.",
    );
  }

  return embedding;
};

const queryVectorize = async (
  vector: number[],
  topK: number,
  config: VectorizeConfig,
): Promise<VectorizeOfferMatch[]> => {
  const result = await requestCloudflare<VectorizeQueryResult>(
    `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(config.accountId)}/vectorize/v2/indexes/${encodeURIComponent(config.indexName)}/query`,
    config.apiToken,
    {
      vector,
      topK,
      returnMetadata: "none",
      returnValues: false,
    },
    "Vectorize offer query",
  );

  return (result.matches ?? []).filter(
    (match) =>
      typeof match.id === "string" &&
      match.id.length > 0 &&
      Number.isFinite(match.score),
  );
};

export const queryOffersWithNaturalLanguage = async (
  query: string,
  topK: number,
): Promise<VectorizeOfferMatch[]> => {
  const config = getVectorizeConfig();
  const embedding = await generateEmbedding(query, config);
  return queryVectorize(embedding, topK, config);
};
