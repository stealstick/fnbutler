/**
 * 일일 데이터 갱신 (Postgres 증분 + 멱등).
 *
 *   tsx scripts/refresh-daily.ts
 *   tsx scripts/refresh-daily.ts --scope watchlist
 *   tsx scripts/refresh-daily.ts --calendar-only
 *   tsx scripts/refresh-daily.ts --no-nasdaq
 *   tsx scripts/refresh-daily.ts --no-dart-financials
 *   tsx scripts/refresh-daily.ts --no-fnguide-estimates
 *   tsx scripts/refresh-daily.ts --no-summary-backfill
 *   tsx scripts/refresh-daily.ts --no-wisereport-estimates
 *
 * 특징
 *  - 증분: 피드는 최신순이라 이미 가진 report_id 를 만나면 중단 → 최근 신규분만 받음.
 *  - AI 요약: 새 리포트는 상세 API 요약을 저장하고, 짧은 feed 요약 잔여분은 매일 보정한다.
 *  - 멱등: 시세/목표가는 값이 바뀐 경우에만 UPDATE. 같은 데이터면 updated_at 도 그대로.
 *  - DART_API_KEY가 있으면 현재연도/전년도 정기보고서 재무 누락분을 함께 보강한다.
 *  - FnGuide와 WiseReport 공개 컨센서스에서 국내 추정치를 provider별로 보강한다.
 *  - Nasdaq screener 공개 JSON에서 NASDAQ/NYSE/AMEX 거래소별 시총 상위 500개 기업을 함께 보강한다.
 *  - FMP_API_KEY가 있으면 무료 플랜 한도 안에서 미국 상장기업 연간 추정치를 회전 보강한다.
 *  - Seeking Alpha 공개 JSON이 열리면 미국 상장기업 분기/연간 EPS·매출 실제치/추정치를 회전 보강한다.
 *  - Yahoo Finance 웹 JSON이 열리면 미국 상장기업 분기/연간 EPS·매출 추정치와 목표가를 보강한다.
 *  - StockAnalysis 공개 페이지에서 미국 상장기업 실제/예상 재무와 목표가/브로커별 목표가를 보강한다.
 *  - Postgres가 영속 저장소이므로 GCS DB 업로드/이미지 재배포는 하지 않는다.
 */
import { all, closeDb, getDb, migrate, nowIso, query } from "../src/lib/db";
import { ingestNewReports, refreshCompanyQuote } from "../src/lib/ingest";
import { recordDailySnapshot, dispatchAlerts } from "../src/lib/poll";
import { ingestCalendar } from "../src/lib/calendar";
import { ingestNasdaqTopCompanies } from "../src/lib/nasdaq";
import { backfillFmpNasdaqEstimates } from "../src/lib/fmp";
import { backfillSeekingAlphaNasdaqEstimates } from "../src/lib/seekingalpha";
import { backfillYahooNasdaqEstimates } from "../src/lib/yahoo";
import { backfillStockAnalysisNasdaqEstimates } from "../src/lib/stockanalysis";
import { backfillDartFinancials } from "./backfill-dart-financials";
import { backfillFnGuideEstimates } from "./backfill-fnguide-estimates";
import { backfillConsensusSummaries } from "./backfill-summaries";
import { backfillWiseReportEstimates } from "./backfill-wisereport-estimates";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const BASE_URL = process.env.BUTLER_BASE_URL || "https://fnbutler-l3why3suea-du.a.run.app";

function parseYearList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const years = raw
    .split(",")
    .map((y) => Number(y.trim()))
    .filter((y) => Number.isInteger(y) && y > 1900);
  return years.length > 0 ? [...new Set(years)] : fallback;
}

async function main() {
  const db = getDb();
  await migrate(db);
  const runStart = nowIso();
  const today = runStart.slice(0, 10);
  const scope = argOf("scope") ?? "all";
  const calendarOnly = has("calendar-only");

  let nasdaqMsg = "skip";
  if (!calendarOnly && !has("no-nasdaq")) {
    try {
      const nasdaqLimit = Number(argOf("nasdaq-limit") || process.env.NASDAQ_COMPANY_LIMIT || "500");
      const n = await ingestNasdaqTopCompanies(db, nasdaqLimit, (message) => process.stdout.write(`   nasdaq ${message}`));
      nasdaqMsg = `selected=${n.selected},upserted=${n.upserted},usdKrw=${n.usdKrw}`;
    } catch (e) {
      nasdaqMsg = `error: ${(e as Error).message}`;
      process.stdout.write(`   nasdaq error ${(e as Error).message}\n`);
    }
  }

  const targets = (
    calendarOnly
      ? ([] as { corp_code: string }[])
      : scope === "watchlist"
        ? await all<{ corp_code: string }>(
            `SELECT DISTINCT w.corp_code
             FROM watchlist w
             JOIN companies c ON c.corp_code = w.corp_code
             WHERE c.active = 1 AND c.source <> 'nasdaq'`,
            [],
            db,
          )
        : await all<{ corp_code: string }>(
            `SELECT corp_code FROM companies
             WHERE active = 1
               AND source <> 'nasdaq'
               AND (has_consensus = 1 OR corp_code IN (SELECT corp_code FROM watchlist))
             ORDER BY market_cap DESC NULLS LAST`,
            [],
            db,
          )
  ).map((r) => r.corp_code);

  process.stdout.write(
    `[${runStart}] ${calendarOnly ? "캘린더 전용" : "일일"} 갱신 시작 — 대상 ${targets.length}개 (scope=${scope})\n`,
  );

  let newReports = 0;
  let quoteUpdated = 0;
  let unchanged = 0;
  let errors = 0;
  for (let i = 0; i < targets.length; i++) {
    const cc = targets[i];
    try {
      const nr = await ingestNewReports(db, cc);
      const q = await refreshCompanyQuote(db, cc);
      await recordDailySnapshot(db, cc, today);
      newReports += nr;
      if (q === "updated") quoteUpdated++;
      else unchanged++;
      if (nr > 0 || q === "updated")
        process.stdout.write(`   ${cc}  신규리포트 +${nr}  시세 ${q}\n`);
    } catch (e) {
      errors++;
      process.stdout.write(`   ${cc}  ERROR ${(e as Error).message}\n`);
    }
  }

  let summariesMsg = "skip";
  if (!has("no-summary-backfill")) {
    const limit = Number(argOf("summary-backfill-limit") || process.env.SUMMARY_BACKFILL_LIMIT || "0");
    const summary = await backfillConsensusSummaries(db, {
      includeAll: true,
      onlyIncomplete: true,
      limit,
      log: (message) => process.stdout.write(`   summaries ${message}`),
    });
    summariesMsg = `targeted=${summary.targeted},updated=${summary.updated},skipped=${summary.skipped},failed=${summary.failed}`;
  }

  let calendarMsg = "skip";
  if (!has("no-calendar")) {
    try {
      const cr = await ingestCalendar(db, { dartKey: process.env.DART_API_KEY || undefined });
      calendarMsg = `macro=${cr.macro} intl=${cr.earningsIntl} kr=${cr.earningsKr}`;
      process.stdout.write(`   calendar ${calendarMsg}\n`);
    } catch (e) {
      calendarMsg = `error: ${(e as Error).message}`;
      process.stdout.write(`   calendar error ${(e as Error).message}\n`);
    }
  }

  if (calendarOnly) {
    process.stdout.write(`캘린더 전용 갱신 완료 — ${calendarMsg}\n`);
    return;
  }

  let fmpNasdaqMsg = "skip";
  if (!has("no-fmp-nasdaq-estimates")) {
    const fmpKey = process.env.FMP_API_KEY;
    if (!fmpKey) {
      fmpNasdaqMsg = "skip:no-key";
      process.stdout.write("   fmp-nasdaq-estimates FMP_API_KEY 미설정 → 건너뜀\n");
    } else {
      const budget = Math.max(0, Number(argOf("fmp-budget") || process.env.FMP_DAILY_CALL_BUDGET || "240"));
      const targetCalls = Math.max(0, Number(argOf("fmp-target-calls") || process.env.FMP_TARGET_CALLS_PER_DAY || "0"));
      const estimateCalls = Math.max(
        0,
        Number(argOf("fmp-estimate-calls") || String(Math.max(0, budget - targetCalls))),
      );
      const summary = await backfillFmpNasdaqEstimates(db, {
        apiKey: fmpKey,
        estimateCalls,
        targetCalls,
        estimateLimit: Number(argOf("fmp-estimate-limit") || process.env.FMP_ESTIMATE_LIMIT || "10"),
        callDelayMs: Number(argOf("fmp-call-delay-ms") || process.env.FMP_CALL_DELAY_MS || "2500"),
        log: (message) => process.stdout.write(`   fmp-nasdaq-estimates ${message}`),
      });
      fmpNasdaqMsg = `estimateOk=${summary.estimateOk}/${summary.estimateTargeted},estimateFail=${summary.estimateFail},targetOk=${summary.targetOk}/${summary.targetTargeted},targetFail=${summary.targetFail},calls=${summary.estimateCalls + summary.targetCalls},writes=${summary.writes}`;
    }
  }

  let dartFinancialsMsg = "skip";
  if (!has("no-dart-financials")) {
    const dartKey = process.env.DART_API_KEY;
    if (!dartKey) {
      dartFinancialsMsg = "skip:no-key";
      process.stdout.write("   dart-financials DART_API_KEY 미설정 → 건너뜀\n");
    } else {
      const currentYear = Number(today.slice(0, 4));
      const years = parseYearList(argOf("dart-years"), [currentYear, currentYear - 1]);
      const summaries = [];
      for (const year of years) {
        summaries.push(
          await backfillDartFinancials(db, dartKey, {
            year,
            log: (message) => process.stdout.write(`   dart-financials ${message}`),
          }),
        );
      }
      dartFinancialsMsg = summaries
        .map((s) => `${s.year}:targeted=${s.targeted},writes=${s.writes},fail=${s.fail}`)
        .join(";");
    }
  }

  let fnGuideEstimatesMsg = "skip";
  if (!has("no-fnguide-estimates")) {
    const estimateLimit = Number(argOf("fnguide-estimate-limit") || process.env.FNGUIDE_ESTIMATE_LIMIT || "0");
    const summary = await backfillFnGuideEstimates(db, {
      limit: estimateLimit,
      log: (message) => process.stdout.write(`   fnguide-estimates ${message}`),
    });
    fnGuideEstimatesMsg = `targeted=${summary.targeted},writes=${summary.writes},fail=${summary.fail}`;
  }

  let wiseEstimatesMsg = "skip";
  if (!has("no-wisereport-estimates")) {
    const estimateLimit = Number(argOf("wisereport-estimate-limit") || process.env.WISEREPORT_ESTIMATE_LIMIT || "0");
    const summary = await backfillWiseReportEstimates(db, {
      limit: estimateLimit,
      log: (message) => process.stdout.write(`   wisereport-estimates ${message}`),
    });
    wiseEstimatesMsg = `targeted=${summary.targeted},writes=${summary.writes},fail=${summary.fail}`;
  }

  let seekingAlphaNasdaqMsg = "skip";
  if (!has("no-seekingalpha-nasdaq-estimates")) {
    try {
      const summary = await backfillSeekingAlphaNasdaqEstimates(db, {
        limit: Number(argOf("seekingalpha-nasdaq-limit") || process.env.SEEKING_ALPHA_NASDAQ_LIMIT || "500"),
        batchSize: Number(argOf("seekingalpha-batch-size") || process.env.SEEKING_ALPHA_BATCH_SIZE || "5"),
        callDelayMs: Number(argOf("seekingalpha-call-delay-ms") || process.env.SEEKING_ALPHA_CALL_DELAY_MS || "60000"),
        overwriteEstimates:
          has("seekingalpha-overwrite-estimates") || process.env.SEEKING_ALPHA_OVERWRITE_ESTIMATES === "1",
        log: (message) => process.stdout.write(`   seekingalpha-nasdaq-estimates ${message}`),
      });
      seekingAlphaNasdaqMsg = `targeted=${summary.targeted},mapped=${summary.mapped},ok=${summary.ok},fail=${summary.fail},writes=${summary.writes}`;
    } catch (e) {
      seekingAlphaNasdaqMsg = `error: ${(e as Error).message}`;
      process.stdout.write(`   seekingalpha-nasdaq-estimates error ${(e as Error).message}\n`);
    }
  }

  let yahooNasdaqMsg = "skip";
  if (!has("no-yahoo-nasdaq-estimates")) {
    try {
      const summary = await backfillYahooNasdaqEstimates(db, {
        limit: Number(argOf("yahoo-nasdaq-limit") || process.env.YAHOO_NASDAQ_LIMIT || "30"),
        callDelayMs: Number(argOf("yahoo-call-delay-ms") || process.env.YAHOO_CALL_DELAY_MS || "2500"),
        jitterMs: Number(argOf("yahoo-jitter-ms") || process.env.YAHOO_JITTER_MS || "750"),
        overwriteEstimates: has("yahoo-overwrite-estimates") || process.env.YAHOO_OVERWRITE_ESTIMATES === "1",
        overwriteTargets: has("yahoo-overwrite-targets") || process.env.YAHOO_OVERWRITE_TARGETS === "1",
        log: (message) => process.stdout.write(`   yahoo-nasdaq-estimates ${message}`),
      });
      yahooNasdaqMsg = `targeted=${summary.targeted},ok=${summary.ok},fail=${summary.fail},writes=${summary.writes}`;
    } catch (e) {
      yahooNasdaqMsg = `error: ${(e as Error).message}`;
      process.stdout.write(`   yahoo-nasdaq-estimates error ${(e as Error).message}\n`);
    }
  }

  let stockAnalysisNasdaqMsg = "skip";
  if (!has("no-stockanalysis-nasdaq-estimates")) {
    try {
      const summary = await backfillStockAnalysisNasdaqEstimates(db, {
        limit: Number(argOf("stockanalysis-nasdaq-limit") || process.env.STOCKANALYSIS_NASDAQ_LIMIT || "12"),
        callDelayMs: Number(argOf("stockanalysis-call-delay-ms") || process.env.STOCKANALYSIS_CALL_DELAY_MS || "7000"),
        jitterMs: Number(argOf("stockanalysis-jitter-ms") || process.env.STOCKANALYSIS_JITTER_MS || "3000"),
        overwriteEstimates:
          has("stockanalysis-overwrite-estimates") || process.env.STOCKANALYSIS_OVERWRITE_ESTIMATES === "1",
        overwriteTargets: has("stockanalysis-overwrite-targets") || process.env.STOCKANALYSIS_OVERWRITE_TARGETS === "1",
        writeBrokerTargets:
          !has("stockanalysis-no-broker-targets") && process.env.STOCKANALYSIS_BROKER_TARGETS !== "0",
        log: (message) => process.stdout.write(`   stockanalysis-nasdaq-estimates ${message}`),
      });
      stockAnalysisNasdaqMsg = `targeted=${summary.targeted},ok=${summary.ok},fail=${summary.fail},writes=${summary.writes},reports=${summary.reportWrites}`;
    } catch (e) {
      stockAnalysisNasdaqMsg = `error: ${(e as Error).message}`;
      process.stdout.write(`   stockanalysis-nasdaq-estimates error ${(e as Error).message}\n`);
    }
  }

  const { sent } = await dispatchAlerts(db, { sinceIso: runStart, baseUrl: BASE_URL });
  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('refresh-daily', $1, $2, 1, $3)",
    [
      runStart,
      nowIso(),
      `targets=${targets.length} newReports=${newReports} quoteUpdated=${quoteUpdated} unchanged=${unchanged} alerts=${sent} errors=${errors} nasdaq=${nasdaqMsg} summaries=${summariesMsg} calendar=${calendarMsg} fmpNasdaq=${fmpNasdaqMsg} seekingAlphaNasdaq=${seekingAlphaNasdaqMsg} yahooNasdaq=${yahooNasdaqMsg} stockAnalysisNasdaq=${stockAnalysisNasdaqMsg} dartFinancials=${dartFinancialsMsg} fnGuideEstimates=${fnGuideEstimatesMsg} wiseEstimates=${wiseEstimatesMsg}`,
    ],
    db,
  );

  process.stdout.write(
    `갱신 완료 — 신규리포트 ${newReports} · 시세변경 ${quoteUpdated} · 무변경 ${unchanged} · 알림 ${sent} · 오류 ${errors} · 미국상장 ${nasdaqMsg} · 요약백필 ${summariesMsg} · FMP해외추정 ${fmpNasdaqMsg} · SA미국 ${seekingAlphaNasdaqMsg} · Yahoo미국 ${yahooNasdaqMsg} · StockAnalysis미국 ${stockAnalysisNasdaqMsg} · DART재무 ${dartFinancialsMsg} · FnGuide추정 ${fnGuideEstimatesMsg} · WiseReport추정 ${wiseEstimatesMsg}\n`,
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
