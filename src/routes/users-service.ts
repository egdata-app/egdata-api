import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { epicStoreClient } from "../clients/epic.js";

interface Playtime {
  accountId: string;
  artifactId: string;
  totalTime: number;
}

const app = new Hono();

const middleware = createMiddleware<{
  Variables: {
    jwt: {
      sub: string;
      iss: string;
      dn: string;
      nonce: string;
      pfpid: string;
      sec: number;
      aud: string;
      t: string;
      scope: string;
      appid: string;
      exp: number;
      iat: number;
      jti: string;
    };
    access_token: string;
  };
}>(async (c, next) => {
  // Check if the user is authenticated
  if (!c.req.header("Authorization")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const authorization = c.req.header("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return c.json({ error: "Invalid authorization header" }, 401);
  }

  const supplied = authorization.slice("Bearer ".length);
  const token = supplied.startsWith("eg1~") ? supplied.slice(4) : supplied;

  const decoded = jwt.decode(token) as {
    sub: string;
    iss: string;
    dn: string;
    nonce: string;
    pfpid: string;
    sec: number;
    aud: string;
    t: string;
    scope: string;
    appid: string;
    exp: number;
    iat: number;
    jti: string;
  };

  if (!decoded || typeof decoded.sub !== "string" || !decoded.sub) {
    console.error("Invalid JWT");
    return c.json({ error: "Invalid JWT" }, 401);
  }

  // Check if it's expired
  const expirationDate = new Date(decoded.exp * 1000);

  if (expirationDate < new Date()) {
    console.error("JWT is expired");
    return c.json({ error: "JWT is expired" }, 401);
  }

  try {
    const response = await fetch("https://api.epicgames.dev/epic/oauth/v2/tokenInfo", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({token:supplied}),
    });
    if (!response.ok) return c.json({ error: "Invalid JWT" }, 401);
    const verified = (await response.json()) as { active?: unknown; account_id?: unknown } | null;
    if (verified?.active !== true || verified.account_id !== decoded.sub) {
      return c.json({ error: "Invalid JWT" }, 401);
    }
  } catch {
    return c.json({ error: "Invalid JWT" }, 401);
  }
  c.set("jwt", decoded);
  c.set("access_token", `eg1~${token}`);

  await next();
});

app.get("/", middleware, async (c) => {
  return c.json({ message: "Hello, World!" });
});

app.post("/playtime", middleware, async (c) => {
  const body = await c.req.json<Playtime[]>();

  const jwt = c.var.jwt;

  const id = jwt.sub;

  const correctEntries = body.filter(
    (p) => p.accountId === id && p.artifactId
  );

  await Promise.all(
    correctEntries.map(async (p) => {
      await db.db.collection("playtime").updateOne(
        {
          accountId: p.accountId,
          artifactId: p.artifactId,
        },
        {
          $set: {
            totalTime: p.totalTime,
          },
        },
        {
          upsert: true,
        }
      );
    })
  );

  return c.json({ message: "ok" });
});

interface Ownership {
  id: string;
  namespace: string;
}

app.post("/ownership", middleware, async (c) => {
  const body = await c.req.json<Ownership[]>();

  const correctEntries = body.filter((o) => o.id && o.namespace);

  const client = epicStoreClient;

  const ownership = await client.checkOwnership(correctEntries, c.var.access_token);

  return c.json(ownership);
});

export default app;
