import { it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { DB } from "../src/db/index.js";

const captures = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(uri: string, opts: unknown) {
      captures.calls.push({ uri, opts });
    }
    async connect() {}
    db(name: string) {
      return { databaseName: name };
    }
    async close() {}
  },
}));
vi.mock("../src/utils/logger.js", () => ({
  consola: { info: () => {}, success: () => {} },
}));

it("captures the production driver's URI, certificate path and required environment configuration", async () => {
  const base = {
    MONGO_URL: "catalog.example.invalid",
    MONGO_CA: "ca.pem",
    MONGO_CERT: "client.pem",
  };
  const cases = [];
  for (const input of [
    {},
    { MONGO_URL: "" },
    { MONGO_URL: base.MONGO_URL },
    { MONGO_URL: base.MONGO_URL, MONGO_CA: base.MONGO_CA },
    base,
    { ...base, MONGO_URL: "mongodb://127.0.0.1:27017/database?appName=api" },
    {
      ...base,
      MONGO_URL: "mongodb+srv://db.example.invalid/?retryWrites=true",
    },
    {
      ...base,
      MONGO_CA: " certificate with spaces.pem ",
      MONGO_CERT: "  signed.pem",
    },
    { ...base, MONGO_URL: "  standalone.invalid " },
    { ...base, MONGO_CA: " " },
    { ...base, MONGO_CERT: "" },
  ]) {
    const env: Record<string, string | undefined> = input;
    for (const k of Object.keys(base)) vi.stubEnv(k, env[k]);
    captures.calls.length = 0;
    try {
      const db = new DB();
      await db.connect();
      cases.push({
        input,
        output: { driver: captures.calls[0], database: db.db.databaseName },
      });
    } catch (e) {
      cases.push({ input, output: { error: (e as Error).message } });
    } finally {
      vi.unstubAllEnvs();
    }
  }
  assertOracle("mongo-driver-config-node", cases);
});
