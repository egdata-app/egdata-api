import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "vite";

const appDirectory = fileURLToPath(new URL(".", import.meta.url));
const collectionsDirectory = fileURLToPath(new URL(".source", import.meta.url));

export default defineConfig({
  server: {
    port: 4001,
  },
  resolve: {
    alias: {
      "@": appDirectory,
      collections: collectionsDirectory,
    },
  },
  plugins: [
    mdx(),
    cloudflare({
      viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] },
    }),
    tailwindcss(),
    tanstackStart({
      rsc: {
        enabled: true,
      },
      srcDirectory: ".",
    }),
    rsc(),
    viteReact(),
  ],
});
