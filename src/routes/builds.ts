import { Hono } from "hono";
import { db } from "../db/index.js";
import { Item } from "@egdata/core.schemas.items";
import { Asset } from "@egdata/core.schemas.assets";
import { type Filter, ObjectId, type Sort } from "mongodb";
import type { AnyObject } from "mongoose";
import client from "../clients/redis.js";

const app = new Hono();

app.get("/", async (c) => {
  const sortBy = (c.req.query("sortBy") || "createdAt") as "createdAt" | "updatedAt";
  const sortDir = (c.req.query("sortDir") || "desc") as "asc" | "desc";
  const limit = Number.parseInt(c.req.query("limit") || "10", 10);
  const page = Number.parseInt(c.req.query("page") || "1", 10);
  const skip = (page - 1) * limit;

  if (!["createdAt", "updatedAt"].includes(sortBy)) {
    return c.json({ error: "Invalid sortBy parameter" }, 400);
  }

  if (!["asc", "desc"].includes(sortDir)) {
    return c.json({ error: "Invalid sortDir parameter" }, 400);
  }

  const cacheKey = `builds:${sortBy}:${sortDir}:${limit}:${page}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached));
  }

  const sort: Sort = { [sortBy]: sortDir === "asc" ? 1 : -1 };

  const builds = await db.db
    .collection<{
      appName: string;
      buildVersion: string;
      labelName: string;
      hash: string;
    }>("builds")
    .find()
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .toArray();

  const apps = builds.map((b) => b.appName)

  const items = await Item.find({
    "releaseInfo.appId": { $in: apps },
    entitlementType: "EXECUTABLE"
  })

  const results = builds.map((b) => {
    const item = items.find((i) => i.releaseInfo.some((r) => r.appId === b.appName))
    return {
      ...b,
      item,
    }
  })

  /**
   * 10 minutes
   */
  const CACHE_EXPIRATION = 60 * 10;

  await client.set(cacheKey, JSON.stringify(results), "EX", CACHE_EXPIRATION);

  return c.json(results);
});

app.get("/:id", async (c) => {
  const { id } = c.req.param();

  const build = await db.db.collection("builds").findOne({
    _id: new ObjectId(id),
  });

  if (!build) {
    return c.json({ error: "Build not found" }, 404);
  }

  const asset = await Asset.findOne({
    artifactId: build.appName,
    platform: build.labelName.split("-")[1],
  });

  return c.json({
    ...build,
    downloadSizeBytes: asset?.downloadSizeBytes,
    installedSizeBytes: asset?.installedSizeBytes,
  });
});

app.get("/:id/files", async (c) => {
  const { id } = c.req.param();
  const limit = Number.parseInt(c.req.query("limit") || "25", 10);
  const page = Number.parseInt(c.req.query("page") || "1", 10);
  const sort = c.req.query("sort") || "depth";
  const direction = c.req.query("dir") || "asc";
  const filename = c.req.query("q");

  // Get the extension(s) query parameter, expecting a comma-separated list if there are multiple
  const extensions = c.req.query("extension")?.split(",");

  const build = await db.db.collection("builds").findOne({
    _id: new ObjectId(id),
  });

  if (!build) {
    return c.json({ error: "Build not found" }, 404);
  }

  // Base query
  const query: Filter<AnyObject> = {
    manifestHash: build.hash,
  };

  const sortQuery: Sort = {};

  if (filename && extensions) {
    // Both filename and extensions are provided
    query.$and = [
      { fileName: { $regex: new RegExp(filename, "i") } },
      {
        fileName: { $regex: new RegExp(`\\.(${extensions.join("|")})$`, "i") },
      },
    ];
  } else if (filename) {
    // Only filename is provided
    query.fileName = { $regex: new RegExp(filename, "i") };
  } else if (extensions) {
    // Only extensions are provided
    query.fileName = {
      $regex: new RegExp(`\\.(${extensions.join("|")})$`, "i"),
    };
  }

  if (sort === "depth") {
    sortQuery.depth = direction === "asc" ? 1 : -1;
    sortQuery.fileName = direction === "asc" ? 1 : -1;
  } else if (sort === "fileName") {
    sortQuery.fileName = direction === "asc" ? 1 : -1;
  } else if (sort === "fileSize") {
    sortQuery.fileSize = direction === "asc" ? 1 : -1;
  }

  const files = await db.db
    .collection("files")
    .find(query)
    .sort(sortQuery)
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  const total = await db.db.collection("files").countDocuments(query);

  return c.json({
    files,
    page,
    limit,
    total,
  });
});

app.get("/:id/items", async (c) => {
  const { id } = c.req.param();
  const limit = Number.parseInt(c.req.query("limit") || "25", 10);
  const page = Number.parseInt(c.req.query("page") || "1", 10);

  const build = await db.db.collection("builds").findOne({
    _id: new ObjectId(id),
  });

  if (!build) {
    return c.json({ error: "Build not found" }, 404);
  }

  const items = await Item.find({
    "releaseInfo.appId": build.appName,
  })
    .skip((page - 1) * limit)
    .limit(limit);

  const total = await Item.countDocuments({
    "releaseInfo.appId": build.appName,
  });

  return c.json({
    data: items,
    page,
    limit,
    total,
  });
});

app.get("/:id/install-options", async (c) => {
  const { id } = c.req.param();

  const build = await db.db.collection("builds").findOne({
    _id: new ObjectId(id),
  });

  if (!build) {
    return c.json({ error: "Build not found" }, 404);
  }

  const filesWithInstallOptions = await db.db
    .collection<{
      manifestHash: string;
      installTags: string[];
      fileHash: string;
      fileSize: number;
    }>("files")
    .find({
      manifestHash: build.hash,
      installTags: {
        $exists: true,
        $not: { $size: 0 },
      },
    })
    .toArray();

  const result: Record<
    string,
    {
      files: number;
      size: number;
    }
  > = {};

  for (const file of filesWithInstallOptions) {
    const installOptions = file.installTags.map((t) => t);

    for (const installOption of installOptions) {
      if (!result[installOption]) {
        result[installOption] = {
          files: 0,
          size: 0,
        };
      }

      result[installOption].files++;
      result[installOption].size += file.fileSize;
    }
  }

  return c.json(result);
});

export default app;
