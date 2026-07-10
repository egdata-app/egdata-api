import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareVectorizeError,
  queryOffersWithNaturalLanguage,
  VectorizeConfigurationError,
} from "../src/clients/vectorize.js";

const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
const originalIndexName = process.env.VECTORIZE_INDEX_NAME;

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
};

describe("Cloudflare Vectorize client", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
    process.env.CLOUDFLARE_API_TOKEN = "api-token";
    process.env.VECTORIZE_INDEX_NAME = "offers-index";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccountId);
    restoreEnv("CLOUDFLARE_API_TOKEN", originalApiToken);
    restoreEnv("VECTORIZE_INDEX_NAME", originalIndexName);
  });

  it("embeds the query and requests offer IDs from the configured index", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { data: [[0.1, 0.2, 0.3]], shape: [1, 3] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            count: 1,
            matches: [{ id: "mongo-id", score: 0.95 }],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      queryOffersWithNaturalLanguage("co-op survival", 7),
    ).resolves.toEqual([{ id: "mongo-id", score: 0.95 }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/ai/run/@cf/baai/bge-base-en-v1.5",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      text: "co-op survival",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/vectorize/v2/indexes/offers-index/query",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      vector: [0.1, 0.2, 0.3],
      topK: 7,
      returnMetadata: "all",
      returnValues: false,
    });
  });

  it("fails lazily when Cloudflare credentials are not configured", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      queryOffersWithNaturalLanguage("adventure", 10),
    ).rejects.toBeInstanceOf(VectorizeConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes Cloudflare API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            errors: [{ code: 7000, message: "Upstream failed" }],
          },
          { status: 502 },
        ),
      ),
    );

    await expect(
      queryOffersWithNaturalLanguage("adventure", 10),
    ).rejects.toBeInstanceOf(CloudflareVectorizeError);
  });
});
