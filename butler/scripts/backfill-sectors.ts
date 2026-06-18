/**
 * 섹터(업종) 백필 — sector 가 비어있는 기업만 /api/companies/{corpCode} 호출.
 * 레이트리밋(80/min) 준수, 중단해도 재실행하면 이어서 진행(멱등).
 *
 *   tsx scripts/backfill-sectors.ts            # 전체
 *   tsx scripts/backfill-sectors.ts --limit 500
 */
import { all, closeDb, getDb, migrate } from "../src/lib/db";
import { butler } from "../src/lib/butler";
import { upsertCompanyDetail } from "../src/lib/ingest";
import { nowIso } from "../src/lib/db";

const limIdx = process.argv.indexOf("--limit");
const limit = limIdx !== -1 ? Number(process.argv[limIdx + 1]) : 0;

async function main() {
  const db = getDb();
  await migrate(db);
  const rows = await all<{ corp_code: string }>(
    `SELECT corp_code FROM companies
     WHERE sector IS NULL OR sector = ''
     ORDER BY market_cap DESC NULLS LAST ${limit > 0 ? `LIMIT ${limit}` : ""}`,
    [],
    db,
  );
  process.stdout.write(`섹터 백필 대상: ${rows.length}개\n`);
  let ok = 0,
    fail = 0;
  for (const r of rows) {
    try {
      const d = await butler.company(r.corp_code);
      await upsertCompanyDetail(db, d, nowIso());
      ok++;
    } catch {
      fail++;
    }
    if ((ok + fail) % 100 === 0)
      process.stdout.write(`  ${ok + fail}/${rows.length} (실패 ${fail})\n`);
  }
  process.stdout.write(`✅ 섹터 백필 완료: 성공 ${ok}, 실패 ${fail}\n`);
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
