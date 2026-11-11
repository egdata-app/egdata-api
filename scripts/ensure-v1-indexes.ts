import { config } from "dotenv";
import { db } from "../src/db/index.js";
import { ensureV1Indexes, v1IndexPlan } from "../src/v1/indexes.js";

config();

await db.connect();
const result = await ensureV1Indexes(db.db, { force: true });
console.log(
  `v1 index plan checked: ${v1IndexPlan.length} indexes, ${result.created} ensured, ${result.failed} failed.`,
);
await db.disconnect();
process.exit(result.failed > 0 ? 1 : 0);
