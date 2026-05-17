import { defineConfig } from "@tanstack/react-start/config";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    preset: "cloudflare_module",
    compatibilityDate: "2026-05-17",
  },
  vite: {
    plugins: [tsConfigPaths(), tailwindcss()],
  },
});
