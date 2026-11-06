// Isolated staging harness. Never imports production DB/Redis or application env.
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createAntiAbuse } from "../src/middleware/anti-abuse.js";
import { AbuseScorer } from "../src/services/abuse-scorer.js";
import { PowSessionService } from "../src/services/pow-session.js";

const app = new Hono(),
  scorer = new AbuseScorer();
let risk = 0,
  offset = 0,
  handshakes = 0;
scorer.risk = () => risk;
const now = () => Date.now() + offset;
const anti = createAntiAbuse({
  mode: "enforce",
  scorer,
  sessions: new PowSessionService(
    "isolated-staging-secret-not-for-production",
    now,
  ),
  now,
  delay: async () => {},
});
app.get("/", async (c) =>
  c.html(
    await readFile(
      new URL("./fixtures/anti-abuse-browser.html", import.meta.url),
      "utf8",
    ),
  ),
);
app.post("/test/config", async (c) => {
  const body = await c.req.json();
  risk = Number(body.risk);
  offset = Number(body.offset ?? 0);
  return c.json({ risk, handshakes });
});
app.get("/test/state", (c) => c.json({ handshakes }));
app.use("*", async (c, next) => {
  Object.assign(c.req.raw, {
    cf: {
      tlsCipher: "AEAD-AES128-GCM-SHA256",
      tlsVersion: "TLSv1.3",
      asn: 1234,
      httpProtocol: "HTTP/2",
    },
  });
  await next();
});
app.use("*", anti.middleware);
app.post("/auth/challenge", async (c, next) => {
  handshakes++;
  return anti.challenge(c, next);
});
app.get("/items/:id", (c) =>
  c.json({ id: c.req.param("id"), normal: true }, 200, {
    "Cache-Control": "public, max-age=60",
  }),
);
const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
  (info) => console.log(`STAGING_URL=http://127.0.0.1:${info.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    scorer.close();
    server.close();
  });
