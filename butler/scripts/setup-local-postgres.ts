import { execFileSync } from "node:child_process";

const db = process.env.PGDATABASE || "butler";
const user = process.env.PGUSER || "butler";
const password = process.env.PGPASSWORD || "butler";
const host = process.env.PGHOST || "localhost";
const port = process.env.PGPORT || "5432";

function psql(sql: string) {
  execFileSync("psql", ["-h", host, "-p", port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    stdio: "inherit",
  });
}

function psqlOut(sql: string) {
  return execFileSync("psql", ["-h", host, "-p", port, "-U", "postgres", "-d", "postgres", "-tAc", sql], {
    encoding: "utf8",
  }).trim();
}

psql(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user.replace(/'/g, "''")}') THEN
    CREATE ROLE "${user.replace(/"/g, '""')}" LOGIN PASSWORD '${password.replace(/'/g, "''")}';
  ELSE
    ALTER ROLE "${user.replace(/"/g, '""')}" LOGIN PASSWORD '${password.replace(/'/g, "''")}';
  END IF;
END
$$;
`);

const exists = psqlOut(`SELECT 1 FROM pg_database WHERE datname = '${db.replace(/'/g, "''")}'`);
if (!exists) psql(`CREATE DATABASE "${db.replace(/"/g, '""')}" OWNER "${user.replace(/"/g, '""')}"`);

process.stdout.write(`Local Postgres ready: postgres://${user}:***@${host}:${port}/${db}\n`);
