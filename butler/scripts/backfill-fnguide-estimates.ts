/**
 * FnGuide 공개 컨센서스 추정치 백필.
 *
 * FnGuide Company Guide 컨센서스 메뉴가 사용하는 JSON에서 (E) 컬럼의
 * 매출액, 영업이익, 당기순이익, EPS를 financials.source='fnguide'로 저장한다.
 *
 *   tsx scripts/backfill-fnguide-estimates.ts
 *   tsx scripts/backfill-fnguide-estimates.ts --corp 00126380
 *   tsx scripts/backfill-fnguide-estimates.ts --stock 005930
 *   tsx scripts/backfill-fnguide-estimates.ts --limit 50
 */
import { all, closeDb, getDb, migrate, query, type Queryable } from "../src/lib/db";
import { sleep } from "../src/lib/butler";

type Metric = "REVENUE" | "OPERATING_PROFIT" | "NET_INCOME" | "EPS";
type PeriodType = "Q" | "A";

interface Company {
  corp_code: string;
  name: string;
  stock_code: string;
}

interface FnGuideEstimateRow {
  metric: Metric;
  label: string;
  fiscalYear: number;
  quarter: number;
  periodType: PeriodType;
  value: number;
  dateLabel: string;
}

export interface FnGuideEstimateOptions {
  corp?: string;
  stock?: string;
  limit?: number;
  log?: (message: string) => void;
}

export interface FnGuideEstimateSummary {
  targeted: number;
  ok: number;
  fail: number;
  writes: number;
}

interface FnGuideJsonRow {
  ACCOUNT_NM?: string;
  D_2?: string;
  D_3?: string;
  D_4?: string;
  D_5?: string;
  D_6?: string;
  D_7?: string;
}

interface FnGuideJson {
  comp?: FnGuideJsonRow[];
}

type DataKey = "D_2" | "D_3" | "D_4" | "D_5" | "D_6" | "D_7";
type ParsedPeriod = {
  fiscalYear: number;
  quarter: number;
  dateLabel: string;
  isEstimate: boolean;
};

const BASE_URL = "https://comp.fnguide.com/SVO2/json/data/01_06";
const UNIT = 100_000_000;
const HEADERS = {
  accept: "application/json,text/plain,*/*",
  "accept-language": "ko,en-US;q=0.8,en;q=0.7",
  referer: "https://comp.fnguide.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

const METRICS: Array<{ metric: Metric; label: string; names: string[]; unit: "amount" | "perShare" }> = [
  { metric: "REVENUE", label: "매출액", names: ["매출액"], unit: "amount" },
  { metric: "OPERATING_PROFIT", label: "영업이익", names: ["영업이익"], unit: "amount" },
  { metric: "NET_INCOME", label: "당기순이익", names: ["당기순이익"], unit: "amount" },
  { metric: "EPS", label: "EPS", names: ["EPS"], unit: "perShare" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

function cleanAccountName(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function parseNumber(raw: string | undefined): number | null {
  const text = (raw ?? "").replace(/,/g, "").trim();
  if (!text || text === "-") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parsePeriod(raw: string | undefined, periodType: PeriodType): ParsedPeriod | null {
  const m = (raw ?? "").match(/(20\d{2})\/(0[369]|12)(?:\(E\))?/);
  if (!m) return null;
  const fiscalYear = Number(m[1]);
  const month = Number(m[2]);
  return {
    fiscalYear,
    quarter: periodType === "A" ? 0 : month / 3,
    dateLabel: `${String(fiscalYear).slice(2)}.${String(month).padStart(2, "0")}`,
    isEstimate: (raw ?? "").includes("(E)"),
  };
}

async function fetchJson(url: string): Promise<FnGuideJson> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).replace(/^\uFEFF/, "");
      return JSON.parse(text) as FnGuideJson;
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

async function fetchFnGuideJson(stockCode: string, periodType: PeriodType, reportType: "D" | "B") {
  const path = `01_A${stockCode}_${periodType}_${reportType}.json`;
  return fetchJson(`${BASE_URL}/${path}`);
}

function parseRows(json: FnGuideJson, periodType: PeriodType): FnGuideEstimateRow[] {
  const rows = json.comp ?? [];
  const header = rows[0];
  if (!header) return [];

  const cols = (["D_2", "D_3", "D_4", "D_5", "D_6", "D_7"] as const)
    .map((key) => ({ key, period: parsePeriod(header[key], periodType) }))
    .filter((c): c is { key: DataKey; period: ParsedPeriod } => !!c.period && c.period.isEstimate);

  const out: FnGuideEstimateRow[] = [];
  for (const row of rows.slice(1)) {
    const name = cleanAccountName(row.ACCOUNT_NM);
    const metric = METRICS.find((m) => m.names.includes(name));
    if (!metric) continue;

    for (const col of cols) {
      const value = parseNumber(row[col.key]);
      if (value == null) continue;
      out.push({
        metric: metric.metric,
        label: metric.label,
        fiscalYear: col.period.fiscalYear,
        quarter: col.period.quarter,
        periodType,
        value: metric.unit === "amount" ? Math.round(value * UNIT) : value,
        dateLabel: col.period.dateLabel,
      });
    }
  }
  return out;
}

export async function fetchFnGuideEstimates(stockCode: string): Promise<FnGuideEstimateRow[]> {
  const fetchPeriod = async (periodType: PeriodType) => {
    const consolidated = parseRows(await fetchFnGuideJson(stockCode, periodType, "D"), periodType);
    if (consolidated.length > 0) return consolidated;
    return parseRows(await fetchFnGuideJson(stockCode, periodType, "B"), periodType);
  };

  const rows = [...(await fetchPeriod("A")), ...(await fetchPeriod("Q"))];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.metric}:${row.periodType}:${row.fiscalYear}:${row.quarter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function upsertEstimate(db: Queryable, corpCode: string, row: FnGuideEstimateRow) {
  await query(
    `INSERT INTO financials
       (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, 'fnguide')
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate, source)
     DO UPDATE SET value=excluded.value,
                   date_label=excluded.date_label,
                   raw_label=excluded.raw_label`,
    [corpCode, row.metric, row.label, row.fiscalYear, row.quarter, row.periodType, row.value, row.dateLabel],
    db,
  );
}

export async function backfillFnGuideEstimates(
  db: Queryable,
  options: FnGuideEstimateOptions = {},
): Promise<FnGuideEstimateSummary> {
  const log = options.log ?? ((message: string) => process.stdout.write(message));
  const where = [
    "c.has_consensus = 1",
    "c.stock_code IS NOT NULL",
    "c.stock_code ~ '^[0-9]{6}$'",
    "c.source <> 'nasdaq'",
  ];
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
    `FnGuide 추정치 백필 대상 ${companies.length}개${
      options.corp ? ` (corp=${options.corp})` : options.stock ? ` (stock=${options.stock})` : ""
    }\n`,
  );

  let ok = 0;
  let fail = 0;
  let writes = 0;
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    try {
      const rows = await fetchFnGuideEstimates(c.stock_code);
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
  await backfillFnGuideEstimates(db, { corp, stock, limit });
}

if (process.argv[1]?.endsWith("backfill-fnguide-estimates.ts"))
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
