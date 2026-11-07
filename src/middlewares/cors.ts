import { cors } from "hono/cors";

const allowedOrigins = new Set([
  "https://egdata.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4000",
  "https://egdata-370475041422.us-central1.run.app",
  "https://store.epicgames.com",
]);

export function allowedCorsOrigin(origin: string): string | undefined {
  if (allowedOrigins.has(origin)) return origin;
  try {
    const url = new URL(origin);
    // Serialized origins only: reject paths, credentials, opaque origins and
    // suffix lookalikes. Development exceptions are explicitly listed above.
    if (url.origin !== origin || url.protocol !== "https:" || url.port) return;
    if (url.hostname === "egdata.app" || url.hostname.endsWith(".egdata.app"))
      return origin;
  } catch {
    /* An invalid Origin receives no CORS grant. */
  }
}

export const apiCors = () =>
  cors({
    origin: allowedCorsOrigin,
    maxAge: 600,
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "apollographql-client-name",
      "apollographql-client-version",
      "apollo-require-preflight",
      "x-api-key",
      "x-egdata-session",
    ],
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    exposeHeaders: [
      "Cache-Control",
      "CDN-Cache-Control",
      "ETag",
      "X-Total-Count",
      "X-Cache",
      "X-Route-Template",
      "X-Egdata-Mitigation",
      "Retry-After",
      "Server-Timing",
      "RateLimit",
      "RateLimit-Policy",
    ],
    credentials: true,
  });
