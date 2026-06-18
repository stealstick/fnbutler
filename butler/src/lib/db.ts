import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, types as pgTypes, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

const SCHEMA_PATH = join(process.cwd(), "db", "postgres", "schema.sql");

pgTypes.setTypeParser(20, (v) => Number(v)); // int8 / BIGSERIAL

export type Queryable = Pick<Pool | PoolClient, "query">;

type G = typeof globalThis & { __butlerPgPool?: Pool; __butlerPgMigrated?: boolean };
const g = globalThis as G;

function poolConfig(): PoolConfig {
  const connectionString = process.env.BUTLER_DATABASE_URL || process.env.DATABASE_URL;
  if (connectionString) {
    return {
      connectionString,
      max: Number(process.env.BUTLER_DB_POOL_SIZE || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };
  }

  return {
    host: process.env.PGHOST || "localhost",
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    database: process.env.PGDATABASE || "butler",
    user: process.env.PGUSER || "butler",
    password: process.env.PGPASSWORD || "butler",
    max: Number(process.env.BUTLER_DB_POOL_SIZE || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

export function getDb(): Pool {
  if (!g.__butlerPgPool) g.__butlerPgPool = new Pool(poolConfig());
  return g.__butlerPgPool;
}

export async function closeDb(): Promise<void> {
  if (!g.__butlerPgPool) return;
  await g.__butlerPgPool.end();
  g.__butlerPgPool = undefined;
  g.__butlerPgMigrated = false;
}

export async function migrate(db: Queryable = getDb()): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  await db.query(sql);
  g.__butlerPgMigrated = true;
}

export async function ensureMigrated(): Promise<void> {
  if (g.__butlerPgMigrated) return;
  await migrate(getDb());
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  db: Queryable = getDb(),
): Promise<QueryResult<T>> {
  return db.query<T>(sql, [...params]);
}

export async function all<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  db: Queryable = getDb(),
): Promise<T[]> {
  return (await query<T>(sql, params, db)).rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  db: Queryable = getDb(),
): Promise<T | undefined> {
  return (await query<T>(sql, params, db)).rows[0];
}

export async function value<T>(
  sql: string,
  params: readonly unknown[] = [],
  db: Queryable = getDb(),
): Promise<T | undefined> {
  const row = await one<Record<string, T>>(sql, params, db);
  return row ? Object.values(row)[0] : undefined;
}

export const nowIso = () => new Date().toISOString();
