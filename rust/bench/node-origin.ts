// Use the production Hono app and its own Mongo client. The benchmark only
// needs a loopback listener and read access to the existing catalog indexes.
import { serve } from "@hono/node-server";
import { app } from "../../src/index.js";
import { db } from "../../src/db/index.js";

export async function listen(port: number) {
  await db.connect();
  return serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
}
