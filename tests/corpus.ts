export type CorpusEntry = {
  name: string;
  method: "GET" | "POST";
  path: string;
  /** JSON body for POST requests. Capture + replay both send it as application/json. */
  body?: unknown;
};

// Curated list of routes to snapshot from prod and replay locally.
// Replace placeholder IDs with real IDs from api.egdata.app, then run
// `pnpm test:capture` to (re)generate the golden snapshots.
export const corpus: CorpusEntry[] = [
  // --- smoke / lightweight ---
  { name: "health", method: "GET", path: "/health" },
  { name: "root", method: "GET", path: "/" },
  { name: "free-games", method: "GET", path: "/free-games" },

  // --- /search/v2/search — the OpenSearch-backed search ---
  // Focus on sort, filter, and region-resolution edge cases. Bodies follow
  // the SearchBody type in src/routes/search.ts.

  {
    name: "search-empty",
    method: "POST",
    path: "/search/v2/search",
    body: { limit: 10 },
  },
  {
    name: "search-title-fuzzy",
    method: "POST",
    path: "/search/v2/search",
    body: { title: "Civilization", limit: 5 },
  },
  {
    name: "search-by-offer-type",
    method: "POST",
    path: "/search/v2/search",
    body: { offerType: "BASE_GAME", limit: 10 },
  },
  {
    name: "search-sort-price-asc-us",
    method: "POST",
    path: "/search/v2/search?country=US",
    body: { sortBy: "price", sortDir: "asc", limit: 10 },
  },
  {
    name: "search-sort-price-desc-euro",
    method: "POST",
    path: "/search/v2/search?country=FR",
    body: { sortBy: "price", sortDir: "desc", limit: 10 },
  },
  {
    name: "search-sort-discount-on-sale-us",
    method: "POST",
    path: "/search/v2/search?country=US",
    body: { sortBy: "discount", sortDir: "desc", onSale: true, limit: 10 },
  },
  {
    name: "search-release-date-desc",
    method: "POST",
    path: "/search/v2/search",
    body: { sortBy: "releaseDate", sortDir: "desc", limit: 10 },
  },
  {
    name: "search-upcoming",
    method: "POST",
    path: "/search/v2/search",
    body: { sortBy: "upcoming", sortDir: "asc", limit: 10 },
  },
  {
    name: "search-price-range-euro",
    method: "POST",
    path: "/search/v2/search?country=FR",
    body: { price: { min: 0, max: 2000 }, limit: 10 },
  },
  {
    name: "search-region-fallback-zz",
    method: "POST",
    // Unknown country falls back to US region — verifies the region
    // resolution branch in the route handler.
    path: "/search/v2/search?country=ZZ",
    body: { limit: 5 },
  },
  {
    name: "search-pagination",
    method: "POST",
    path: "/search/v2/search",
    body: { limit: 10, page: 2 },
  },

  // --- ID-bound routes (uncomment once real IDs are pasted in) ---
  // { name: "offer-by-id",   method: "GET", path: "/offers/REPLACE_ME" },
  // { name: "item-by-id",    method: "GET", path: "/items/REPLACE_ME" },
  // { name: "sandbox-by-id", method: "GET", path: "/sandboxes/REPLACE_ME" },
  // { name: "price-by-id",   method: "GET", path: "/price/REPLACE_ME?country=US" },
];
