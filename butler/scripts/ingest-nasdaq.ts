/**
 * 미국 상장 시가총액 상위 기업 적재.
 *
 *   tsx scripts/ingest-nasdaq.ts
 *   tsx scripts/ingest-nasdaq.ts --limit 500
 *
 * Nasdaq screener 공개 JSON에서 NASDAQ/NYSE/AMEX 거래소별 상위 종목·현재가·등락률·시총·섹터를 가져오고,
 * 시총은 USD/KRW 환율로 원화 환산해 기존 국내 기업과 같은 정렬 기준으로 저장한다.
 */
import { closeDb, getDb, migrate, query, nowIso } from "../src/lib/db";
import { ingestNasdaqTopCompanies } from "../src/lib/nasdaq";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

async function main() {
  const db = getDb();
  await migrate(db);
  const started = nowIso();
  const limit = Math.max(1, Number(arg("limit") || process.env.NASDAQ_COMPANY_LIMIT || "500"));
  const summary = await ingestNasdaqTopCompanies(db, limit, (message) => process.stdout.write(message));
  await query(
    "INSERT INTO ingest_runs (kind, started_at, finished_at, ok, note) VALUES ('nasdaq-companies', $1, $2, 1, $3)",
    [
      started,
      nowIso(),
      `limit=${limit} selected=${summary.selected} upserted=${summary.upserted} usdKrw=${summary.usdKrw}`,
    ],
    db,
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
