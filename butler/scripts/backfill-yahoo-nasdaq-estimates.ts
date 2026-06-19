/**
 * Yahoo Finance quoteSummary에서 NASDAQ 목표가와 EPS/매출 추정치를 보강한다.
 *
 *   tsx scripts/backfill-yahoo-nasdaq-estimates.ts --limit 30
 *   tsx scripts/backfill-yahoo-nasdaq-estimates.ts --symbol AAPL --limit 1
 *   tsx scripts/backfill-yahoo-nasdaq-estimates.ts --overwrite-estimates --overwrite-targets
 */
import { backfillYahooNasdaqEstimates } from "../src/lib/yahoo";
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
  const summary = await backfillYahooNasdaqEstimates(db, {
    limit: Number(argOf("limit") || process.env.YAHOO_NASDAQ_LIMIT || "30"),
    corpCode: argOf("corp"),
    symbol: argOf("symbol"),
    callDelayMs: Number(argOf("call-delay-ms") || process.env.YAHOO_CALL_DELAY_MS || "2500"),
    jitterMs: Number(argOf("jitter-ms") || process.env.YAHOO_JITTER_MS || "750"),
    overwriteEstimates: has("overwrite-estimates") || process.env.YAHOO_OVERWRITE_ESTIMATES === "1",
    overwriteTargets: has("overwrite-targets") || process.env.YAHOO_OVERWRITE_TARGETS === "1",
    log: has("quiet") ? undefined : (message) => process.stdout.write(message),
  });

  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('yahoo-nasdaq-estimates', $1, $2, $3, $4)",
    [
      started,
      nowIso(),
      summary.fail === 0 ? 1 : 0,
      `targeted=${summary.targeted} ok=${summary.ok} fail=${summary.fail} writes=${summary.writes} estimateWrites=${summary.estimateWrites} targetWrites=${summary.targetWrites} usdKrw=${summary.usdKrw}`,
    ],
    db,
  );

  process.stdout.write(
    `Yahoo NASDAQ 추정치 백필 완료 — ok=${summary.ok}/${summary.targeted}, fail=${summary.fail}, writes=${summary.writes}, estimates=${summary.estimateWrites}, targets=${summary.targetWrites}, usdKrw=${summary.usdKrw}\n`,
  );
}

if (process.argv[1]?.endsWith("backfill-yahoo-nasdaq-estimates.ts")) {
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
