/**
 * 미국 상장기업 월별 목표주가 차트 1년 백필.
 *
 *   tsx scripts/backfill-us-target-monthly.ts
 *   tsx scripts/backfill-us-target-monthly.ts --limit 200
 *   tsx scripts/backfill-us-target-monthly.ts --symbol NVDA
 *   tsx scripts/backfill-us-target-monthly.ts --fmp-budget 300
 *
 * 배경: 미국주 target_price_monthly 는 StockAnalysis 백필이 "현재 달" 한 행씩만
 * 쌓기 시작해서 과거 이력이 없다 (차트가 최근 1~2달만 표시).
 *
 * 전략 (실데이터만 사용):
 *  1) 주가선: Yahoo chart API 월봉 종가 12개월 → price 만 보강 (기존 값 보존).
 *  2) 목표가선: FMP price-target-news(애널리스트 목표가 발표 이력)를
 *     consensus_reports 로 멱등 저장 → fillTargetMonthlyConsensus 가 각 월말 기준
 *     활성 커버리지(브로커별 최신 목표가, 12개월 창, 3곳 이상)로 tp_avg/min/max 재계산.
 *     FMP 플랜이 막혀 있으면(402/403) 목표가선은 보유 데이터 범위만 채운다.
 *
 * 멱등: 여러 번 실행해도 안전. price 는 NULL 인 곳만 채우고, 리포트는 report_id 로
 * 중복 방지, tp_* 는 source='consensus-fill' 행만 갱신된다.
 */
import { createHash } from "node:crypto";
import { all, closeDb, getDb, migrate, nowIso, one, query, type Queryable } from "../src/lib/db";
import { fillTargetMonthlyConsensus } from "../src/lib/ingest";

const has = (f: string) => process.argv.includes(`--${f}`);
const argOf = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Yahoo 는 풀 브라우저 UA 를 봇으로 보고 429 를 주는 경우가 있어 단순 UA 를 쓴다.
const UA = {
  "user-agent": "Mozilla/5.0",
  accept: "application/json, text/plain, */*",
};

function monthKeyOf(d: Date): string {
  const y = d.getUTCFullYear() % 100;
  const m = d.getUTCMonth() + 1;
  return `${String(y).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

function monthEndDate(d: Date): string {
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return end.toISOString().slice(0, 10);
}

/** StockAnalysis 월봉 종가 (1Y). 잡 환경(GCP)에서 Yahoo가 차단돼도 SA는 열려 있다. */
async function fetchStockAnalysisMonthlyCloses(
  symbol: string,
): Promise<Array<{ month: string; fullDate: string; close: number }>> {
  const url = `https://api.stockanalysis.com/api/symbol/s/${encodeURIComponent(symbol.toLowerCase())}/history?range=1Y&period=Monthly`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`stockanalysis history ${symbol} HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ t?: string; c?: number | null }> };
  const out: Array<{ month: string; fullDate: string; close: number }> = [];
  for (const r of data.data ?? []) {
    if (!r.t || r.c == null || !Number.isFinite(r.c)) continue;
    const d = new Date(`${r.t}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    out.push({ month: monthKeyOf(d), fullDate: monthEndDate(d), close: r.c });
  }
  if (out.length === 0) throw new Error(`stockanalysis history ${symbol} empty`);
  return out;
}

/** Yahoo 월봉 종가 (range=1y). 429는 백오프 후 재시도, 실패 시 query2 폴백. */
async function fetchYahooMonthlyCloses(
  symbol: string,
): Promise<Array<{ month: string; fullDate: string; close: number }>> {
  let lastErr: Error | null = null;
  for (const host of ["query1", "query2", "query1"]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1mo`;
      let res = await fetch(url, { headers: UA });
      if (res.status === 429) {
        await sleep(2500 + Math.floor(Math.random() * 1500));
        res = await fetch(url, { headers: UA });
      }
      if (!res.ok) throw new Error(`yahoo ${symbol} HTTP ${res.status}`);
      const data = (await res.json()) as {
        chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
      };
      const r = data.chart?.result?.[0];
      const ts = r?.timestamp ?? [];
      const closes = r?.indicators?.quote?.[0]?.close ?? [];
      const out = new Map<string, { month: string; fullDate: string; close: number }>();
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c == null || !Number.isFinite(c)) continue;
        const d = new Date(ts[i] * 1000);
        const mk = monthKeyOf(d);
        // 같은 달 중복 바(당월)는 마지막 값 우선
        out.set(mk, { month: mk, fullDate: monthEndDate(d), close: c });
      }
      return [...out.values()];
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error(`yahoo ${symbol} failed`);
}

/** 월봉 종가: StockAnalysis 우선, 실패 시 Yahoo 폴백. */
async function fetchMonthlyCloses(symbol: string): Promise<Array<{ month: string; fullDate: string; close: number }>> {
  try {
    return await fetchStockAnalysisMonthlyCloses(symbol);
  } catch {
    return fetchYahooMonthlyCloses(symbol);
  }
}

interface FmpTargetNews {
  symbol?: string;
  publishedDate?: string;
  analystName?: string | null;
  analystCompany?: string | null;
  newsPublisher?: string | null;
  priceTarget?: number | null;
  adjPriceTarget?: number | null;
  priceWhenPosted?: number | null;
}

/** FMP 애널리스트 목표가 발표 이력. 플랜 미포함(402/403)이면 null. */
async function fetchFmpTargetHistory(
  apiKey: string,
  symbol: string,
): Promise<FmpTargetNews[] | null> {
  const rows: FmpTargetNews[] = [];
  const cutoff = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
  for (let page = 0; page < 4; page++) {
    const url = `https://financialmodelingprep.com/stable/price-target-news?symbol=${encodeURIComponent(symbol)}&page=${page}&limit=100&apikey=${apiKey}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 402 || res.status === 403) return null; // 플랜 미포함
    if (res.status === 429) {
      await sleep(2000);
      page--;
      continue;
    }
    if (!res.ok) throw new Error(`fmp price-target-news ${symbol} HTTP ${res.status}`);
    const batch = (await res.json()) as FmpTargetNews[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    const oldest = batch[batch.length - 1]?.publishedDate?.slice(0, 10) ?? "";
    if (batch.length < 100 || (oldest && oldest < cutoff)) break;
  }
  return rows;
}

async function getBrokerId(db: Queryable, name: string): Promise<number> {
  const existing = await one<{ id: number }>("SELECT id FROM brokers WHERE name = $1", [name], db);
  if (existing) return existing.id;
  const inserted = await one<{ id: number }>(
    "INSERT INTO brokers (name, research_url) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id",
    [name, null],
    db,
  );
  if (!inserted) throw new Error(`failed to insert broker: ${name}`);
  return inserted.id;
}

async function insertFmpReports(db: Queryable, corpCode: string, symbol: string, rows: FmpTargetNews[]): Promise<number> {
  const now = nowIso();
  let writes = 0;
  for (const r of rows) {
    const target = r.adjPriceTarget ?? r.priceTarget;
    const date = r.publishedDate?.slice(0, 10);
    const firm = (r.analystCompany || r.newsPublisher || "").trim();
    if (!target || !date || !firm) continue;
    const hash = createHash("sha1").update([symbol, firm, date, String(target)].join("|")).digest("hex").slice(0, 12);
    const reportId = `fmp:${symbol}:${hash}`;
    const brokerId = await getBrokerId(db, firm);
    const res = await query(
      `INSERT INTO consensus_reports
         (report_id, corp_code, broker_id, analyst, report_date, target_price, price_close, source, ingested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'fmp', $8)
       ON CONFLICT (report_id) DO NOTHING`,
      [reportId, corpCode, brokerId, r.analystName?.trim() || null, date, target, r.priceWhenPosted ?? null, now],
      db,
    );
    writes += res.rowCount ?? 0;
  }
  return writes;
}

async function upsertMonthlyPrices(
  db: Queryable,
  corpCode: string,
  closes: Array<{ month: string; fullDate: string; close: number }>,
): Promise<number> {
  let writes = 0;
  for (const c of closes) {
    const res = await query(
      `INSERT INTO target_price_monthly (corp_code, month, full_date, price, source)
       VALUES ($1, $2, $3, $4, 'yahoo-price')
       ON CONFLICT (corp_code, month) DO UPDATE SET
         price = COALESCE(target_price_monthly.price, excluded.price),
         full_date = COALESCE(target_price_monthly.full_date, excluded.full_date)`,
      [corpCode, c.month, c.fullDate, c.close],
      db,
    );
    writes += res.rowCount ?? 0;
  }
  return writes;
}

async function main() {
  const db = getDb();
  await migrate(db);

  const limit = Math.max(0, Math.floor(Number(argOf("limit") || "650")));
  const symbol = argOf("symbol")?.toUpperCase();
  const callDelayMs = Math.max(0, Math.floor(Number(argOf("call-delay-ms") || "1200")));
  let fmpBudget = Math.max(0, Math.floor(Number(argOf("fmp-budget") || process.env.FMP_TARGET_HISTORY_BUDGET || "300")));
  const fmpKey = process.env.FMP_API_KEY || "";
  let fmpEnabled = Boolean(fmpKey) && !has("no-fmp");

  // 주의: has_consensus 로 거르지 않는다 — 운영에서 미국주는 커버리지가 있어도
  // has_consensus=0 인 행이 많다(플래그는 국내 butler ingest 기준). 주가선은 전
  // 미국주에 필요하고, tp_* 는 어차피 브로커 3곳 이상일 때만 채워진다.
  const params: unknown[] = [];
  const where = ["active = 1", "source = 'nasdaq'"];
  if (symbol) {
    params.push(symbol);
    where.push(`stock_code = $${params.length}`);
  }
  params.push(limit);
  const companies = await all<{ corp_code: string; stock_code: string; name: string }>(
    `SELECT corp_code, stock_code, name FROM companies
     WHERE ${where.join(" AND ")}
     ORDER BY market_cap DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
    db,
  );

  process.stdout.write(
    `[${nowIso()}] 미국주 월별 목표가 1년 백필 시작 — 대상 ${companies.length}개 (fmp=${fmpEnabled ? `on,budget=${fmpBudget}` : "off"})\n`,
  );

  let priceWrites = 0;
  let reportWrites = 0;
  let filled = 0;
  let errors = 0;
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    try {
      const closes = await fetchMonthlyCloses(c.stock_code);
      priceWrites += await upsertMonthlyPrices(db, c.corp_code, closes);

      if (fmpEnabled && fmpBudget > 0) {
        fmpBudget--;
        const hist = await fetchFmpTargetHistory(fmpKey, c.stock_code);
        if (hist === null) {
          fmpEnabled = false;
          process.stdout.write(`   fmp price-target-news 플랜 미포함 → 이후 목표가 이력 수집 생략\n`);
        } else if (hist.length > 0) {
          reportWrites += await insertFmpReports(db, c.corp_code, c.stock_code, hist);
        }
      }

      filled += await fillTargetMonthlyConsensus(db, c.corp_code);
      if ((i + 1) % 25 === 0) {
        process.stdout.write(
          `   [${i + 1}/${companies.length}] price+${priceWrites} reports+${reportWrites} tpFilled=${filled}\n`,
        );
      }
    } catch (e) {
      errors++;
      process.stdout.write(`   ${c.stock_code} ERROR ${(e as Error).message}\n`);
    }
    if (callDelayMs > 0) await sleep(callDelayMs);
  }

  process.stdout.write(
    `[${nowIso()}] 완료 — companies=${companies.length} priceWrites=${priceWrites} fmpReports=${reportWrites} tpMonthsFilled=${filled} errors=${errors}\n`,
  );
  await closeDb();
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
