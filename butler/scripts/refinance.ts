/**
 * 재무 전용 재수집 (일회성). 커버리지 전종목의 summary(quarter+accumulated)만 다시 받아
 * upsertFinancials/upsertValuations 로 갱신한다.
 */
import { all, closeDb, getDb, migrate } from "../src/lib/db";
import { butler } from "../src/lib/butler";
import { upsertFinancials, upsertValuations } from "../src/lib/ingest";

async function main() {
  const db = getDb();
  await migrate(db);
  const codes = (
    await all<{ corp_code: string }>(
      "SELECT corp_code FROM companies WHERE has_consensus = 1 ORDER BY market_cap DESC NULLS LAST",
      [],
      db,
    )
  ).map((r) => r.corp_code);
  process.stdout.write(`재무 전용 재수집 대상 ${codes.length}개\n`);

  let ok = 0;
  let fail = 0;
  let n = 0;
  for (const cc of codes) {
    n++;
    try {
      const [q, acc] = await Promise.all([
        butler.summary(cc, "quarter"),
        butler.summary(cc, "accumulated"),
      ]);
      await upsertFinancials(db, cc, q, acc);
      await upsertValuations(db, cc, acc);
      ok++;
    } catch {
      fail++;
    }
    if (n % 50 === 0) process.stdout.write(`   [${n}/${codes.length}] ok=${ok} fail=${fail}\n`);
  }
  process.stdout.write(`완료 — ok=${ok} fail=${fail}\n`);
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
