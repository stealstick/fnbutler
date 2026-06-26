/**
 * 네이버 검색 API로 기업별 최신 뉴스를 회전 수집한다.
 *
 *   tsx scripts/backfill-company-news.ts --limit 80
 *   tsx scripts/backfill-company-news.ts --corp 00126380 --force
 *   tsx scripts/backfill-company-news.ts --markets KOSPI,KOSDAQ
 *   tsx scripts/backfill-company-news.ts --providers stockanalysis --markets NASDAQ
 */
import { backfillCompanyNews } from "../src/lib/news";
import { closeDb, getDb, migrate, nowIso, query } from "../src/lib/db";
import { skipIfSchedulerDisabled } from "../src/lib/scheduler-control";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const csv = (value: string | undefined) =>
  value
    ?.split(",")
    .map((v) => v.trim())
    .filter(Boolean);

async function main() {
  const naverClientId = process.env.NAVER_CLIENT_ID || process.env.NAVER_SEARCH_CLIENT_ID;
  const naverClientSecret = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SEARCH_CLIENT_SECRET;
  const providers = csv(argOf("providers") || process.env.COMPANY_NEWS_PROVIDERS)?.filter(
    (p): p is "naver" | "stockanalysis" => p === "naver" || p === "stockanalysis",
  );
  if (providers?.includes("naver") && (!naverClientId || !naverClientSecret)) {
    throw new Error("naver provider에는 NAVER_CLIENT_ID/NAVER_CLIENT_SECRET 이 필요합니다.");
  }

  const db = getDb();
  await migrate(db);
  const started = nowIso();
  if (await skipIfSchedulerDisabled("fnbutler-news-refresh-2h", "기업 뉴스 백필", db)) return;
  const corpCode = argOf("corp") || argOf("corp-code");
  const force = has("force") || !!corpCode;
  const summary = await backfillCompanyNews(db, {
    naverClientId,
    naverClientSecret,
    providers,
    corpCode,
    limit: Number(argOf("limit") || process.env.COMPANY_NEWS_LIMIT || process.env.NAVER_NEWS_COMPANY_LIMIT || "80"),
    display: Number(argOf("display") || process.env.COMPANY_NEWS_DISPLAY || process.env.NAVER_NEWS_DISPLAY || "8"),
    retainPerCompany: Number(
      argOf("retain") || process.env.COMPANY_NEWS_RETAIN_PER_COMPANY || process.env.NAVER_NEWS_RETAIN_PER_COMPANY || "40",
    ),
    staleHours: force ? 0 : Number(argOf("stale-hours") || process.env.COMPANY_NEWS_STALE_HOURS || "2"),
    callDelayMs: Number(argOf("call-delay-ms") || process.env.COMPANY_NEWS_CALL_DELAY_MS || "500"),
    markets: csv(argOf("markets") || process.env.COMPANY_NEWS_MARKETS),
    log: has("quiet") ? undefined : (message) => process.stdout.write(message),
  });

  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('company-news', $1, $2, $3, $4)",
    [
      started,
      nowIso(),
      summary.fail === 0 ? 1 : 0,
      `targeted=${summary.targeted} ok=${summary.ok} fail=${summary.fail} skipped=${summary.skipped} fetched=${summary.fetched} writes=${summary.writes}`,
    ],
    db,
  );

  process.stdout.write(
    `기업 뉴스 백필 완료 — ok=${summary.ok}/${summary.targeted}, fail=${summary.fail}, skipped=${summary.skipped}, fetched=${summary.fetched}, writes=${summary.writes}\n`,
  );
}

if (process.argv[1]?.endsWith("backfill-company-news.ts")) {
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
