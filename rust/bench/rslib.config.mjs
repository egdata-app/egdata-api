import { defineConfig } from "@rslib/core";

export default defineConfig({
  source: { entry: { origin: "./rust/bench/node-origin.ts" } },
  lib: [{ format: "esm", bundle: true }],
  output: {
    target: "node",
    distPath: { root: "./rust/target/resource-benchmark-node" },
  },
});
