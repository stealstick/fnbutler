/**
 * 변경이력 재생성 — 원본(consensus_reports / financials)에서 실제 발생일(occurred_at)
 * 기준으로 과거 변경 타임라인을 통째로 다시 만든다. 멱등(삭제 후 재생성).
 */
import { all, closeDb, getDb, migrate, one, query, tx } from "../src/lib/db";
import { logChange, periodEndDate } from "../src/lib/ingest";

async function main() {
  const db = getDb();
  await migrate(db);

  const before = Number((await one<{ c: number }>("SELECT COUNT(*)::int c FROM change_logs", [], db))?.c ?? 0);

  let tpCount = 0;
  let finCount = 0;
  await tx(async (client) => {
    await query("DELETE FROM change_logs WHERE entity_type IN ('target_price','report','financial')", [], client);

    const reports = await all<{
      corp_code: string;
      broker: string;
      analyst: string | null;
      report_date: string;
      target_price: number | null;
      target_price_change: string | null;
      broker_id: number;
      report_id: string;
    }>(
      `SELECT r.corp_code, b.name AS broker, r.analyst, r.report_date, r.target_price,
              r.target_price_change, r.broker_id, r.report_id
       FROM consensus_reports r JOIN brokers b ON b.id = r.broker_id
       ORDER BY r.corp_code, r.broker_id, r.report_date, r.report_id`,
      [],
      client,
    );

    let prevKey = "";
    let prevTarget: number | null = null;
    for (const r of reports) {
      const key = `${r.corp_code}:${r.broker_id}`;
      if (key !== prevKey) {
        prevKey = key;
        prevTarget = null;
      }
      const newTp = r.target_price;
      if (newTp != null && prevTarget != null && newTp !== prevTarget) {
        const delta = newTp - prevTarget;
        await logChange(client, {
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
        await logChange(client, {
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

    const finCutoff = new Date().getFullYear() - 3;
    const fin = await all<{
      corp_code: string;
      metric: string;
      fiscal_year: number;
      quarter: number;
      value: number;
      qoq_pct: number | null;
      yoy_pct: number | null;
    }>(
      `SELECT corp_code, metric, fiscal_year, quarter, value, qoq_pct, yoy_pct
       FROM v_financials_growth
       WHERE period_type='Q' AND is_estimate=0 AND fiscal_year >= $1
         AND (qoq_pct IS NOT NULL OR yoy_pct IS NOT NULL)
       ORDER BY corp_code, metric, fiscal_year, quarter`,
      [finCutoff],
      client,
    );
    for (const f of fin) {
      await logChange(client, {
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
  });

  const after = Number((await one<{ c: number }>("SELECT COUNT(*)::int c FROM change_logs", [], db))?.c ?? 0);
  const span = await one<{ a: string | null; b: string | null }>(
    "SELECT MIN(occurred_at) a, MAX(occurred_at) b FROM change_logs WHERE entity_type='target_price'",
    [],
    db,
  );
  process.stdout.write(`목표주가 변경 ${tpCount}건, 실적 변경 ${finCount}건 재생성\n`);
  process.stdout.write(`변경이력 ${before} -> ${after}행. 목표주가 변경 기간: ${span?.a} ~ ${span?.b}\n`);
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
