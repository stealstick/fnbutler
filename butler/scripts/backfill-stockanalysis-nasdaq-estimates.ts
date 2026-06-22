/**
 * StockAnalysis 공개 forecast 페이지에서 NASDAQ 실제/예상 재무, 목표주가, 브로커별 목표가를 보강한다.
 *
 *   tsx scripts/backfill-stockanalysis-nasdaq-estimates.ts --limit 12
 *   tsx scripts/backfill-stockanalysis-nasdaq-estimates.ts --symbol AAPL --limit 1
 *   tsx scripts/backfill-stockanalysis-nasdaq-estimates.ts --overwrite-estimates --overwrite-targets
 *   tsx scripts/backfill-stockanalysis-nasdaq-estimates.ts --no-broker-targets
 */
import { backfillStockAnalysisNasdaqEstimates } from "../src/lib/stockanalysis";
import { closeDb, getDb, migrate, nowIso, query } from "../src/lib/db";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const db = getDb();
  await migrate(db);
  const started = nowIso();
  const summary = await backfillStockAnalysisNasdaqEstimates(db, {
    limit: Number(argOf("limit") || process.env.STOCKANALYSIS_NASDAQ_LIMIT || "12"),
    corpCode: argOf("corp"),
    symbol: argOf("symbol"),
    callDelayMs: Number(argOf("call-delay-ms") || process.env.STOCKANALYSIS_CALL_DELAY_MS || "7000"),
    jitterMs: Number(argOf("jitter-ms") || process.env.STOCKANALYSIS_JITTER_MS || "3000"),
    overwriteEstimates: has("overwrite-estimates") || process.env.STOCKANALYSIS_OVERWRITE_ESTIMATES === "1",
    overwriteTargets: has("overwrite-targets") || process.env.STOCKANALYSIS_OVERWRITE_TARGETS === "1",
    writeBrokerTargets: !has("no-broker-targets") && process.env.STOCKANALYSIS_BROKER_TARGETS !== "0",
    log: has("quiet") ? undefined : (message) => process.stdout.write(message),
  });

  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('stockanalysis-nasdaq-estimates', $1, $2, $3, $4)",
    [
      started,
      nowIso(),
      summary.fail === 0 ? 1 : 0,
      `targeted=${summary.targeted} ok=${summary.ok} fail=${summary.fail} writes=${summary.writes} actualWrites=${summary.actualWrites} estimateWrites=${summary.estimateWrites} targetWrites=${summary.targetWrites} reportWrites=${summary.reportWrites} usdKrw=${summary.usdKrw}`,
    ],
    db,
  );

  process.stdout.write(
    `StockAnalysis NASDAQ 백필 완료 — ok=${summary.ok}/${summary.targeted}, fail=${summary.fail}, writes=${summary.writes}, actual=${summary.actualWrites}, estimates=${summary.estimateWrites}, targets=${summary.targetWrites}, reports=${summary.reportWrites}, usdKrw=${summary.usdKrw}\n`,
  );
}

if (process.argv[1]?.endsWith("backfill-stockanalysis-nasdaq-estimates.ts")) {
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
}
