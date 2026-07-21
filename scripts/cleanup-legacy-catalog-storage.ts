import { config } from "dotenv";
import { db } from "../src/db/index.js";

config();

const confirmation = "--confirm-delete-legacy-catalog-storage";
const collections = [
  "catalog_snapshots",
  "catalog_snapshot_pages",
  "catalog_snapshot_records",
  "catalog_snapshot_hydration_roots",
] as const;

if (!process.argv.includes(confirmation)) {
  console.error(
    `Refusing to delete legacy catalog data without ${confirmation}.`,
  );
  process.exitCode = 2;
} else {
  try {
    await db.connect();
    for (const name of collections) {
      const result = await db.db.collection(name).deleteMany({});
      console.log(`${name}: deleted ${result.deletedCount} documents`);
    }
  } finally {
    await db.disconnect();
  }
}
