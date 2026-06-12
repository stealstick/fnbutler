/**
 * 일일 폴링 크론 엔트리포인트.
 *  1) 대상 기업(관심목록 ∪ 컨센서스 보유) 상세 재수집 → 변경 자동 감지/로깅(날짜 포함)
 *  2) 일별 스냅샷 기록
 *  3) 관심목록 보유 유저에게 목표주가 변경 텔레그램 알림 (이번 실행에서 새로 생긴 변경만)
 *
 *   tsx scripts/poll-daily.ts
 *   tsx scripts/poll-daily.ts --scope watchlist   # 관심목록만 (빠름)
 *
 * crontab 예: 매 영업일 18:30
 *   30 18 * * 1-5  cd /…/butler && /usr/bin/env -S npx tsx scripts/poll-daily.ts >> /tmp/butler-poll.log 2>&1
 */
import { getDb, migrate, nowIso } from "../src/lib/db";
import { ingestDetail } from "../src/lib/ingest";
import { recordDailySnapshot, dispatchAlerts } from "../src/lib/poll";

const scopeIdx = process.argv.indexOf("--scope");
const scope = scopeIdx !== -1 ? process.argv[scopeIdx + 1] : "all";
const BASE_URL = process.env.BUTLER_BASE_URL || "http://localhost:3939";

async function main() {
  const db = getDb();
  migrate(db);
  const runStart = nowIso();
  const today = runStart.slice(0, 10);

  // 1) 대상 기업
  let targets: string[];
  if (scope === "watchlist") {
    targets = (
      db.prepare("SELECT DISTINCT corp_code FROM watchlist").all() as Array<{ corp_code: string }>
    ).map((r) => r.corp_code);
  } else {
    targets = (
      db
        .prepare(
          `SELECT corp_code FROM companies
           WHERE corp_code IN (SELECT corp_code FROM watchlist)
              OR has_consensus = 1
           ORDER BY market_cap DESC NULLS LAST`,
        )
        .all() as Array<{ corp_code: string }>
    ).map((r) => r.corp_code);
  }

  process.stdout.write(`[${runStart}] poll 시작 — 대상 ${targets.length}개 (scope=${scope})\n`);

  let changed = 0;
  for (let i = 0; i < targets.length; i++) {
    const cc = targets[i];
    try {
      const r = await ingestDetail(db, cc, { feedPages: 4 });
      recordDailySnapshot(db, cc, today);
      changed += r.changes;
      if (r.changes > 0) process.stdout.write(`  ${cc} 변경 +${r.changes}\n`);
    } catch (e) {
      process.stdout.write(`  ${cc} ❌ ${(e as Error).message}\n`);
    }
  }
  process.stdout.write(`변경 총 +${changed}. 알림 발송 중…\n`);

  // 3) 알림 — 이번 실행에서 새로 생긴 변경만
  const { sent, failed } = await dispatchAlerts(db, { sinceIso: runStart, baseUrl: BASE_URL });
  process.stdout.write(`✅ poll 완료. 텔레그램 발송 ${sent}건 (실패 ${failed})\n`);

  db.prepare(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('poll-daily', ?, ?, 1, ?)",
  ).run(runStart, nowIso(), `targets=${targets.length} changes=${changed} alerts=${sent}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
