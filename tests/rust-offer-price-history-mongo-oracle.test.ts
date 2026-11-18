import { Hono } from "hono";
import {
  BSON,
  type Db,
  Decimal128,
  type Document,
  MongoClient,
  ObjectId,
} from "mongodb";
import { expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import {
  type V1Variables,
  v1CachePolicy,
  v1Context,
} from "../src/v1/request-context.js";
import details from "../src/v1/routes/offer-details.js";

let database: Db;
vi.mock("../src/db/index.js", () => ({
  db: {
    get db() {
      return database;
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: async () => null, set: async () => "OK" },
}));

const mongo = process.env.EGDATA_TEST_MONGO;
it.skipIf(!mongo)(
  "compares persisted regional prices, Mongo sort ties and continuations",
  async () => {
    if (!mongo) throw new Error("Disposable MongoDB URI is required");
    const client = new MongoClient(mongo, {
      tls: true,
      authMechanism: "MONGODB-X509",
      authSource: "$external",
      tlsCAFile: process.env.EGDATA_TEST_MONGO_CA,
      tlsCertificateKeyFile: process.env.EGDATA_TEST_MONGO_CERT,
    });
    await client.connect();
    database = client.db(
      "price_history_fixture_" + new ObjectId().toHexString(),
    );
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
      vi.stubEnv(
        "V1_CURSOR_SECRET",
        "deterministic-collection-cursor-secret-for-oracle",
      );
      vi.stubEnv("V1_WORKER_TOKEN", "oracle-worker");
      const app = new Hono<{ Variables: V1Variables }>();
      app.use("*", v1Context(), responseEtag, v1CachePolicy());
      app.route("/v1", details);
      app.onError((error, c) =>
        problemResponse(
          c,
          error instanceof ProblemError
            ? error
            : new ProblemError({
                status: 500,
                code: "INTERNAL_ERROR",
                detail:
                  "The API could not complete the request. Retry later and include the request ID when contacting support.",
              }),
        ),
      );
      const date = new Date("2023-03-25T23:00:00Z");
      const later = new Date("2023-05-10T18:05:00Z");
      const price = {
        offerId: "archive",
        region: "US",
        date,
        updatedAt: later,
        price: {
          originalPrice: 1999,
          discountPrice: 1499,
          currencyCode: "USD",
        },
      };
      const seed: Record<string, Document[]> = {
        offers: [
          { _id: "catalog-record", id: "archive" },
          { _id: "wrapped-date-record", id: "wrapped" },
          { _id: "missing-currency-record", id: "incomplete" },
        ],
        pricev2_historical: [
          { ...price, _id: new ObjectId("64e000000000000000000001") },
          {
            ...price,
            _id: new ObjectId("64e000000000000000000002"),
            price: { ...price.price, discountPrice: 999 },
          },
          {
            ...price,
            _id: "prior",
            date: new Date("2023-01-01"),
            updatedAt: new Date("2023-01-02"),
          },
          {
            ...price,
            _id: "text-date",
            date: "2022-11-01",
            updatedAt: "2022-11-03",
          },
          {
            ...price,
            _id: "multi-region",
            region: ["EU", "US"],
            price: { currencyCode: "EUR", originalPrice: "2450" },
          },
          {
            ...price,
            _id: "japan",
            region: "JP",
            price: {
              currencyCode: "JPY",
              originalPrice: Decimal128.fromString("950.4"),
            },
          },
          {
            ...price,
            _id: "missing-date",
            region: "EU",
            date: null,
            price: { currencyCode: "EUR", originalPrice: 0 },
          },
          {
            ...price,
            _id: "currency",
            offerId: "incomplete",
            price: { currencyCode: 7 },
          },
          {
            ...price,
            _id: "wrapped",
            offerId: "wrapped",
            date: { $date: "2024-01-01" },
          },
          { ...price, _id: "no-date", offerId: "wrapped", date: null },
        ],
      };
      for (const [name, docs] of Object.entries(seed))
        await database.collection<Document>(name).insertMany(docs);
      const cases: {
        path: string;
        localSince?: string;
        response: Awaited<ReturnType<typeof captureResponse>>;
      }[] = [];
      const capture = async (
        path: string,
        status: number,
        localSince?: Date,
      ) => {
        const local =
          localSince &&
          new Date(
            // A skipped spring-forward wall time uses the offset before the gap.
            localSince.getTime() -
              Math.max(
                localSince.getTimezoneOffset(),
                new Date(localSince.getTime() - 3_600_000).getTimezoneOffset(),
              ) *
                60_000,
          )
            .toISOString()
            .slice(0, -1);
        const response = await captureResponse(
          await app.request(
            local ? path + "&since=" + encodeURIComponent(local) : path,
            {
              headers: {
                "x-request-id": "req_node_oracle",
                "x-egdata-worker-token": "oracle-worker",
                "x-egdata-key-id": "key_oracle",
                "x-egdata-key-tier": "free",
              },
            },
          ),
        );
        expect(response.status, path).toBe(status);
        cases.push({
          path,
          ...(localSince ? { localSince: localSince.toISOString() } : {}),
          response,
        });
        return response.body;
      };
      const path = "/v1/offers/archive/price-history";
      await capture(path, 200);
      await capture(path + "?since=2023-03-01", 200);
      await capture(path + "?region=JP", 200);
      await capture(path + "?country=DE", 200);
      await capture(path + "?region=US", 200, new Date("2023-02-15T15:00:00Z"));
      let next: string | null = null;
      await capture(path + "?region=US", 200, new Date("2024-03-31T01:30:00Z"));
      await capture("/v1/offers/wrapped/price-history?region=US&limit=1", 200);
      const seen = new Set<string>();
      do {
        const body = await capture(
          path +
            "?region=US&limit=1" +
            (next ? "&cursor=" + encodeURIComponent(next) : ""),
          200,
        );
        next = body.meta.pagination.nextCursor;
        if (next) {
          expect(seen.has(next)).toBe(false);
          seen.add(next);
        }
      } while (next);
      await capture("/v1/offers/incomplete/price-history?region=US", 500);
      await capture("/v1/offers/unknown/price-history", 404);
      assertOracle("offer-price-history-stored-node", [
        {
          documents: Object.fromEntries(
            Object.entries(seed).map(([name, docs]) => [
              name,
              docs.map((doc) =>
                Buffer.from(BSON.serialize(doc)).toString("hex"),
              ),
            ]),
          ),
          cases,
        },
      ]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await database.dropDatabase();
      await client.close();
    }
  },
);
