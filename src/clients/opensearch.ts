import { Client, type ClientOptions } from "@opensearch-project/opensearch";

let client: Client | undefined;

const normalizeEnvValue = (value: string | undefined) => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const hasConfiguredEnvValue = (key: string) =>
  Object.hasOwn(process.env, key) && process.env[key] !== undefined;

const hasUrlAuth = (node: string) => {
  const url = new URL(node);
  return Boolean(url.username && url.password);
};

const getOpenSearchClientOptions = (): ClientOptions => {
  const node = normalizeEnvValue(process.env.OPENSEARCH_URL);
  const username = normalizeEnvValue(process.env.OPENSEARCH_USERNAME);
  const password = normalizeEnvValue(process.env.OPENSEARCH_PASSWORD);

  if (!node) {
    throw new Error("OPENSEARCH_URL is required for OpenSearch-backed routes.");
  }

  const nodeIncludesAuth = hasUrlAuth(node);
  const hasBlankSeparateCredentials =
    (hasConfiguredEnvValue("OPENSEARCH_USERNAME") && !username) ||
    (hasConfiguredEnvValue("OPENSEARCH_PASSWORD") && !password);

  if (!nodeIncludesAuth && hasBlankSeparateCredentials) {
    throw new Error(
      "OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD cannot be blank when configured.",
    );
  }

  if ((username && !password) || (!username && password)) {
    throw new Error(
      "OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD must be set together.",
    );
  }

  return {
    node,
    ...(username && password ? { auth: { username, password } } : {}),
  };
};

export const getOpenSearchClient = () => {
  client ??= new Client(getOpenSearchClientOptions());
  return client;
};

export const opensearch: Pick<Client, "search"> = {
  search: ((...args: unknown[]) => {
    const openSearchClient = getOpenSearchClient();
    return Reflect.apply(
      openSearchClient.search as (...args: unknown[]) => unknown,
      openSearchClient,
      args,
    );
  }) as Client["search"],
};
