import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const importOpenSearchClient = async () => {
  vi.resetModules();
  return import("../src/clients/opensearch.js");
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("OpenSearch client configuration", () => {
  it("does not require OpenSearch config at import time", async () => {
    delete process.env.OPENSEARCH_URL;
    delete process.env.OPENSEARCH_USERNAME;
    delete process.env.OPENSEARCH_PASSWORD;

    await expect(importOpenSearchClient()).resolves.toHaveProperty(
      "getOpenSearchClient",
    );
  });

  it("fails fast when OpenSearch-backed routes are used without a node URL", async () => {
    delete process.env.OPENSEARCH_URL;
    delete process.env.OPENSEARCH_USERNAME;
    delete process.env.OPENSEARCH_PASSWORD;

    const { getOpenSearchClient } = await importOpenSearchClient();

    expect(() => getOpenSearchClient()).toThrow(
      "OPENSEARCH_URL is required for OpenSearch-backed routes.",
    );
  });

  it("fails fast when only one basic auth credential is configured", async () => {
    process.env.OPENSEARCH_URL = "http://localhost:9200";
    process.env.OPENSEARCH_USERNAME = "admin";
    delete process.env.OPENSEARCH_PASSWORD;

    const { getOpenSearchClient } = await importOpenSearchClient();

    expect(() => getOpenSearchClient()).toThrow(
      "OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD must be set together.",
    );
  });

  it("fails fast when configured basic auth credentials are blank", async () => {
    process.env.OPENSEARCH_URL = "http://localhost:9200";
    process.env.OPENSEARCH_USERNAME = " ";
    process.env.OPENSEARCH_PASSWORD = "\n";

    const { getOpenSearchClient } = await importOpenSearchClient();

    expect(() => getOpenSearchClient()).toThrow(
      "OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD cannot be blank when configured.",
    );
  });

  it("trims whitespace around configured OpenSearch values", async () => {
    process.env.OPENSEARCH_URL = " http://localhost:9200 ";
    process.env.OPENSEARCH_USERNAME = " admin ";
    process.env.OPENSEARCH_PASSWORD = " secret\n";

    const { getOpenSearchClient } = await importOpenSearchClient();

    expect(() => getOpenSearchClient()).not.toThrow();
  });

  it("allows unauthenticated or URL-authenticated nodes", async () => {
    delete process.env.OPENSEARCH_USERNAME;
    delete process.env.OPENSEARCH_PASSWORD;
    process.env.OPENSEARCH_URL = "http://admin:secret@localhost:9200";

    const { getOpenSearchClient } = await importOpenSearchClient();

    expect(() => getOpenSearchClient()).not.toThrow();
  });

  it("allows URL-authenticated nodes when separate auth vars are blank", async () => {
    process.env.OPENSEARCH_URL = "http://admin:secret@localhost:9200";
    process.env.OPENSEARCH_USERNAME = "";
    process.env.OPENSEARCH_PASSWORD = "";

    const { getOpenSearchClient } = await importOpenSearchClient();

    expect(() => getOpenSearchClient()).not.toThrow();
  });
});
