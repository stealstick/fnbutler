/**
 * 커버리지(애널리스트 분석보고서 보유) 전종목의 증권사별 목표주가를 채운다.
 *
 *   tsx scripts/ingest-covered.ts
 *   tsx scripts/ingest-covered.ts --all
 *   tsx scripts/ingest-covered.ts --batch 10 --batch-seconds 10
 */
import { all, closeDb, getDb, migrate, nowIso, query, tx } from "../src/lib/db";
import { sleep } from "../src/lib/butler";
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
    await sleep(400);
  }
  return out;
}

async function main() {
  const db = getDb();
  await migrate(db);
  const start = nowIso();

  process.stdout.write("커버리지(분석보고서>=1) 전종목 스크리닝...\n");
  const covered = await screenCovered();
  await tx(async (client) => {
    for (const code of covered) await query("UPDATE companies SET has_consensus = 1 WHERE corp_code = $1", [code], client);
  });
  process.stdout.write(`   커버리지 기업 ${covered.length}개 (has_consensus=1 마킹)\n`);

  const doneSet = new Set(
    (await all<{ corp_code: string }>("SELECT corp_code FROM companies WHERE detail_ingested_at IS NOT NULL", [], db)).map(
      (r) => r.corp_code,
    ),
  );
  const targets = has("all") ? covered : covered.filter((c) => !doneSet.has(c));
  process.stdout.write(
    `대상 ${targets.length}개 (이미 수집 ${covered.length - targets.length}개 스킵) · batch ${BATCH}/${BATCH_SECONDS}s\n`,
  );

  let ok = 0;
  let fail = 0;
  let withTargets = 0;
  let reports = 0;
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
        process.stdout.write(`   ${cc} ERROR ${(e as Error).message}\n`);
      }
    }
    const done = i + slice.length;
    process.stdout.write(
      `   [${done}/${targets.length}] 목표가보유 ${withTargets} · 리포트 ${reports} · 실패 ${fail}\n`,
    );
    const elapsed = (Date.now() - batchStart) / 1000;
    if (elapsed < BATCH_SECONDS && done < targets.length) await sleep((BATCH_SECONDS - elapsed) * 1000);
  }

  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('ingest-covered', $1, $2, 1, $3)",
    [start, nowIso(), `targets=${targets.length} ok=${ok} withTargets=${withTargets} fail=${fail}`],
    db,
  );
  process.stdout.write(
    `완료 — 처리 ${ok} · 목표가보유 ${withTargets} · 리포트 ${reports} · 실패 ${fail}\n`,
  );
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
