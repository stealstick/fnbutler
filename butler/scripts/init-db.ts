import { getDb, migrate } from "../src/lib/db";

const db = getDb();
migrate(db);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name")
  .all() as Array<{ name: string }>;
console.log("✅ schema applied. tables/views:");
for (const t of tables) console.log("   -", t.name);
