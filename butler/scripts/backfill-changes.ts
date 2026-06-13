/**
 * 변경이력 재생성 — 원본(consensus_reports / financials)에서 실제 발생일(occurred_at)
 * 기준으로 과거 변경 타임라인을 통째로 다시 만든다. 멱등(삭제 후 재생성).
 *
 *   tsx scripts/backfill-changes.ts
 *
 * 다루는 변경:
 *   target_price  — 증권사별 목표주가 수정(상향/하향) + 신규 커버리지. occurred_at = 리포트 발행일.
 *   financial     — 분기 실적의 QoQ/YoY. occurred_at = 분기말.
 *   (consensus_avg 는 스냅샷 비교라 재생성 대상 아님 — 유지)
 */
import { getDb, migrate } from "../src/lib/db";
import { logChange, periodEndDate } from "../src/lib/ingest";

function main() {
  const db = getDb();
  migrate(db);

  const before = (db.prepare("SELECT COUNT(*) c FROM change_logs").get() as { c: number }).c;

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM change_logs WHERE entity_type IN ('target_price','report','financial')").run();

    // ── 1) 증권사별 목표주가 변경 (리포트 발행일 기준) ──────────────────
    const reports = db
      .prepare(
        `SELECT r.corp_code, b.name AS broker, r.analyst, r.report_date, r.target_price,
                r.target_price_change, r.broker_id, r.report_id
         FROM consensus_reports r JOIN brokers b ON b.id = r.broker_id
         ORDER BY r.corp_code, r.broker_id, r.report_date, r.report_id`,
      )
      .all() as Array<{
      corp_code: string;
      broker: string;
      analyst: string | null;
      report_date: string;
      target_price: number | null;
      target_price_change: string | null;
      broker_id: number;
    }>;

    let prevKey = "";
    let prevTarget: number | null = null;
    let tpCount = 0;
    for (const r of reports) {
      const key = `${r.corp_code}:${r.broker_id}`;
      if (key !== prevKey) {
        prevKey = key;
        prevTarget = null;
      }
      const newTp = r.target_price;
      if (newTp != null && prevTarget != null && newTp !== prevTarget) {
        const delta = newTp - prevTarget;
        logChange(db, {
          corp_code: r.corp_code,
          entity_type: "target_price",
          entity_key: r.broker,
          field: "target_price",
          old_value: prevTarget,
          new_value: newTp,
          delta,
          delta_pct: prevTarget ? (delta / prevTarget) * 100 : null,
          change_kind: delta > 0 ? "up" : "down",
          note: `${r.broker} 목표주가 ${r.target_price_change ?? ""} (${r.analyst ?? ""})`,
          occurred_at: r.report_date,
        });
        tpCount++;
      } else if (newTp != null && prevTarget == null) {
        logChange(db, {
          corp_code: r.corp_code,
          entity_type: "target_price",
          entity_key: r.broker,
          field: "target_price",
          new_value: newTp,
          change_kind: "new",
          note: `${r.broker} 신규 커버리지 (${r.analyst ?? ""})`,
          occurred_at: r.report_date,
        });
        tpCount++;
      }
      if (newTp != null) prevTarget = newTp;
    }

    // ── 2) 분기 실적 QoQ/YoY (분기말 기준) ─────────────────────────────
    // 목표주가는 전체 과거를 남기되, 실적 변경은 최근 3년만(과거 분기 전체는
    // financials 테이블에 그대로 있고, 변경 피드가 17년치로 도배되지 않게).
    const finCutoff = new Date().getFullYear() - 3;
    const fin = db
      .prepare(
        `SELECT corp_code, metric, fiscal_year, quarter, value, qoq_pct, yoy_pct
         FROM v_financials_growth
         WHERE period_type='Q' AND is_estimate=0 AND fiscal_year >= ?
           AND (qoq_pct IS NOT NULL OR yoy_pct IS NOT NULL)
         ORDER BY corp_code, metric, fiscal_year, quarter`,
      )
      .all(finCutoff) as Array<{
      corp_code: string;
      metric: string;
      fiscal_year: number;
      quarter: number;
      value: number;
      qoq_pct: number | null;
      yoy_pct: number | null;
    }>;
    let finCount = 0;
    for (const f of fin) {
      logChange(db, {
        corp_code: f.corp_code,
        entity_type: "financial",
        entity_key: `${f.metric} ${f.fiscal_year}Q${f.quarter}`,
        field: f.metric,
        new_value: f.value,
        delta_pct: f.yoy_pct ?? f.qoq_pct,
        change_kind: f.yoy_pct != null ? "yoy" : "qoq",
        note: `QoQ ${f.qoq_pct ?? "-"}% / YoY ${f.yoy_pct ?? "-"}%`,
        occurred_at: periodEndDate(f.fiscal_year, f.quarter),
      });
      finCount++;
    }

    process.stdout.write(`목표주가 변경 ${tpCount}건, 실적 변경 ${finCount}건 재생성\n`);
  });
  tx();

  const after = (db.prepare("SELECT COUNT(*) c FROM change_logs").get() as { c: number }).c;
  const span = db
    .prepare(
      "SELECT MIN(occurred_at) a, MAX(occurred_at) b FROM change_logs WHERE entity_type='target_price'",
    )
    .get() as { a: string | null; b: string | null };
  process.stdout.write(`✅ 변경이력 ${before} → ${after}행. 목표주가 변경 기간: ${span.a} ~ ${span.b}\n`);
}

main();
process.exit(0);
