/**
 * HAR 임포트 CLI.
 *   tsx scripts/import-har.ts <path-to.har> [more.har ...]
 *
 * 로그인 세션으로 캡처한 butler HAR 이면 최신 재무 시계열까지 백필된다.
 */
import { getDb, migrate } from "../src/lib/db";
import { importHar } from "../src/lib/import-har";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("사용법: tsx scripts/import-har.ts <file.har> [...]");
  process.exit(1);
}

const db = getDb();
migrate(db);

for (const f of files) {
  process.stdout.write(`📥 import ${f}\n`);
  const s = importHar(db, f);
  process.stdout.write(
    `   기업목록 ${s.companies}  상세 ${s.detail}  재무 ${s.financials}  목표주가 ${s.targetPrice}  리포트 +${s.reports}  (skip ${s.skipped})\n`,
  );
}
process.stdout.write("✅ HAR import 완료\n");
process.exit(0);
