import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import optimizeLocales from "@react-aria/optimize-locales-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appDirectory = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  server: {
    port: 4002,
  },
  resolve: {
    alias: {
      "@": appDirectory,
    },
  },
  plugins: [
    {
      ...optimizeLocales.vite({ locales: ["en-US"] }),
      enforce: "pre",
    },
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    cloudflare({
      configPath: "./wrangler.jsonc",
      persistState: true,
    }),
  ],
});
