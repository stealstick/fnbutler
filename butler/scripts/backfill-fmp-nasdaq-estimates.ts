/**
 * FMP 무료 플랜 한도 안에서 NASDAQ 추정치를 회전 백필한다.
 *
 *   FMP_API_KEY=... tsx scripts/backfill-fmp-nasdaq-estimates.ts
 *   FMP_API_KEY=... tsx scripts/backfill-fmp-nasdaq-estimates.ts --budget 240
 *   FMP_API_KEY=... tsx scripts/backfill-fmp-nasdaq-estimates.ts --symbol AAPL --budget 1
 *   FMP_API_KEY=... tsx scripts/backfill-fmp-nasdaq-estimates.ts --estimate-calls 220 --target-calls 20
 */
import { closeDb, getDb, migrate, nowIso, query } from "../src/lib/db";
import { backfillFmpNasdaqEstimates } from "../src/lib/fmp";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const db = getDb();
  await migrate(db);
  const started = nowIso();
  const apiKey = process.env.FMP_API_KEY || "";
  if (!apiKey) throw new Error("FMP_API_KEY is not configured");

  const budget = Math.max(0, Number(argOf("budget") || process.env.FMP_DAILY_CALL_BUDGET || "240"));
  const configuredTargets = argOf("target-calls") || process.env.FMP_TARGET_CALLS_PER_DAY;
  const targetCalls = Math.max(0, Number(configuredTargets || "0"));
  const estimateCalls = Math.max(0, Number(argOf("estimate-calls") || String(Math.max(0, budget - targetCalls))));
  const estimateLimit = Number(argOf("estimate-limit") || process.env.FMP_ESTIMATE_LIMIT || "10");

  const summary = await backfillFmpNasdaqEstimates(db, {
    apiKey,
    estimateCalls,
    targetCalls,
    estimateLimit,
    corpCode: argOf("corp"),
    symbol: argOf("symbol"),
    log: has("quiet") ? undefined : (message) => process.stdout.write(message),
  });

  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('fmp-nasdaq-estimates', $1, $2, $3, $4)",
    [
      started,
      nowIso(),
      summary.estimateFail + summary.targetFail === 0 ? 1 : 0,
      `estimateTargeted=${summary.estimateTargeted} estimateOk=${summary.estimateOk} estimateFail=${summary.estimateFail} targetTargeted=${summary.targetTargeted} targetOk=${summary.targetOk} targetFail=${summary.targetFail} writes=${summary.writes} estimateCalls=${summary.estimateCalls} targetCalls=${summary.targetCalls} usdKrw=${summary.usdKrw}`,
    ],
    db,
  );

  process.stdout.write(
    `FMP NASDAQ 추정치 백필 완료 — estimates ${summary.estimateOk}/${summary.estimateTargeted}, targets ${summary.targetOk}/${summary.targetTargeted}, writes=${summary.writes}, calls=${summary.estimateCalls + summary.targetCalls}\n`,
  );
}

if (process.argv[1]?.endsWith("backfill-fmp-nasdaq-estimates.ts")) {
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
