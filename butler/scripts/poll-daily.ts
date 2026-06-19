/**
 * 상세 재수집형 일일 폴링. 일반 운영 크론은 refresh-daily.ts 를 쓰고,
 * 이 스크립트는 재무/상세까지 다시 확인해야 할 때 수동으로 돌린다.
 */
import { all, closeDb, getDb, migrate, nowIso, query } from "../src/lib/db";
import { ingestDetail } from "../src/lib/ingest";
import { recordDailySnapshot, dispatchAlerts } from "../src/lib/poll";

const scopeIdx = process.argv.indexOf("--scope");
const scope = scopeIdx !== -1 ? process.argv[scopeIdx + 1] : "all";
const BASE_URL = process.env.BUTLER_BASE_URL || "http://localhost:3939";

async function main() {
  const db = getDb();
  await migrate(db);
  const runStart = nowIso();
  const today = runStart.slice(0, 10);

  const targets = (
    scope === "watchlist"
      ? await all<{ corp_code: string }>(
          `SELECT DISTINCT w.corp_code
           FROM watchlist w
           JOIN companies c ON c.corp_code = w.corp_code
           WHERE c.active = 1 AND c.source <> 'nasdaq'`,
          [],
          db,
        )
      : await all<{ corp_code: string }>(
          `SELECT corp_code FROM companies
           WHERE active = 1
             AND source <> 'nasdaq'
             AND (corp_code IN (SELECT corp_code FROM watchlist)
              OR has_consensus = 1)
           ORDER BY market_cap DESC NULLS LAST`,
          [],
          db,
        )
  ).map((r) => r.corp_code);

  process.stdout.write(`[${runStart}] poll 시작 — 대상 ${targets.length}개 (scope=${scope})\n`);

  let changed = 0;
  for (let i = 0; i < targets.length; i++) {
    const cc = targets[i];
    try {
      const r = await ingestDetail(db, cc, { feedPages: 4 });
      await recordDailySnapshot(db, cc, today);
      changed += r.changes;
      if (r.changes > 0) process.stdout.write(`  ${cc} 변경 +${r.changes}\n`);
    } catch (e) {
      process.stdout.write(`  ${cc} ERROR ${(e as Error).message}\n`);
    }
  }
  process.stdout.write(`변경 총 +${changed}. 알림 발송 중...\n`);

  const { sent, failed } = await dispatchAlerts(db, { sinceIso: runStart, baseUrl: BASE_URL });
  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('poll-daily', $1, $2, 1, $3)",
    [runStart, nowIso(), `targets=${targets.length} changes=${changed} alerts=${sent}`],
    db,
  );
  process.stdout.write(`poll 완료. 텔레그램 발송 ${sent}건 (실패 ${failed})\n`);
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
