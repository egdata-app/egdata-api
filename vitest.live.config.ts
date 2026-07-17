import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live-smoke.test.ts"],
    environment: "node",
    testTimeout: 45_000,
    hookTimeout: 45_000,
    pool: "forks",
  },
});
