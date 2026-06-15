/**
 * 커버리지(애널리스트 분석보고서 보유) 전종목의 증권사별 목표주가를 채운다.
 *
 *   tsx scripts/ingest-covered.ts                 # 미수집분만 (재개 가능)
 *   tsx scripts/ingest-covered.ts --all           # 전부 재수집
 *   tsx scripts/ingest-covered.ts --batch 10 --batch-seconds 10
 *   tsx scripts/ingest-covered.ts --push --redeploy   # 끝나고 GCS 업로드+재배포
 *
 * 점잖은 페이스: 기업 N개(batch)씩 처리하고, 한 배치가 batch-seconds 보다 빨리 끝나면
 * 남는 시간만큼 쉰다. 실제 호출은 레이트리미터(BUTLER_RATE_PER_MIN, 기본 80/분)가 상한.
 */
import { execSync } from "node:child_process";
import { getDb, migrate, nowIso } from "../src/lib/db";
import { butler, sleep } from "../src/lib/butler";
import { ingestTargetsOnly } from "../src/lib/ingest";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const BATCH = Number(argOf("batch") || 10);
const BATCH_SECONDS = Number(argOf("batch-seconds") || 10);
const FEED_PAGES = Number(argOf("feed-pages") || 2);

const COVERED_FILTER = {
  id: "CONSENSUS_REPORT_COUNT",
  conditions: [
    { category: "CRITERION_PERIOD", id: "STRING_DEFAULT", value: "최근 1년" },
    {
      category: "CRITERION_VALUES",
      id: "NUMBER_RANGE_COUNT",
      value: { from: 1, to: null, includeFrom: true, includeTo: null },
    },
  ],
};

async function screenCovered(): Promise<string[]> {
  // 스크리너로 커버리지 보유 전종목 corpCode 수집 (size 50 페이지네이션)
  const out: string[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch("https://api.butler.works/api/screener/screen", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://www.butler.works",
        "user-agent": "Mozilla/5.0",
      },
      body: JSON.stringify({
        filters: [COVERED_FILTER],
        orderBy: "DESC",
        orderColumn: "marketCap",
        page,
        size: 50,
      }),
    }).then((r) => r.json());
    const rows = (res.results ?? []) as Array<{ corpCode: string }>;
    if (rows.length === 0) break;
    out.push(...rows.map((r) => r.corpCode));
    await sleep(400); // 스크리너도 점잖게
  }
  return out;
}

async function main() {
  const db = getDb();
  migrate(db);
  const start = nowIso();

  process.stdout.write("📋 커버리지(분석보고서≥1) 전종목 스크리닝...\n");
  const covered = await screenCovered();
  // has_consensus 플래그 세팅 (UI 에서 '커버리지 없음' vs '미수집' 구분)
  const setFlag = db.prepare("UPDATE companies SET has_consensus = 1 WHERE corp_code = ?");
  const tx = db.transaction((codes: string[]) => codes.forEach((c) => setFlag.run(c)));
  tx(covered);
  process.stdout.write(`   커버리지 기업 ${covered.length}개 (has_consensus=1 마킹)\n`);

  // 처리 대상: --all 이면 전부, 아니면 아직 안 받은 것만 (재개 가능)
  const doneSet = new Set(
    (db
      .prepare("SELECT corp_code FROM companies WHERE detail_ingested_at IS NOT NULL")
      .all() as Array<{ corp_code: string }>).map((r) => r.corp_code),
  );
  const targets = has("all") ? covered : covered.filter((c) => !doneSet.has(c));
  process.stdout.write(
    `🎯 대상 ${targets.length}개 (이미 수집 ${covered.length - targets.length}개 스킵) · batch ${BATCH}/${BATCH_SECONDS}s\n`,
  );

  let ok = 0,
    fail = 0,
    withTargets = 0,
    reports = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batchStart = Date.now();
    const slice = targets.slice(i, i + BATCH);
    for (const cc of slice) {
      try {
        const r = await ingestTargetsOnly(db, cc, FEED_PAGES);
        ok++;
        reports += r.reports;
        if (r.reports > 0 || r.cover > 0) withTargets++;
      } catch (e) {
        fail++;
        process.stdout.write(`   ${cc} ❌ ${(e as Error).message}\n`);
      }
    }
    const done = i + slice.length;
    process.stdout.write(
      `   [${done}/${targets.length}] 목표가보유 ${withTargets} · 리포트 ${reports} · 실패 ${fail}\n`,
    );
    const elapsed = (Date.now() - batchStart) / 1000;
    if (elapsed < BATCH_SECONDS && done < targets.length) await sleep((BATCH_SECONDS - elapsed) * 1000);
  }

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.prepare(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('ingest-covered', ?, ?, 1, ?)",
  ).run(start, nowIso(), `targets=${targets.length} ok=${ok} withTargets=${withTargets} fail=${fail}`);
  process.stdout.write(
    `✅ 완료 — 처리 ${ok} · 목표가보유 ${withTargets} · 리포트 ${reports} · 실패 ${fail}\n`,
  );

  if (has("push")) {
    const bucket = process.env.BUTLER_DB_BUCKET || "protein-test-469413-fnbutler";
    process.stdout.write(`▶ GCS 업로드 gs://${bucket}/butler.db\n`);
    execSync(`gcloud storage cp "${process.env.BUTLER_DB_PATH || "db/butler.db"}" "gs://${bucket}/butler.db"`, { stdio: "inherit" });
  }
  if (has("redeploy")) {
    process.stdout.write("▶ Cloud Run 재배포 트리거\n");
    execSync("gh workflow run deploy.yml --repo stealstick/fnbutler", { stdio: "inherit" });
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
