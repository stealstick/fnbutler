/**
 * HAR 임포트 CLI.
 *   tsx scripts/import-har.ts <path-to.har> [more.har ...]
 */
import { closeDb, getDb, migrate } from "../src/lib/db";
import { importHar } from "../src/lib/import-har";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("사용법: tsx scripts/import-har.ts <file.har> [...]");
  process.exit(1);
}

async function main() {
  const db = getDb();
  await migrate(db);
  for (const f of files) {
    process.stdout.write(`import ${f}\n`);
    const s = await importHar(db, f);
    process.stdout.write(
      `   기업목록 ${s.companies}  상세 ${s.detail}  재무 ${s.financials}  목표주가 ${s.targetPrice}  리포트 +${s.reports}  (skip ${s.skipped})\n`,
    );
  }
  process.stdout.write("HAR import 완료\n");
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
