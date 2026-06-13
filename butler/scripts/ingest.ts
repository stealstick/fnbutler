/**
 * butler 데이터 수집 CLI.
 *
 *   tsx scripts/ingest.ts --companies                 # 전종목 목록만 (~52 calls)
 *   tsx scripts/ingest.ts --detail --limit 40         # 시총 상위 40개 상세
 *   tsx scripts/ingest.ts --detail --corp 00937324    # 특정 기업만
 *   tsx scripts/ingest.ts --companies --detail --all  # 전종목 상세 (느림)
 *   tsx scripts/ingest.ts --detail --only-consensus   # 컨센서스 보유 기업만
 */
import { getDb, migrate } from "../src/lib/db";
import { ingestCompanies, ingestDetail } from "../src/lib/ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const db = getDb();
  migrate(db);

  if (has("companies")) {
    process.stdout.write("📋 기업 목록 수집 중...\n");
    const { total, upserted } = await ingestCompanies(db, {
      onProgress: (d, t) => process.stdout.write(`\r   ${d}/${t}`),
    });
    process.stdout.write(`\n✅ 기업 ${upserted}/${total}개 upsert 완료\n`);
  }

  if (has("detail")) {
    const corp = arg("corp");
    const limit = Number(arg("limit") || (has("all") ? "0" : "40"));
    const feedPages = Number(arg("feed-pages") || "6"); // 과거 리포트 깊이 (페이지×15건)
    const onlyConsensus = has("only-consensus");

    let targets: string[];
    if (corp) {
      targets = corp.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      const where = onlyConsensus ? "WHERE has_consensus = 1" : "";
      const lim = limit > 0 ? `LIMIT ${limit}` : "";
      targets = (
        db
          .prepare(
            `SELECT corp_code FROM companies ${where} ORDER BY market_cap DESC NULLS LAST ${lim}`,
          )
          .all() as Array<{ corp_code: string }>
      ).map((r) => r.corp_code);
    }

    process.stdout.write(`🔎 상세 수집 대상 ${targets.length}개\n`);
    let i = 0;
    let totalChanges = 0;
    for (const cc of targets) {
      i++;
      try {
        const r = await ingestDetail(db, cc, { feedPages });
        totalChanges += r.changes;
        process.stdout.write(
          `   [${i}/${targets.length}] ${cc}  리포트 +${r.reports}  분기 ${r.quarters}  변경 +${r.changes}\n`,
        );
      } catch (e) {
        process.stdout.write(`   [${i}/${targets.length}] ${cc}  ❌ ${(e as Error).message}\n`);
      }
    }
    process.stdout.write(`✅ 상세 수집 완료 (변경 로그 +${totalChanges})\n`);
  }

  if (!has("companies") && !has("detail")) {
    console.log("아무 작업도 지정 안 됨. --companies / --detail 사용");
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
