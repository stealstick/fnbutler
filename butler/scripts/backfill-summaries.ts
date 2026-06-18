/**
 * AI 요약 백필 — 기존 컨센서스 리포트의 ai_summary 를 리포트 상세 API의
 * "전체 요약"으로 교체한다. 피드(/api/feed)의 values.aiSummary 는 짧은 TL;DR 이라
 * 초기 적재분은 짧게 저장돼 있다. 상세 API(/api/consensus/reports/:id)의 aiSummary 는
 * 구조화된 전체 요약(투자포인트/리스크 등)이라 이걸로 덮어쓴다. 멱등(같으면 스킵).
 *
 *   tsx scripts/backfill-summaries.ts            # 화면 노출분(증권사별 최신 리포트)만
 *   tsx scripts/backfill-summaries.ts --all      # 전체 리포트
 *   tsx scripts/backfill-summaries.ts --limit 50 # 앞 N건만(테스트)
 *   tsx scripts/backfill-summaries.ts --force    # 이미 채운 것도 전부 재요청
 *
 * 멱등: ai_summary 가 이미 상세 요약(마크다운 볼드 `**` 포함)이면 상세 호출을 건너뛴다.
 * 업스트림 호출은 butler 클라이언트가 분당 BUTLER_RATE_PER_MIN(기본 80)으로 셀프 throttle.
 */
import { all as allRows, closeDb, getDb, migrate, nowIso, query } from "../src/lib/db";
import { butler } from "../src/lib/butler";

type Row = { report_id: string; ai_summary: string | null };

async function main() {
  const args = process.argv.slice(2);
  const includeAll = args.includes("--all");
  const force = args.includes("--force");
  const limIdx = args.indexOf("--limit");
  const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : 0;

  const db = getDb();
  await migrate(db);

  // 화면(증권사별 최신 리포트)에만 AI 요약이 노출되므로 기본은 그 집합만 백필.
  // --all 이면 전체 리포트(히스토리 포함).
  const source = includeAll
    ? "consensus_reports"
    : "v_latest_broker_target";
  const rows = await allRows<Row>(`SELECT report_id, ai_summary FROM ${source} ORDER BY report_date DESC`, [], db);
  const targets = limit > 0 ? rows.slice(0, limit) : rows;

  process.stdout.write(
    `대상 ${targets.length}건 (${includeAll ? "전체" : "노출=증권사별 최신"})${force ? " · force" : ""} 백필 시작\n`,
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    // 이미 상세 API 의 전체 요약(라이트 마크다운: `- **헤더**`)이면 상세 호출 생략 — 멱등.
    // 피드의 짧은 요약은 평문(볼드 `**` 없음)이라 항상 백필 대상. --force 면 무시.
    if (!force && r.ai_summary && r.ai_summary.includes("**")) {
      skipped++;
      continue;
    }
    try {
      const detail = await butler.reportDetail(r.report_id);
      const full = detail?.aiSummary?.trim();
      if (full && full !== r.ai_summary) {
        await query("UPDATE consensus_reports SET ai_summary = $1, ingested_at = $2 WHERE report_id = $3", [
          full,
          nowIso(),
          r.report_id,
        ], db);
        updated++;
      } else {
        skipped++;
      }
    } catch {
      failed++;
    }
    if ((i + 1) % 100 === 0 || i + 1 === targets.length) {
      process.stdout.write(
        `  ${i + 1}/${targets.length} — 갱신 ${updated} · 스킵 ${skipped} · 실패 ${failed}\n`,
      );
    }
  }

  process.stdout.write(`✅ 완료: 갱신 ${updated} · 스킵 ${skipped} · 실패 ${failed}\n`);
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
