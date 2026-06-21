/**
 * DART 정기보고서 재무 백필.
 *
 * butler 공개 summary API 에서 일부 구간이 마스킹되는 종목을 위해
 * DART 정기보고서 손익계산서(CIS/IS)에서 매출액, 영업이익, 당기순이익을 보강한다.
 *
 *   DART_API_KEY=... tsx scripts/backfill-dart-financials.ts --latest
 *   DART_API_KEY=... tsx scripts/backfill-dart-financials.ts --years 2025,2026
 *   DART_API_KEY=... tsx scripts/backfill-dart-financials.ts --year 2024
 *   DART_API_KEY=... tsx scripts/backfill-dart-financials.ts --corp 00164779
 *   DART_API_KEY=... tsx scripts/backfill-dart-financials.ts --limit 50
 */
import { all, closeDb, getDb, migrate, query, type Queryable } from "../src/lib/db";
import { sleep } from "../src/lib/butler";

type Metric = "REVENUE" | "OPERATING_PROFIT" | "NET_INCOME";

interface Company {
  corp_code: string;
  name: string;
  stock_code: string | null;
  fs_div: string | null;
}

interface DartRow {
  sj_div?: string;
  account_id?: string;
  account_nm?: string;
  thstrm_amount?: string;
  thstrm_q_amount?: string;
  thstrm_add_amount?: string;
}

interface PickedValue {
  value: number;
  cumulativeToDate: number | null;
}

export interface DartFinancialBackfillOptions {
  year: number;
  corp?: string;
  limit?: number;
  includeFilled?: boolean;
  now?: Date;
  log?: (message: string) => void;
}

export interface DartFinancialBackfillSummary {
  year: number;
  expectedQRows: number;
  expectedARows: number;
  targeted: number;
  ok: number;
  fail: number;
  writes: number;
}

const REPORTS = [
  { code: "11013", quarter: 1 },
  { code: "11012", quarter: 2 },
  { code: "11014", quarter: 3 },
] as const;

type ExpectedReport = (typeof REPORTS)[number];

interface ExpectedCoverage {
  reports: ExpectedReport[];
  annual: boolean;
  qRows: number;
  aRows: number;
}

const METRICS: Array<{
  metric: Metric;
  label: string;
  ids: string[];
  names: RegExp[];
}> = [
  {
    metric: "REVENUE",
    label: "매출액",
    ids: ["ifrs-full_Revenue", "ifrs_Revenue"],
    names: [/^매출액$/, /^영업수익$/, /^수익\(매출액\)$/],
  },
  {
    metric: "OPERATING_PROFIT",
    label: "영업이익",
    ids: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"],
    names: [/^영업이익/, /^영업손익/],
  },
  {
    metric: "NET_INCOME",
    label: "당기순이익",
    ids: ["ifrs-full_ProfitLoss", "ifrs_ProfitLoss"],
    names: [/^(분기|반기|당기)?순이익/, /^당기순손익/],
  },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

function currentYear(now = new Date()): number {
  return now.getUTCFullYear();
}

function expectedCoverage(year: number, now = new Date()): ExpectedCoverage {
  const reached = (month: number, day: number, y = year) => now.getTime() >= Date.UTC(y, month - 1, day);
  const expectedQuarter = reached(11, 14) ? 3 : reached(8, 14) ? 2 : reached(5, 15) ? 1 : 0;
  const annual = reached(3, 31, year + 1);
  const reports = REPORTS.filter((r) => r.quarter <= expectedQuarter);
  return {
    reports,
    annual,
    qRows: reports.length * METRICS.length + (annual ? METRICS.length : 0),
    aRows: annual ? METRICS.length : 0,
  };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pick(rows: DartRow[], metric: (typeof METRICS)[number], preferQuarter: boolean): PickedValue | null {
  const incomeRows = rows.filter((r) => r.sj_div === "CIS" || r.sj_div === "IS");
  const byId = incomeRows.find((r) => r.account_id && metric.ids.includes(r.account_id));
  const byName = incomeRows.find((r) => {
    const name = String(r.account_nm ?? "").replace(/\s+/g, "");
    return metric.names.some((re) => re.test(name));
  });
  const row = byId ?? byName;
  if (!row) return null;
  const qAmount = preferQuarter ? num(row.thstrm_q_amount) : null;
  const addAmount = preferQuarter ? num(row.thstrm_add_amount) : null;
  if (qAmount != null) return { value: qAmount, cumulativeToDate: addAmount };
  const amount = num(row.thstrm_amount);
  return amount == null ? null : { value: amount, cumulativeToDate: addAmount };
}

async function fetchDart(
  key: string,
  corpCode: string,
  year: number,
  reportCode: string,
  fsDiv: string,
): Promise<DartRow[] | null> {
  const sp = new URLSearchParams({
    crtfc_key: key,
    corp_code: corpCode,
    bsns_year: String(year),
    reprt_code: reportCode,
    fs_div: fsDiv === "OFS" ? "OFS" : "CFS",
  });
  const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?${sp.toString()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.status === "000") return (j.list ?? []) as DartRow[];
      if (j.status === "013") return null;
      throw new Error(`DART status=${j.status} ${j.message ?? ""}`);
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

async function upsertFinancial(
  db: Queryable,
  corpCode: string,
  metric: Metric,
  label: string,
  year: number,
  quarter: number,
  periodType: "Q" | "A",
  value: number,
) {
  const dateLabel = periodType === "A" ? `${String(year).slice(2)}.12` : `${String(year).slice(2)}.${String(quarter * 3).padStart(2, "0")}`;
  await query(
    `INSERT INTO financials
       (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'dart')
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate, source)
     DO UPDATE SET value=excluded.value,
                   date_label=excluded.date_label,
                   raw_label=excluded.raw_label,
                   source='dart'`,
    [corpCode, metric, label, year, quarter, periodType, value, dateLabel],
    db,
  );
}

async function backfillCompany(
  db: Queryable,
  key: string,
  c: Company,
  year: number,
  coverage: ExpectedCoverage,
): Promise<number> {
  const byMetric = new Map<Metric, Map<number, PickedValue>>();
  for (const m of METRICS) byMetric.set(m.metric, new Map());

  for (const r of coverage.reports) {
    const rows = await fetchDart(key, c.corp_code, year, r.code, c.fs_div ?? "CFS");
    if (!rows) {
      await sleep(120);
      continue;
    }
    for (const m of METRICS) {
      const picked = pick(rows, m, true);
      if (picked != null) byMetric.get(m.metric)!.set(r.quarter, picked);
    }
    await sleep(120);
  }

  const annual = new Map<Metric, number>();
  if (coverage.annual) {
    const annualRows = await fetchDart(key, c.corp_code, year, "11011", c.fs_div ?? "CFS");
    if (!annualRows) await sleep(120);
    else {
      for (const m of METRICS) {
        const value = pick(annualRows, m, false);
        if (value != null) annual.set(m.metric, value.value);
      }
    }
  }

  let writes = 0;
  for (const m of METRICS) {
    const quarters = toQuarterValues(byMetric.get(m.metric)!);
    for (const [q, value] of quarters.values) {
      await upsertFinancial(db, c.corp_code, m.metric, m.label, year, q, "Q", value);
      writes++;
    }
    const annualValue = annual.get(m.metric);
    if (annualValue != null) {
      await upsertFinancial(db, c.corp_code, m.metric, m.label, year, 0, "A", annualValue);
      writes++;
      if (quarters.cumulativeQ3 != null) {
        await upsertFinancial(db, c.corp_code, m.metric, m.label, year, 4, "Q", annualValue - quarters.cumulativeQ3);
        writes++;
      }
    }
  }
  return writes;
}

function toQuarterValues(raw: Map<number, PickedValue>): { values: Map<number, number>; cumulativeQ3: number | null } {
  const values = new Map<number, number>();
  const cumulative = new Map<number, number>();

  for (const q of [1, 2, 3] as const) {
    const picked = raw.get(q);
    if (!picked) continue;
    values.set(q, picked.value);
    const prev = q === 1 ? 0 : cumulative.get(q - 1);
    const inferredCumulative = prev == null ? null : prev + picked.value;
    const cumulativeToDate = picked.cumulativeToDate ?? inferredCumulative;
    if (cumulativeToDate != null) cumulative.set(q, cumulativeToDate);
  }

  return { values, cumulativeQ3: cumulative.get(3) ?? null };
}

export async function backfillDartFinancials(
  db: Queryable,
  key: string,
  options: DartFinancialBackfillOptions,
): Promise<DartFinancialBackfillSummary> {
  const year = options.year;
  const coverage = expectedCoverage(year, options.now);
  const log = options.log ?? ((message: string) => process.stdout.write(message));
  if (coverage.qRows === 0 && coverage.aRows === 0) {
    log(`DART ${year} 재무 백필 대상 0개 (아직 정기보고서 기한 전)\n`);
    return { year, expectedQRows: 0, expectedARows: 0, targeted: 0, ok: 0, fail: 0, writes: 0 };
  }

  const where = ["c.has_consensus = 1"];
  const params: Array<string | number> = [year, coverage.qRows, coverage.aRows];
  if (options.corp) {
    params.push(options.corp);
    where.push(`c.corp_code = $${params.length}`);
  }

  const companies = await all<Company>(
    `SELECT c.corp_code, c.name, c.stock_code, c.fs_div,
            COUNT(f.*) FILTER (WHERE f.period_type = 'Q')::int AS q_rows,
            COUNT(f.*) FILTER (WHERE f.period_type = 'A')::int AS a_rows
       FROM companies c
       LEFT JOIN financials f
         ON f.corp_code = c.corp_code
        AND f.fiscal_year = $1
        AND f.is_estimate = 0
      WHERE ${where.join(" AND ")}
      GROUP BY c.corp_code, c.name, c.stock_code, c.fs_div, c.market_cap
      ${
        options.includeFilled
          ? ""
          : "HAVING COUNT(f.*) FILTER (WHERE f.period_type = 'Q') < $2 OR COUNT(f.*) FILTER (WHERE f.period_type = 'A') < $3"
      }
      ORDER BY c.market_cap DESC NULLS LAST
      ${options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : ""}`,
    params,
    db,
  );

  log(
    `DART ${year} 재무 백필 대상 ${companies.length}개${options.corp ? ` (corp=${options.corp})` : ""}${
      options.includeFilled ? " (--all)" : " (missing-only)"
    } · 기대 Q=${coverage.qRows} A=${coverage.aRows}\n`,
  );

  let ok = 0;
  let fail = 0;
  let writes = 0;
  let i = 0;
  for (const c of companies) {
    i++;
    try {
      const n = await backfillCompany(db, key, c, year, coverage);
      writes += n;
      ok++;
      if (i <= 20 || i % 50 === 0) {
        log(`  [${i}/${companies.length}] ${c.name}(${c.stock_code ?? c.corp_code}) rows=${n}\n`);
      }
    } catch (e) {
      fail++;
      log(`  [${i}/${companies.length}] ${c.name}(${c.stock_code ?? c.corp_code}) ERROR ${(e as Error).message}\n`);
    }
  }

  log(`완료 — year=${year} ok=${ok} fail=${fail} writes=${writes}\n`);
  return { year, expectedQRows: coverage.qRows, expectedARows: coverage.aRows, targeted: companies.length, ok, fail, writes };
}

function yearsFromArgs(now = new Date()): number[] {
  const years = arg("years");
  if (years) return [...new Set(years.split(",").map((y) => Number(y.trim())).filter((y) => Number.isInteger(y) && y > 1900))];
  if (process.argv.includes("--latest")) {
    const y = currentYear(now);
    return [y, y - 1];
  }
  return [Number(arg("year") || "2024")];
}

async function main() {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY 필요");

  const limit = Number(arg("limit") || "0");
  const corp = arg("corp");
  const includeFilled = process.argv.includes("--all");
  const years = yearsFromArgs();

  const db = getDb();
  await migrate(db);
  for (const year of years) {
    await backfillDartFinancials(db, key, {
      year,
      corp,
      limit,
      includeFilled,
    });
  }
}

if (process.argv[1]?.endsWith("backfill-dart-financials.ts")) main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
