import { describe, expect, it } from "vitest";
import {
  SEA_QA_SMOKE_ITEM_ID,
  SEA_QA_SMOKE_OFFER_ID,
} from "./fixtures/seaqa.js";

const API_BASE = process.env.LIVE_API_BASE ?? "https://api.egdata.app";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

async function fetchJson(path: string): Promise<JsonObject> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(new URL(path, API_BASE), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`${path} returned HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error(`${path} returned ${contentType || "no content type"}`);
      }

      return (await response.json()) as JsonObject;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  throw lastError;
}

describe("public API live smoke", () => {
  it("resolves the stable SeaQA offer", async () => {
    const offer = await fetchJson(`/offers/${SEA_QA_SMOKE_OFFER_ID}`);

    expect(offer).toMatchObject({
      id: SEA_QA_SMOKE_OFFER_ID,
      namespace: "SeaQA",
    });
  });

  it("resolves the stable SeaQA item", async () => {
    const item = await fetchJson(`/items/${SEA_QA_SMOKE_ITEM_ID}`);

    expect(item).toMatchObject({
      id: SEA_QA_SMOKE_ITEM_ID,
      namespace: "SeaQA",
    });
  });

  it("resolves the stable SeaQA sandbox", async () => {
    const sandbox = await fetchJson("/sandboxes/SeaQA");

    expect(sandbox).toMatchObject({
      _id: "SeaQA",
      name: "SeaQA",
      status: "ACTIVE",
    });
  });

  it("resolves the stable observed build", async () => {
    const build = await fetchJson("/builds/67141fcefb3045682a6fbf19");

    expect(build).toMatchObject({
      id: "67141fcefb3045682a6fbf19",
      appName: "4d0ff75b922447649057c237c0bd1545",
    });
    expect(build.manifest).toEqual(expect.any(Object));
  });
});
