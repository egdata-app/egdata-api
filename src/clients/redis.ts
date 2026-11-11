import { Redis as IORedis } from "ioredis";

const REDISHOST = process.env.REDISHOST || '127.0.0.1';
const REDISPORT = process.env.REDISPORT || '6379';
const tls = process.env.REDISTLS === 'true';

const client = new IORedis({
  host: REDISHOST,
  port: parseInt(REDISPORT),
  tls: tls ? {} : undefined,
  username: process.env.REDISUSER || undefined,
  password: process.env.REDISPASSWORD || undefined,
  maxRetriesPerRequest: null,
});

// ioredis emits `error` events for connection failures. Without a listener,
// Node prints an unhandled-error line for every retry (including read-only
// tooling such as the OpenAPI coverage check).
client.on("error", () => {});

export default client;
