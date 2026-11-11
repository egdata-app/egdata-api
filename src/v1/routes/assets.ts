import { Hono } from "hono";
import { Asset } from "../../models/index.js";
import { cached, v1CacheKey } from "../cache.js";
import { notFound, ProblemError, problemResponse } from "../errors.js";
import { requireIdParam } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import { serializeValue } from "../serialization.js";

const app = new Hono<{ Variables: V1Variables }>();

const ASSET_CACHE_TTL_SECONDS = 60 * 60;

app.get("/assets/:id", async (c) => {
  const id = requireIdParam(c);

  const asset = await cached<unknown>(
    v1CacheKey("assets.detail", { id }),
    ASSET_CACHE_TTL_SECONDS,
    async () => {
      const found = await Asset.findOne({ artifactId: { $eq: id } }).lean();
      if (!found) {
        throw notFound(
          "ASSET_NOT_FOUND",
          `No asset with artifact ID '${id}' exists.`,
        );
      }
      return serializeValue(found);
    },
  );

  return jsonSuccess(c, asset);
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
