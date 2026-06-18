import { all, closeDb, getDb, migrate } from "../src/lib/db";

async function main() {
  const db = getDb();
  await migrate(db);
  const rows = await all<{ name: string; kind: string }>(
    `SELECT tablename AS name, 'table' AS kind
     FROM pg_tables
     WHERE schemaname = 'public'
     UNION ALL
     SELECT viewname AS name, 'view' AS kind
     FROM pg_views
     WHERE schemaname = 'public'
     ORDER BY kind, name`,
    [],
    db,
  );
  process.stdout.write(`Postgres schema ready: ${rows.map((r) => r.name).join(", ")}\n`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
