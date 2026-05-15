export type CorpusEntry = {
  name: string;
  method: "GET";
  path: string;
};

// Curated list of routes to snapshot from prod and replay locally.
// Replace the placeholder IDs with real IDs from api.egdata.app, then
// run `pnpm test:capture` to generate the golden snapshots.
export const corpus: CorpusEntry[] = [
  { name: "health", method: "GET", path: "/health" },
  { name: "root", method: "GET", path: "/" },
  { name: "free-games", method: "GET", path: "/free-games" },
  // Seed with real IDs:
  // { name: "offer-by-id",   method: "GET", path: "/offers/REPLACE_ME" },
  // { name: "item-by-id",    method: "GET", path: "/items/REPLACE_ME" },
  // { name: "sandbox-by-id", method: "GET", path: "/sandboxes/REPLACE_ME" },
  // { name: "price-by-id",   method: "GET", path: "/price/REPLACE_ME?country=US" },
];
