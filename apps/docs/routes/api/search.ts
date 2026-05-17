import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";
import { getSource } from "@/lib/source";

const search = createFromSource(getSource);

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: search.staticGET,
    },
  },
});
