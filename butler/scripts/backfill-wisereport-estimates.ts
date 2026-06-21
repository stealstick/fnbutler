/**
 * WiseReport/FnGuide 공개 재무요약 추정치 백필.
 *
 * 네이버 금융 기업분석 iframe 이 호출하는 WiseReport Financial Summary 표에서
 * (E) 컬럼의 매출액, 영업이익, 당기순이익 컨센서스를 financials.is_estimate=1 로 저장한다.
 *
 *   tsx scripts/backfill-wisereport-estimates.ts
 *   tsx scripts/backfill-wisereport-estimates.ts --corp 00126380
 *   tsx scripts/backfill-wisereport-estimates.ts --stock 005930
 *   tsx scripts/backfill-wisereport-estimates.ts --limit 50
 */
import { all, closeDb, getDb, migrate, query, type Queryable } from "../src/lib/db";
import { sleep } from "../src/lib/butler";

type Metric = "REVENUE" | "OPERATING_PROFIT" | "NET_INCOME";
type PeriodType = "Q" | "A";

interface Company {
  corp_code: string;
  name: string;
  stock_code: string;
}

interface WiseEstimateRow {
  metric: Metric;
  label: string;
  fiscalYear: number;
  quarter: number;
  periodType: PeriodType;
  value: number;
  dateLabel: string;
}

export interface WiseReportEstimateOptions {
  corp?: string;
  stock?: string;
  limit?: number;
  log?: (message: string) => void;
}

export interface WiseReportEstimateSummary {
  targeted: number;
  ok: number;
  fail: number;
  writes: number;
}

const WISE_BASE = "https://navercomp.wisereport.co.kr/v2/company";
const UNIT = 100_000_000;
const HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "ko,en-US;q=0.8,en;q=0.7",
  referer: "https://finance.naver.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

const METRICS: Array<{ metric: Metric; label: string; names: string[] }> = [
  { metric: "REVENUE", label: "매출액", names: ["매출액"] },
  { metric: "OPERATING_PROFIT", label: "영업이익", names: ["영업이익", "영업이익(발표기준)"] },
  { metric: "NET_INCOME", label: "당기순이익", names: ["당기순이익"] },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function extractAttr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1];
}

async function fetchText(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

async function fetchWiseTable(stockCode: string, freq: "Y" | "Q"): Promise<string> {
  const mainUrl = `${WISE_BASE}/c1010001.aspx?cmp_cd=${stockCode}&target=finsum_more`;
  const main = await fetchText(mainUrl);
  const encparam = main.match(/encparam:\s*'([^']+)'/)?.[1];
  const id = main.match(/id:\s*'([^']+)'/)?.[1];
  if (!encparam || !id) throw new Error("WiseReport encparam/id 추출 실패");

  const sp = new URLSearchParams({
    cmp_cd: stockCode,
    fin_typ: "0",
    freq_typ: freq,
    extY: "1",
    extQ: "1",
    encparam,
    id,
  });
  return fetchText(`${WISE_BASE}/ajax/cF1001.aspx?${sp.toString()}`);
}

function mainFinancialTable(html: string): string | null {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  return tables.find((table) => /주요재무정보/.test(table) && /매출액/.test(table) && /bgE/.test(table)) ?? null;
}

function parseHeader(table: string, periodType: PeriodType): Array<{ fiscalYear: number; quarter: number; dateLabel: string; isEstimate: boolean }> {
  const head = table.match(/<thead[\s\S]*?<\/thead>/i)?.[0] ?? "";
  const ths = [...head.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/gi)].map((m) => m[0]);
  const out: Array<{ fiscalYear: number; quarter: number; dateLabel: string; isEstimate: boolean }> = [];
  for (const th of ths) {
    const text = stripTags(th);
    const m = text.match(/(20\d{2})\/(0[369]|12)(?:\(E\))?/);
    if (!m) continue;
    const fiscalYear = Number(m[1]);
    const month = Number(m[2]);
    const quarter = periodType === "A" ? 0 : month / 3;
    out.push({
      fiscalYear,
      quarter,
      dateLabel: `${String(fiscalYear).slice(2)}.${String(month).padStart(2, "0")}`,
      isEstimate: text.includes("(E)") || /bgE/.test(th),
    });
  }
  return out;
}

function parseMetricRows(table: string, periodType: PeriodType): WiseEstimateRow[] {
  const headers = parseHeader(table, periodType);
  const tbodyStart = table.search(/<tbody\b/i);
  const tbody = tbodyStart >= 0 ? table.slice(tbodyStart) : table;
  const trs = [...tbody.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const rows: WiseEstimateRow[] = [];

  for (const tr of trs) {
    const th = tr.match(/<th\b[^>]*>[\s\S]*?<\/th>/i)?.[0];
    if (!th) continue;
    const label = stripTags(th).replace(/\s+/g, "");
    const metric = METRICS.find((m) => m.names.includes(label));
    if (!metric) continue;

    const tds = [...tr.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/gi)].map((m) => m[0]);
    for (let i = 0; i < Math.min(headers.length, tds.length); i++) {
      const header = headers[i];
      const td = tds[i];
      const isEstimate = header.isEstimate || /class=["'][^"']*bgE/i.test(td);
      if (!isEstimate) continue;
      const amount = parseAmount(extractAttr(td, "title"));
      if (amount == null) continue;
      rows.push({
        metric: metric.metric,
        label: metric.label,
        fiscalYear: header.fiscalYear,
        quarter: header.quarter,
        periodType,
        value: Math.round(amount * UNIT),
        dateLabel: header.dateLabel,
      });
    }
  }

  return rows;
}

export async function fetchWiseReportEstimates(stockCode: string): Promise<WiseEstimateRow[]> {
  const [annualHtml, quarterlyHtml] = await Promise.all([fetchWiseTable(stockCode, "Y"), fetchWiseTable(stockCode, "Q")]);
  const annual = mainFinancialTable(annualHtml);
  const quarterly = mainFinancialTable(quarterlyHtml);
  if (!annual && !quarterly) throw new Error("WiseReport 주요재무정보 표 없음");
  const rows = [
    ...(annual ? parseMetricRows(annual, "A") : []),
    ...(quarterly ? parseMetricRows(quarterly, "Q") : []),
  ];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.metric}:${row.periodType}:${row.fiscalYear}:${row.quarter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function upsertEstimate(db: Queryable, corpCode: string, row: WiseEstimateRow) {
  await query(
    `INSERT INTO financials
       (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, 'wisereport')
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate, source)
     DO UPDATE SET value=excluded.value,
                   date_label=excluded.date_label,
                   raw_label=excluded.raw_label,
                   source='wisereport'`,
    [corpCode, row.metric, row.label, row.fiscalYear, row.quarter, row.periodType, row.value, row.dateLabel],
    db,
  );
}

export async function backfillWiseReportEstimates(
  db: Queryable,
  options: WiseReportEstimateOptions = {},
): Promise<WiseReportEstimateSummary> {
  const log = options.log ?? ((message: string) => process.stdout.write(message));
  const where = ["c.has_consensus = 1", "c.stock_code IS NOT NULL", "c.stock_code <> ''"];
  const params: Array<string | number> = [];
  if (options.corp) {
    params.push(options.corp);
    where.push(`c.corp_code = $${params.length}`);
  }
  if (options.stock) {
    params.push(options.stock);
    where.push(`c.stock_code = $${params.length}`);
  }

  const limitSql = options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : "";
  const companies = await all<Company>(
    `SELECT c.corp_code, c.name, c.stock_code
       FROM companies c
      WHERE ${where.join(" AND ")}
      ORDER BY c.market_cap DESC NULLS LAST
      ${limitSql}`,
    params,
    db,
  );

  log(
    `WiseReport 추정치 백필 대상 ${companies.length}개${
      options.corp ? ` (corp=${options.corp})` : options.stock ? ` (stock=${options.stock})` : ""
    }\n`,
  );

  let ok = 0;
  let fail = 0;
  let writes = 0;
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    try {
      const rows = await fetchWiseReportEstimates(c.stock_code);
      for (const row of rows) await upsertEstimate(db, c.corp_code, row);
      ok++;
      writes += rows.length;
      if (i < 20 || (i + 1) % 50 === 0) {
        log(`  [${i + 1}/${companies.length}] ${c.name}(${c.stock_code}) rows=${rows.length}\n`);
      }
    } catch (e) {
      fail++;
      log(`  [${i + 1}/${companies.length}] ${c.name}(${c.stock_code}) ERROR ${(e as Error).message}\n`);
    }
    await sleep(150);
  }

  log(`완료 — ok=${ok} fail=${fail} writes=${writes}\n`);
  return { targeted: companies.length, ok, fail, writes };
}

async function main() {
  const limit = Number(arg("limit") || "0");
  const corp = arg("corp");
  const stock = arg("stock");
  const db = getDb();
  await migrate(db);
  await backfillWiseReportEstimates(db, { corp, stock, limit });
}

if (process.argv[1]?.endsWith("backfill-wisereport-estimates.ts"))
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
