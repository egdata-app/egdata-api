import { defineConfig } from "@rslib/core";

export default defineConfig({
  source: {
    entry: {
      index: "./src/index.ts",
      "anti-abuse-ops": "./scripts/anti-abuse-ops.ts",
      "anti-abuse-production-check": "./scripts/anti-abuse-production-check.ts",
    },
  },
  lib: [
    {
      format: "esm",
      bundle: true,
    },
  ],
  output: {
    target: "node",
  },
});
