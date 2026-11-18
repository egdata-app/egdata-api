import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { queryOffersWithNaturalLanguage } from "../src/clients/vectorize.js";

function canonicalGzip(input: Buffer): Buffer {
  const gz = Buffer.from(gzipSync(input));
  // Normalize the RFC 1952 OS header byte so Windows (0x0a) and Linux (0x03) match the recorded oracle.
  if (gz.length >= 10) gz[9] = 0x0a;
  return gz;
}

type Reply = {
  status: number;
  type: string;
  body: string;
  drop?: boolean;
  truncated?: boolean;
  encoding?: string;
  wireHex?: string;
  location?: string;
};
type Input = {
  service: "open" | "meili" | "vector";
  base?: string;
  env?: Record<string, string>;
  index?: string;
  replies: Reply[];
  multi?: boolean;
  op?: "getMapping" | "putMapping";
};
const reply = (body: unknown, status = 200): Reply => ({
  status,
  type: "application/json",
  body: JSON.stringify(body),
});
const ok = reply({ hits: [] });
const embed = reply({ result: { data: [[0, 0.125, 1e-7]] } });
const query = { q: "co-op ★", limit: 7 };
const search = { query: { match_all: {} }, min_score: 1e-7 };
const index = "sale *~!()'+,2026";
const inputs: Record<string, Input> = {
  "OpenSearch empty address": {
    service: "open",
    base: "",
    replies: [],
  },
  "Vectorize blank configuration token": {
    service: "vector",
    env: { CLOUDFLARE_API_TOKEN: " " },
    replies: [],
  },
  "Vectorize interrupted embedding request": {
    service: "vector",
    replies: [{ ...ok, drop: true }],
  },
  "Vectorize interrupted query request": {
    service: "vector",
    replies: [embed, { ...ok, drop: true }],
  },
  "Vectorize empty error entries": {
    service: "vector",
    replies: [reply({ errors: [{}, { message: "later" }, {}] }, 503)],
  },
  "Meili prefixed host with trailing slash": {
    service: "meili",
    base: "http://HOST/prefix/",
    replies: [ok],
  },
  "Vectorize scalar embedding result": {
    service: "vector",
    replies: [reply({ result: 42 })],
  },
  "Vectorize missing data property": {
    service: "vector",
    replies: [reply({ result: {} })],
  },
  "Vectorize null embedding rows": {
    service: "vector",
    replies: [reply({ result: { data: null } })],
  },
  "Vectorize missing array-like row": {
    service: "vector",
    replies: [reply({ result: { data: {} } })],
  },
  "Vectorize floating zero object length": {
    service: "vector",
    replies: [{ ...embed, body: '{"result":{"data":[{"length":0.0}]}}' }],
  },
  "Vectorize string object length": {
    service: "vector",
    replies: [reply({ result: { data: [{ length: "0" }] } })],
  },
  "Vectorize out-of-range scalar embedding": {
    service: "vector",
    replies: [{ ...embed, body: '{"result":{"data":[1e999]}}' }],
  },
  "Vectorize out-of-range array coordinate": {
    service: "vector",
    replies: [{ ...embed, body: '{"result":{"data":[[1e999]]}}' }],
  },
  "Vectorize duplicate indexed embedding row": {
    service: "vector",
    replies: [
      { ...embed, body: '{"result":{"data":{"0":42,"0":[0.25]}}}' },
      reply({ result: { matches: [] } }),
    ],
  },
  "Vectorize duplicate data property": {
    service: "vector",
    replies: [
      { ...embed, body: '{"result":{"data":null,"d\\u0061ta":[[0.25]]}}' },
      reply({ result: { matches: [] } }),
    ],
  },
  "Vectorize duplicate response result": {
    service: "vector",
    replies: [
      { ...embed, body: '{"result":null,"result":{"data":[[0.25]]}}' },
      reply({ result: { matches: [] } }),
    ],
  },
  "Vectorize empty string embedding": {
    service: "vector",
    replies: [reply({ result: { data: [""] } })],
  },
  "Vectorize false embedding": {
    service: "vector",
    replies: [reply({ result: { data: [false] } })],
  },
  "Vectorize true embedding": {
    service: "vector",
    replies: [reply({ result: { data: [true] } })],
  },
  "OpenSearch invalid encoded username": {
    service: "open",
    base: "http://%FF:fixture@HOST",
    replies: [],
  },
  "OpenSearch interrupted gzip payload": {
    service: "open",
    replies: [
      {
        ...ok,
        encoding: "gzip",
        wireHex: canonicalGzip(Buffer.from(ok.body)).subarray(0, 10).toString("hex"),
      },
    ],
  },
  "Vectorize malformed JSON object": {
    service: "vector",
    replies: [{ ...embed, body: '{"result":' }],
  },
  "Vectorize missing first embedding row": {
    service: "vector",
    replies: [reply({ result: { data: [] } })],
  },
  "Vectorize malformed embedding rows": {
    service: "vector",
    replies: [reply({ result: { data: 42 } })],
  },
  "Vectorize array-like embedding rows": {
    service: "vector",
    replies: [
      reply({ result: { data: { "0": [0.25, 0.5] } } }),
      reply({ result: { matches: [] } }),
    ],
  },
  "Vectorize string embedding rows": {
    service: "vector",
    replies: [reply({ result: { data: "broken" } })],
  },
  "nonstandard upstream failure status": {
    service: "open",
    replies: [reply({ message: "proxy failure" }, 600)],
  },
  "OpenSearch exhausts aborted responses": {
    service: "open",
    replies: [{ ...ok, truncated: true }],
  },
  "OpenSearch exhausts dropped connections": {
    service: "open",
    replies: [{ ...ok, drop: true }],
  },
  "OpenSearch stops on malformed retryable error JSON": {
    service: "open",
    replies: [{ ...ok, status: 503, body: "incomplete JSON" }, ok],
  },
  "OpenSearch text response after retries": {
    service: "open",
    replies: [
      reply({}, 502),
      reply({}, 503),
      reply({}, 504),
      { ...ok, type: "text/plain", body: "ready" },
    ],
  },
  "Meili URL userinfo": {
    service: "meili",
    base: "http://fixture:example@HOST",
    replies: [ok],
  },
  "Meili Latin-1 key": {
    service: "meili",
    env: { MEILISEARCH_API_KEY: "fixture-café" },
    replies: [ok],
  },
  "Meili unrepresentable key": {
    service: "meili",
    env: { MEILISEARCH_API_KEY: "fixture🔍" },
    replies: [],
  },
  "Meili malformed header": {
    service: "meili",
    env: { MEILISEARCH_API_KEY: "fixture\nvalue" },
    replies: [],
  },
  "Meili blank key": {
    service: "meili",
    env: { MEILISEARCH_API_KEY: "    " },
    replies: [ok],
  },
  "Meili interrupted server response": {
    service: "meili",
    replies: [{ ...ok, truncated: true }],
  },
  "Meili dropped connection": {
    service: "meili",
    replies: [{ ...ok, drop: true }],
  },
  "Meili truncated multi search response": {
    service: "meili",
    multi: true,
    replies: [{ ...ok, truncated: true }],
  },
  "Meili malformed successful multi search JSON": {
    service: "meili",
    multi: true,
    replies: [{ ...ok, body: "not-json" }],
  },
  "Vectorize malformed error envelope": {
    service: "vector",
    replies: [reply(null, 400)],
  },
  "Vectorize null error descriptions": {
    service: "vector",
    replies: [reply({ errors: [{ code: null, message: "retry" }] }, 429)],
  },
  "Vectorize nullable first row": {
    service: "vector",
    replies: [reply({ result: { data: [null] } })],
  },
  "Vectorize interrupted result body": {
    service: "vector",
    replies: [{ ...embed, truncated: true }],
  },
  "Vectorize malformed errors collection": {
    service: "vector",
    replies: [reply({ errors: {} }, 403)],
  },
  "Vectorize null error entry": {
    service: "vector",
    replies: [reply({ errors: [null] }, 429)],
  },
  "unsupported protocol": { service: "open", base: "ftp://HOST", replies: [] },
  "recover after socket close": {
    service: "open",
    replies: [{ ...ok, drop: true }, ok],
  },
  "recover after interrupted search response": {
    service: "open",
    replies: [{ ...ok, truncated: true }, ok],
  },
  ...Object.fromEntries(
    [
      ["gzip", canonicalGzip(Buffer.from(ok.body))],
      ["deflate", deflateSync(Buffer.from(ok.body))],
      ["br", brotliCompressSync(Buffer.from(ok.body))],
      ["broken-gzip", Buffer.from("bad")],
    ].map(([name, bytes]) => [
      "compressed OpenSearch " + name,
      {
        service: "open",
        replies: [
          {
            ...ok,
            encoding: name === "broken-gzip" ? "gzip" : name,
            wireHex: (bytes as Buffer).toString("hex"),
          },
          ok,
        ],
      },
    ]),
  ),
  "interrupted mapping response": {
    service: "open",
    op: "getMapping",
    index: "offers",
    replies: [{ ...ok, truncated: true }, reply({ error: "forbidden" }, 403)],
  },
  "invalid UTF-8 URL credentials": {
    service: "open",
    base: "http://x:p%FF@HOST",
    replies: [],
  },
  "Meili malformed service address": {
    service: "meili",
    base: "http://host with spaces",
    replies: [],
  },
  "Meili redirected POST": {
    service: "meili",
    replies: [{ ...ok, status: 303, location: "/result" }, ok],
  },
  "Vectorize numeric embedding instead of array": {
    service: "vector",
    replies: [reply({ result: { data: [123] } })],
  },
  "Vectorize zero embedding instead of array": {
    service: "vector",
    replies: [reply({ result: { data: [0] } })],
  },
  "Vectorize object embedding with a zero length": {
    service: "vector",
    replies: [reply({ result: { data: [{ length: 0 }] } })],
  },
  "redirect location is not followed": {
    service: "open",
    replies: [{ ...ok, status: 307, location: "/next" }, ok],
  },
  "mapping with unrelated index": {
    service: "open",
    op: "getMapping",
    index: "offers",
    replies: [reply({ other: { mappings: {} } })],
  },
  "mapping with null mappings": {
    service: "open",
    op: "getMapping",
    index: "offers",
    replies: [reply({ offers: { mappings: null } })],
  },
  "mapping with entries": {
    service: "open",
    op: "getMapping",
    index: "offers",
    replies: [
      reply({
        offers: { mappings: { properties: { title: { type: "keyword" } } } },
      }),
    ],
  },
  "mapping 404": {
    service: "open",
    op: "getMapping",
    index: "offers",
    replies: [reply({ error: "not found" }, 404)],
  },
  "mapping put retries": {
    service: "open",
    op: "putMapping",
    index: "offers",
    replies: [reply({}, 504), reply({ acknowledged: true })],
  },
  "mapping invalid successful JSON": {
    service: "open",
    op: "putMapping",
    index: "offers",
    replies: [{ ...ok, body: "bad" }],
  },
  "Vectorize null result": {
    service: "vector",
    replies: [reply({ result: null })],
  },
  "Vectorize null envelope": { service: "vector", replies: [reply(null)] },
  "Vectorize non-array matches": {
    service: "vector",
    replies: [embed, reply({ result: { matches: "invalid" } })],
  },
  "Vectorize null hit": {
    service: "vector",
    replies: [embed, reply({ result: { matches: [null] } })],
  },
  "Vectorize non-array first embedding": {
    service: "vector",
    replies: [reply({ result: { data: ["wrong"] } })],
  },
  "Vectorize null search result": {
    service: "vector",
    replies: [embed, reply({ result: null })],
  },
  "Vectorize primitive result gives no matches": {
    service: "vector",
    replies: [embed, reply({ result: 42 })],
  },
  "OpenSearch large integer and BOM": {
    service: "open",
    replies: [{ ...ok, body: '\uFEFF{"id":9007199254740993}' }],
  },
  "URL credentials override separate credentials": {
    service: "open",
    base: "http://url%20user:pass%3Aword@HOST/prefix?tenant=one#frag",
    env: { OPENSEARCH_USERNAME: " api ", OPENSEARCH_PASSWORD: " key " },
    index,
    replies: [ok],
  },
  "credentials are trimmed as JavaScript strings": {
    service: "open",
    env: {
      OPENSEARCH_USERNAME: "\uFEFFtest\uFEFF",
      OPENSEARCH_PASSWORD: "\uFEFFcode\uFEFF",
    },
    replies: [ok],
  },
  "partial URL credentials without separate credentials": {
    service: "open",
    base: "http://orphan@HOST",
    replies: [ok],
  },
  "partial URL credentials plus separate credentials": {
    service: "open",
    base: "http://orphan@HOST",
    env: { OPENSEARCH_USERNAME: "api", OPENSEARCH_PASSWORD: "pwd" },
    replies: [ok],
  },
  "blank separate password": {
    service: "open",
    env: { OPENSEARCH_PASSWORD: "" },
    replies: [],
  },
  "partial separate credentials": {
    service: "open",
    env: { OPENSEARCH_USERNAME: "x" },
    replies: [],
  },
  "malformed credential encoding": {
    service: "open",
    base: "http://x:p%ZZ@HOST",
    replies: [],
  },
  "missing embedded user": {
    service: "open",
    base: "http://:password@HOST",
    replies: [ok],
  },
  "invalid URL": { service: "open", base: "invalid URL", replies: [] },
  "gateway retries": {
    service: "open",
    replies: [reply({}, 502), reply({}, 503), reply({}, 504), ok],
  },
  "retry ceiling": {
    service: "open",
    replies: [reply({ error: "busy" }, 503)],
  },
  "auth is terminal": {
    service: "open",
    replies: [reply({ error: "auth" }, 401), ok],
  },
  "throttling is terminal": {
    service: "open",
    replies: [reply({ error: "throttled" }, 429), ok],
  },
  "invalid json before retry": {
    service: "open",
    replies: [{ ...ok, status: 502, body: "bad" }],
  },
  "vendor json": {
    service: "open",
    replies: [{ ...ok, type: "application/vnd.opensearch+json" }],
  },
  "plain text body": {
    service: "open",
    replies: [{ ...ok, type: "text/plain" }],
  },
  "redirect is returned by SDK": {
    service: "open",
    replies: [{ status: 302, type: "text/plain", body: "moved" }],
  },
  "empty body": { service: "open", replies: [{ ...ok, body: "" }] },
  "Meili index and key": {
    service: "meili",
    base: "HOST/prefix",
    index: "offers-previews",
    env: { MEILISEARCH_API_KEY: "key" },
    replies: [ok],
  },
  "Meili multi search": {
    service: "meili",
    multi: true,
    replies: [reply({ results: [] })],
  },
  "Meili empty body": { service: "meili", replies: [{ ...ok, body: "" }] },
  "Meili malformed error": {
    service: "meili",
    replies: [{ ...ok, status: 403, body: "invalid" }],
  },
  "Meili structured error": {
    service: "meili",
    replies: [reply({ message: "denied", code: "invalid_api_key" }, 403)],
  },
  "Meili UTF8 BOM": {
    service: "meili",
    replies: [{ ...ok, body: `\uFEFF${ok.body}` }],
  },
  "Vectorize matches and path": {
    service: "vector",
    index,
    replies: [
      embed,
      reply({
        result: {
          matches: [{ id: "a", score: 1, metadata: { title: "Game" } }],
        },
      }),
    ],
  },
  "Vectorize invalid individual hits": {
    service: "vector",
    replies: [
      embed,
      reply({
        result: {
          matches: [
            { id: 1, score: 1 },
            { id: "wrong", score: "bad" },
            { id: "", score: 1 },
            { id: "ok", score: 0.1 },
          ],
        },
      }),
    ],
  },
  "Vectorize embedding accepts only first row": {
    service: "vector",
    replies: [
      reply({ result: { data: [[0.5], "ignore this"] } }),
      reply({ result: {} }),
    ],
  },
  "Vectorize rejects non-numeric embedding": {
    service: "vector",
    replies: [reply({ result: { data: [[0.5, "1"]] } })],
  },
  "Vectorize wrong envelope shape": {
    service: "vector",
    replies: [reply(["x"])],
  },
  "Vectorize explicit code and empty message": {
    service: "vector",
    replies: [
      reply(
        {
          success: false,
          result: { data: "not-an-embedding" },
          errors: [{ code: 23, message: "" }, { message: "bad request" }],
        },
        403,
      ),
    ],
  },
  "Vectorize invalid JSON": {
    service: "vector",
    replies: [{ ...ok, body: "bad" }],
  },
  "Vectorize missing result": {
    service: "vector",
    replies: [reply({ success: true })],
  },
};
it("captures the installed search clients against a loopback HTTP origin", async () => {
  const fetchLocal = globalThis.fetch;
  const records = [];
  for (const [name, input] of Object.entries(inputs)) {
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response =
        input.replies[Math.min(requests.length, input.replies.length - 1)];
      requests.push({
        method: req.method,
        path: req.url,
        auth: req.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString(),
      });
      if (!response) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (response.drop) {
        req.socket.destroy();
        return;
      }
      res.writeHead(response.status, {
        "Content-Type": response.type,
        ...(response.location ? { Location: response.location } : {}),
        ...(response.encoding ? { "Content-Encoding": response.encoding } : {}),
        ...(response.truncated
          ? { "Content-Length": Buffer.byteLength(response.body) + 64 }
          : {}),
      });
      if (response.truncated) {
        res.write(response.body, () => res.destroy());
        return;
      }
      res.end(
        response.wireHex ? Buffer.from(response.wireHex, "hex") : response.body,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const base = (input.base ?? "http://HOST").replace("HOST", host);
    let close: (() => Promise<unknown>) | undefined;
    let output: unknown;
    try {
      vi.resetModules();
      let result: unknown;
      if (input.service === "open") {
        for (const key of ["OPENSEARCH_USERNAME", "OPENSEARCH_PASSWORD"])
          vi.stubEnv(key, input.env?.[key]);
        vi.stubEnv("OPENSEARCH_URL", base);
        const client = (
          await import("../src/clients/opensearch.js")
        ).getOpenSearchClient();
        close = () => client.close();
        if (input.op === "getMapping") {
          const idx = input.index ?? "offers";
          try {
            result =
              (await client.indices.getMapping({ index: idx })).body[idx]
                ?.mappings ?? null;
          } catch (error) {
            if (
              (error as { meta?: { statusCode?: number } }).meta?.statusCode !==
              404
            )
              throw error;
            result = null;
          }
        } else if (input.op === "putMapping") {
          await client.indices.putMapping({
            index: input.index ?? "offers",
            body: { properties: { title: { type: "keyword" } } },
          });
          result = null;
        } else
          result = (await client.search({ index: input.index, body: search }))
            .body;
      } else if (input.service === "meili") {
        vi.stubEnv("MEILISEARCH_INSTANCE", base);
        vi.stubEnv("MEILISEARCH_API_KEY", input.env?.MEILISEARCH_API_KEY ?? "");
        const { meiliSearchClient: client } = await import(
          "../src/clients/meilisearch.js"
        );
        result = input.multi
          ? await client.multiSearch({ queries: [] })
          : await client
              .index(input.index ?? "offers")
              .search(query.q, { limit: query.limit });
      } else {
        vi.stubEnv(
          "CLOUDFLARE_ACCOUNT_ID",
          input.env?.CLOUDFLARE_ACCOUNT_ID ?? "account",
        );
        vi.stubEnv(
          "CLOUDFLARE_API_TOKEN",
          input.env?.CLOUDFLARE_API_TOKEN ?? "fixture",
        );
        vi.stubEnv("VECTORIZE_INDEX_NAME", input.index);
        vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
          const target = new URL(url);
          if (target.origin !== "https://api.cloudflare.com")
            throw new Error("unexpected fixture origin");
          return fetchLocal(base + target.pathname, init);
        });
        result = await queryOffersWithNaturalLanguage(query.q, 7);
      }
      output = { value: result ?? null };
    } catch (e) {
      const err = e as Error & {
        code?: string;
        status?: number;
        statusCode?: number;
        response?: Response;
      };
      if (input.service === "vector")
        output =
          err instanceof TypeError
            ? { typeError: err.message }
            : { message: err.message, status: err.status ?? null };
      else if (
        err.name === "ConnectionError" ||
        err.name === "MeiliSearchRequestError"
      )
        output = { transportError: true };
      else if (err.code === "Z_DATA_ERROR" || err.code === "Z_BUF_ERROR")
        output = { compressionError: true };
      else if (
        input.service === "meili" &&
        err instanceof TypeError &&
        !requests.length
      )
        output = { invalidHeader: true };
      else if (requests.length === 0) output = { config: err.message };
      else if (
        err.name === "SerializationError" ||
        err.name === "DeserializationError" ||
        err instanceof SyntaxError
      )
        output = { invalidJson: true };
      else output = { status: err.statusCode ?? err.response?.status };
    } finally {
      await close?.();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    records.push({ name, input, requests, output });
  }
  assertOracle("search-clients-loopback-node", records);
});
