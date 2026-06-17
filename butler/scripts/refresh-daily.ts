/**
 * 일일 데이터 갱신 (증분 + 멱등). 자체 DB(db/butler.db)를 최신화한다.
 *
 *   tsx scripts/refresh-daily.ts                 # 자체 DB 만 갱신
 *   tsx scripts/refresh-daily.ts --scope watchlist
 *   tsx scripts/refresh-daily.ts --push          # 변경 있으면 GCS 에 DB 업로드
 *   tsx scripts/refresh-daily.ts --push --redeploy  # + 변경 있으면 Cloud Run 재배포 트리거
 *
 * 특징
 *  - 증분: 피드는 최신순이라 이미 가진 리포트를 만나면 중단 → "최근 신규분만" 받음.
 *  - 멱등: 시세/목표가는 값이 바뀐 경우에만 UPDATE. 같은 데이터면 DB 무변경(updated_at 도 그대로).
 *  - 변경 없으면 GCS 업로드/재배포도 건너뜀(불필요한 배포 방지).
 *
 * crontab 예 (영업일 18:30):
 *   30 18 * * 1-5 cd /…/butler && npx tsx scripts/refresh-daily.ts --push --redeploy >> /tmp/butler-refresh.log 2>&1
 */
import { execSync } from "node:child_process";
import { getDb, migrate, nowIso } from "../src/lib/db";
import { ingestNewReports, refreshCompanyQuote } from "../src/lib/ingest";
import { recordDailySnapshot, dispatchAlerts } from "../src/lib/poll";
import { ingestCalendar } from "../src/lib/calendar";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const DB_BUCKET = process.env.BUTLER_DB_BUCKET || "protein-test-469413-fnbutler";
const DB_PATH = process.env.BUTLER_DB_PATH || "db/butler.db";
const BASE_URL = process.env.BUTLER_BASE_URL || "https://fnbutler-l3why3suea-du.a.run.app";

async function main() {
  const db = getDb();
  migrate(db);
  const runStart = nowIso();
  const today = runStart.slice(0, 10);
  const scope = argOf("scope") ?? "all";
  // 캘린더만 빠르게 갱신(회사 시세/리포트 루프 생략) — prod 캘린더 즉시 채우기/경량 크론용.
  const calendarOnly = has("calendar-only");

  const targets = (
    calendarOnly
      ? ([] as { corp_code: string }[])
      : scope === "watchlist"
        ? (db.prepare("SELECT DISTINCT corp_code FROM watchlist").all() as { corp_code: string }[])
        : (db
            .prepare(
              `SELECT corp_code FROM companies
               WHERE has_consensus = 1 OR corp_code IN (SELECT corp_code FROM watchlist)
               ORDER BY market_cap DESC NULLS LAST`,
            )
            .all() as { corp_code: string }[])
  ).map((r) => r.corp_code);

  process.stdout.write(
    `[${runStart}] ${calendarOnly ? "캘린더 전용" : "일일"} 갱신 시작 — 대상 ${targets.length}개 (scope=${scope})\n`,
  );

  let newReports = 0,
    quoteUpdated = 0,
    unchanged = 0,
    errors = 0;
  for (let i = 0; i < targets.length; i++) {
    const cc = targets[i];
    try {
      const nr = await ingestNewReports(db, cc);
      const q = await refreshCompanyQuote(db, cc);
      recordDailySnapshot(db, cc, today);
      newReports += nr;
      if (q === "updated") quoteUpdated++;
      else unchanged++;
      if (nr > 0 || q === "updated")
        process.stdout.write(`   ${cc}  신규리포트 +${nr}  시세 ${q}\n`);
    } catch (e) {
      errors++;
      process.stdout.write(`   ${cc}  ❌ ${(e as Error).message}\n`);
    }
  }

  // 경제·실적 캘린더 갱신 (비치명적). DART_API_KEY 있으면 국내실적 포함.
  let calendarOk = false;
  let calendarMsg = "skip";
  if (!has("no-calendar")) {
    try {
      const cr = await ingestCalendar(db, { dartKey: process.env.DART_API_KEY || undefined });
      calendarMsg = `거시 ${cr.macro}·해외 ${cr.earningsIntl}·국내 ${cr.earningsKr}`;
      calendarOk = true;
      process.stdout.write(`   📅 캘린더 갱신 — ${calendarMsg}\n`);
    } catch (e) {
      calendarMsg = `error: ${(e as Error).message}`;
      process.stdout.write(`   📅 캘린더 갱신 실패 — ${(e as Error).message}\n`);
    }
  }

  // 캘린더는 Firestore(라이브)에 적재되므로 재배포가 불필요 → changed 판정에서 제외.
  // (SQLite 시세/리포트가 바뀐 경우에만 GCS 업로드/재배포한다)
  const changed = newReports > 0 || quoteUpdated > 0;
  // 캘린더 전용 모드는 신규 리포트가 없으므로 알림 발송 생략.
  const { sent } = calendarOnly
    ? { sent: 0 }
    : await dispatchAlerts(db, { sinceIso: runStart, baseUrl: BASE_URL });

  db.prepare(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('refresh-daily', ?, ?, 1, ?)",
  ).run(
    runStart,
    nowIso(),
    `targets=${targets.length} newReports=${newReports} quoteUpdated=${quoteUpdated} unchanged=${unchanged} alerts=${sent} errors=${errors} calendar=${calendarMsg}`,
  );

  process.stdout.write(
    `✅ 갱신 완료 — 신규리포트 ${newReports} · 시세변경 ${quoteUpdated} · 무변경 ${unchanged} · 알림 ${sent} · 오류 ${errors}\n`,
  );

  // WAL 체크포인트(파일 완전화)
  db.pragma("wal_checkpoint(TRUNCATE)");

  if (!changed) {
    process.stdout.write("변경 없음 — GCS 업로드/재배포 건너뜀.\n");
    return;
  }

  if (has("push")) {
    process.stdout.write(`▶ GCS 업로드 gs://${DB_BUCKET}/butler.db\n`);
    execSync(`gcloud storage cp "${DB_PATH}" "gs://${DB_BUCKET}/butler.db"`, { stdio: "inherit" });
  }
  if (has("redeploy")) {
    process.stdout.write("▶ Cloud Run 재배포 트리거 (GitHub Actions)\n");
    execSync(`gh workflow run deploy.yml --repo stealstick/fnbutler`, { stdio: "inherit" });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
