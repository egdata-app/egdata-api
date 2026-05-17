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
const ajv2020Compat = fileURLToPath(
  new URL("lib/ajv-2020.ts", import.meta.url),
);
const xmlJsJs2xmlCompat = fileURLToPath(
  new URL("lib/xml-js-js2xml.ts", import.meta.url),
);

export default defineConfig({
  server: {
    port: 4001,
  },
  resolve: {
    alias: {
      "@": appDirectory,
      "ajv/dist/2020.js": ajv2020Compat,
      collections: collectionsDirectory,
      "xml-js/lib/js2xml.js": xmlJsJs2xmlCompat,
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
