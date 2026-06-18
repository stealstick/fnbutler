import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeDb, getDb, migrate, query, tx, value, type Queryable } from "../src/lib/db";

const TABLES = [
  "companies",
  "brokers",
  "consensus_reports",
  "target_price_monthly",
  "financials",
  "valuations",
  "change_logs",
  "ingest_runs",
  "daily_snapshots",
  "users",
  "sessions",
  "watchlist",
  "notifications",
  "telegram_link_tokens",
  "calendar_prefs",
  "calendar_events",
] as const;

const SEQUENCE_TABLES = ["brokers", "change_logs", "ingest_runs", "users", "notifications"] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

const has = (name: string) => process.argv.includes(`--${name}`);

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8", maxBuffer: 1024 * 1024 * 128 });
  const trimmed = out.trim();
  return trimmed ? (JSON.parse(trimmed) as T[]) : [];
}

function quoteIdent(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function countDestinationRows(): Promise<number> {
  let total = 0;
  for (const t of TABLES) total += Number((await value<number>(`SELECT COUNT(*)::int FROM ${quoteIdent(t)}`)) ?? 0);
  return total;
}

async function resetDestination() {
  await query(`TRUNCATE ${TABLES.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`);
}

async function insertRows(db: Queryable, table: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const params: unknown[] = [];
  const valuesSql = rows
    .map((row) => {
      const oneRow = cols.map((c) => {
        params.push(row[c] ?? null);
        return `$${params.length}`;
      });
      return `(${oneRow.join(", ")})`;
    })
    .join(", ");
  await query(
    `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")})
     VALUES ${valuesSql}
     ON CONFLICT DO NOTHING`,
    params,
    db,
  );
}

async function syncSequences() {
  for (const table of SEQUENCE_TABLES) {
    await query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1),
         (SELECT COUNT(*) > 0 FROM ${quoteIdent(table)})
       )`,
      [table],
    );
  }
}

async function main() {
  const source = resolve(arg("source") || "db/butler.db");
  const chunkSize = Number(arg("chunk") || "500");
  if (!existsSync(source)) throw new Error(`SQLite source not found: ${source}`);

  execFileSync("sqlite3", ["-version"], { stdio: "ignore" });

  await migrate(getDb());
  if (has("reset")) {
    process.stdout.write("Resetting destination Postgres tables...\n");
    await resetDestination();
  } else {
    const existing = await countDestinationRows();
    if (existing > 0) {
      throw new Error(
        `Destination Postgres already has ${existing} rows. Re-run with --reset after you have a backup.`,
      );
    }
  }

  for (const table of TABLES) {
    const total = Number(sqliteJson<{ c: number }>(source, `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`)[0]?.c ?? 0);
    process.stdout.write(`Migrating ${table}: ${total} rows\n`);
    for (let offset = 0; offset < total; offset += chunkSize) {
      const rows = sqliteJson<Record<string, unknown>>(
        source,
        `SELECT * FROM ${quoteIdent(table)} LIMIT ${chunkSize} OFFSET ${offset}`,
      );
      await tx(async (client) => {
        await insertRows(client, table, rows);
      });
      if (total > chunkSize) {
        const done = Math.min(offset + rows.length, total);
        process.stdout.write(`  ${done}/${total}\r`);
      }
    }
    if (total > chunkSize) process.stdout.write("\n");
  }

  await syncSequences();

  const stats = await Promise.all(
    TABLES.map(async (table) => ({
      table,
      count: Number((await value<number>(`SELECT COUNT(*)::int FROM ${quoteIdent(table)}`)) ?? 0),
    })),
  );
  process.stdout.write("Migration complete:\n");
  for (const s of stats) process.stdout.write(`  ${s.table}: ${s.count}\n`);
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
