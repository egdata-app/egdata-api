import { betterAuth } from "better-auth";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";

it("uses Better Auth's configured signing key for session cookies", async () => {
  const primary = "fixture-synthetic-primary-key-for-session-tests";
  const fallback = "fixture-synthetic-fallback-key-for-session-tests";
  const inputs = [
    { BETTER_AUTH_SECRET: ` ${primary} `, AUTH_SECRET: fallback },
    { BETTER_AUTH_SECRET: "", AUTH_SECRET: ` ${fallback} ` },
    { BETTER_AUTH_SECRETS: "", BETTER_AUTH_SECRET: primary },
    ...[
      `7:${primary},1:${fallback}`,
      ` 1: ${primary}:with-colon , 9:${fallback}`,
      `+12suffix:${primary},3:${fallback}`,
      `-0:${primary}`,
      `02:${primary},2:${fallback}`,
      `-1:${primary}`,
      `x:${primary}`,
      `1000000000000000000000:${primary}`,
      `1:${primary},2: `,
      `1:${primary},broken`,
    ].map((list) => ({
      BETTER_AUTH_SECRETS: list,
      BETTER_AUTH_SECRET: fallback,
    })),
  ];
  const pool = new pg.Pool({
    connectionString: "postgresql://fixture@127.0.0.1:1/test",
  });
  const cases = [];
  try {
    for (const input of inputs) {
      for (const key of [
        "BETTER_AUTH_SECRETS",
        "BETTER_AUTH_SECRET",
        "AUTH_SECRET",
      ] as const) {
        vi.stubEnv(key, input[key]);
      }
      try {
        const auth = betterAuth({
          database: pool,
          baseURL: "http://localhost",
          logger: { disabled: true },
        });
        const context = await auth.$context;
        cases.push({ input, secret: context.secret });
      } catch {
        cases.push({ input, secret: null });
      }
    }
    expect(cases[0].secret).toBe(` ${primary} `);
    expect(cases.some((c) => c.secret === null)).toBe(true);
    assertOracle("session-config-node", cases);
  } finally {
    vi.unstubAllEnvs();
    await pool.end();
  }
});
