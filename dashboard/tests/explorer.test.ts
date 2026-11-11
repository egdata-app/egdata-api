import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executable,
  executeOperation,
  groupOperationsByResource,
  type Operation,
  operationReference,
  redactedSnippet,
  requestUrl,
  safeDocument,
} from "../src/lib/explorer";

const op: Operation = {
  operationId: "getOffer",
  method: "GET",
  path: "/v1/offers/{id}",
  operation: { operationId: "getOffer", responses: {} },
};

afterEach(() => vi.unstubAllGlobals());

describe("fixed gateway request console", () => {
  it("uses a session only with same-origin cookies, redacts it, and rejects expiry", async () => {
    vi.stubGlobal("location", { origin: "https://devs.egdata.app" });
    const token = "egc_test_private_session";
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: token }), {
          headers: {
            "Content-Type": "application/json",
            "X-Egdata-Console-Session": token,
            "X-Diagnostic": token,
          },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const session = { token, expiresAt: Date.now() + 600000 };
    const result = await executeOperation(
      op,
      "",
      { id: "abc" },
      {},
      "",
      new AbortController().signal,
      session,
    );
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("X-Egdata-Console-Session")).toBe(
      token,
    );
    expect(JSON.stringify(result)).not.toContain(token);
    expect(redactedSnippet(op)).not.toContain(token);
    await expect(
      executeOperation(
        op,
        "",
        { id: "abc" },
        {},
        "",
        new AbortController().signal,
        { ...session, expiresAt: Date.now() },
      ),
    ).rejects.toThrow("expired");
    await expect(
      executeOperation(
        op,
        "key",
        { id: "abc" },
        {},
        "",
        new AbortController().signal,
        session,
      ),
    ).rejects.toThrow("Choose");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps build-only or removed operations read-only when deployment differs", () => {
    const snapshot = safeDocument({
      openapi: "3.0.3",
      paths: {
        [op.path]: { get: op.operation },
      },
    });
    expect(
      operationReference(op.operationId, null, snapshot).deployed,
    ).toBeUndefined();
    expect(
      operationReference(op.operationId, null, snapshot).reference?.operationId,
    ).toBe(op.operationId);
    const deployed = safeDocument({ openapi: "3.0.3", paths: {} });
    expect(
      operationReference(op.operationId, deployed, snapshot).deployed,
    ).toBeUndefined();
    expect(
      operationReference(op.operationId, snapshot, deployed).deployed
        ?.operationId,
    ).toBe(op.operationId);
    expect(
      executable({ ...op, path: "/v1/health", operationId: "unknown" }),
    ).toBe(false);
    expect(
      executable({
        ...op,
        path: "/v1/health",
        operationId: "getHealth",
        method: "POST",
      }),
    ).toBe(false);
  });
  it("allows only registered v1 operations and blocks path/host injection", () => {
    expect(requestUrl(op, { id: "abc" }, { country: "US" })).toBe(
      "/proxy/v1/offers/abc?country=US",
    );
    for (const id of [
      "../health",
      "a/b",
      "%2Fhealth",
      "..",
      "x?secret=y",
      "x\\y",
    ]) {
      expect(() => requestUrl(op, { id }, {})).toThrow();
    }
    expect(
      executable({ ...op, path: "https://evil.example/v1/offers/{id}" }),
    ).toBe(false);
    expect(() =>
      requestUrl({ ...op, operationId: "removedOperation" }, { id: "abc" }, {}),
    ).toThrow();
  });
  it("removes server overrides and rejects external schema references", () => {
    const doc = safeDocument({
      openapi: "3.0.3",
      info: { title: "API", version: "1" },
      servers: [{ url: "https://evil.example" }],
      paths: {
        "/v1/offers": {
          servers: [{ url: "https://evil.example" }],
          get: { operationId: "listOffers", responses: {} },
        },
        "/legacy": { get: {} },
      },
    });
    expect(doc.servers).toEqual([
      { url: "/proxy", description: "Same-origin v1 gateway" },
    ]);
    expect(doc.paths["/v1/offers"]?.servers).toBeUndefined();
    expect(doc.paths["/legacy"]).toBeUndefined();
    expect(() =>
      safeDocument({
        ...doc,
        components: {
          schemas: { Bad: { $ref: "https://evil.example/schema" } },
        },
      }),
    ).toThrow("External");
  });
  it("sends credentials only to the proxy and redacts echoed keys and snippets", async () => {
    vi.stubGlobal("location", { origin: "https://devs.egdata.app" });
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ echo: "private_key" }), {
          status: 403,
          headers: {
            "Content-Type": "application/problem+json",
            "X-API-Key": "private_key",
          },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await executeOperation(
      op,
      "private_key",
      { id: "abc" },
      {},
      "",
      new AbortController().signal,
    );
    expect(fetcher.mock.calls[0][0]).toBe("/proxy/v1/offers/abc");
    expect(result.status).toBe(403);
    expect(result.kind).toBe("json");
    expect(result.text).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("private_key");
    expect(redactedSnippet(op)).toContain("<YOUR_API_KEY>");
    expect(redactedSnippet(op)).not.toContain("\n+");
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("manual");
  });
  it("preserves XML, images and native binary responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<xml/>", {
            headers: { "Content-Type": "application/xml" },
          }),
      ),
    );
    expect(
      (
        await executeOperation(
          op,
          "",
          { id: "x" },
          {},
          "",
          new AbortController().signal,
        )
      ).kind,
    ).toBe("text");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0, 1, 2]), {
            headers: { "Content-Type": "image/png" },
          }),
      ),
    );
    expect(
      (
        await executeOperation(
          op,
          "",
          { id: "x" },
          {},
          "",
          new AbortController().signal,
        )
      ).kind,
    ).toBe("image");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([0, 1, 2]))),
    );
    expect(
      (
        await executeOperation(
          op,
          "",
          { id: "x" },
          {},
          "",
          new AbortController().signal,
        )
      ).kind,
    ).toBe("binary");
  });
  it("groups operations by primary resource tag in declared OpenAPI order without duplicates", () => {
    const multiTagged: Operation = {
      operationId: "autocomplete",
      method: "GET",
      path: "/v1/autocomplete",
      operation: {
        operationId: "autocomplete",
        tags: ["Catalog", "Search"],
        responses: {},
      },
    };
    const searchOp: Operation = {
      operationId: "searchOffers",
      method: "POST",
      path: "/v1/search",
      operation: {
        operationId: "searchOffers",
        tags: ["Search"],
        responses: {},
      },
    };
    const historyOp: Operation = {
      operationId: "legacyRemoved",
      method: "GET",
      path: "/v1/legacy",
      operation: {
        operationId: "legacyRemoved",
        tags: ["Merged history"],
        responses: {},
      },
    };
    const untagged: Operation = {
      operationId: "misc",
      method: "GET",
      path: "/v1/misc",
      operation: {
        operationId: "misc",
        responses: {},
      },
    };

    const groups = groupOperationsByResource(
      [untagged, historyOp, searchOp, multiTagged],
      [
        { name: "Catalog", description: "Cross-catalog discovery." },
        { name: "Search", description: "Faceted search." },
      ],
    );

    expect(groups.map((g) => g.name)).toEqual([
      "Catalog",
      "Search",
      "Merged history",
      "Other",
    ]);
    expect(groups[0]?.description).toBe("Cross-catalog discovery.");
    expect(groups[0]?.operations.map((o) => o.operationId)).toEqual([
      "autocomplete",
    ]);
    expect(groups[1]?.operations.map((o) => o.operationId)).toEqual([
      "searchOffers",
    ]);
  });
  it("builds redacted cURL snippets with filled parameters and request body", () => {
    vi.stubGlobal("location", { origin: "https://devs.egdata.app" });
    const postOp: Operation = {
      operationId: "searchPost",
      method: "POST",
      path: "/v1/offers/{id}/search",
      operation: { operationId: "searchPost", responses: {} },
    };
    const snippet = redactedSnippet(
      postOp,
      { id: "fn" },
      { country: "US", empty: "" },
      '{"title":"Fortnite"}',
    );
    expect(snippet).toContain(
      "https://devs.egdata.app/proxy/v1/offers/fn/search?country=US",
    );
    expect(snippet).toContain("-H 'X-API-Key: <YOUR_API_KEY>'");
    expect(snippet).toContain("-H 'Content-Type: application/json'");
    expect(snippet).toContain('-d \'{"title":"Fortnite"}\'');
  });
});
