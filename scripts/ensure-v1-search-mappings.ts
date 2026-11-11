import { Client } from "@opensearch-project/opensearch";
import { ensureV1SearchMappings } from "../src/v1/search-mappings.js";

const apply = process.argv.includes("--apply");
const node = process.env.OPENSEARCH_URL?.trim();
if (!node) {
  console.error("OPENSEARCH_URL is required.");
  process.exit(1);
}
const username = process.env.OPENSEARCH_USERNAME?.trim();
const password = process.env.OPENSEARCH_PASSWORD?.trim();

const client = new Client({
  node,
  ...(username && password ? { auth: { username, password } } : {}),
});

const reports = await ensureV1SearchMappings(client, { apply });
console.log(JSON.stringify(reports, null, 2));

const failed = reports.some(
  (report) =>
    report.incompatible.length > 0 || (!apply && report.missing.length > 0),
);
if (failed) {
  console.error(
    apply
      ? "Some required search mappings are incompatible and need a manual mapping update."
      : "Required search mappings are missing. Re-run with --apply where possible.",
  );
  process.exit(1);
}
