/**
 * Seeking Alpha 공개 symbol_data API에서 NASDAQ 분기/연간 EPS·매출 실제치/추정치를 보강한다.
 *
 *   tsx scripts/backfill-seekingalpha-nasdaq-estimates.ts --limit 100
 *   tsx scripts/backfill-seekingalpha-nasdaq-estimates.ts --symbol GOOG --limit 1
 *   tsx scripts/backfill-seekingalpha-nasdaq-estimates.ts --overwrite-estimates
 */
import { closeDb, getDb, migrate, nowIso, query } from "../src/lib/db";
import { backfillSeekingAlphaNasdaqEstimates } from "../src/lib/seekingalpha";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const db = getDb();
  await migrate(db);
  const started = nowIso();
  const summary = await backfillSeekingAlphaNasdaqEstimates(db, {
    limit: Number(argOf("limit") || process.env.SEEKING_ALPHA_NASDAQ_LIMIT || "500"),
    corpCode: argOf("corp"),
    symbol: argOf("symbol"),
    batchSize: Number(argOf("batch-size") || process.env.SEEKING_ALPHA_BATCH_SIZE || "5"),
    callDelayMs: Number(argOf("call-delay-ms") || process.env.SEEKING_ALPHA_CALL_DELAY_MS || "60000"),
    overwriteEstimates: has("overwrite-estimates") || process.env.SEEKING_ALPHA_OVERWRITE_ESTIMATES === "1",
    log: has("quiet") ? undefined : (message) => process.stdout.write(message),
  });

  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('seekingalpha-nasdaq-estimates', $1, $2, $3, $4)",
    [
      started,
      nowIso(),
      summary.fail === 0 ? 1 : 0,
      `targeted=${summary.targeted} mapped=${summary.mapped} ok=${summary.ok} fail=${summary.fail} writes=${summary.writes} financialWrites=${summary.financialWrites} usdKrw=${summary.usdKrw}`,
    ],
    db,
  );

  process.stdout.write(
    `Seeking Alpha NASDAQ 추정치 백필 완료 — ok=${summary.ok}/${summary.targeted}, mapped=${summary.mapped}, fail=${summary.fail}, writes=${summary.writes}, financialWrites=${summary.financialWrites}, usdKrw=${summary.usdKrw}\n`,
  );
}

if (process.argv[1]?.endsWith("backfill-seekingalpha-nasdaq-estimates.ts")) {
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
