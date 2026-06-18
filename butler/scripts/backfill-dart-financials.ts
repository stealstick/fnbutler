/**
 * DART 2024 재무 백필.
 *
 * butler 공개 summary API 에서 2024 일부 구간이 마스킹되는 종목을 위해
 * DART 정기보고서 손익계산서(CIS/IS)에서 매출액, 영업이익, 당기순이익을 보강한다.
 *
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
  q_rows: number;
  a_rows: number;
}

interface DartRow {
  sj_div?: string;
  account_id?: string;
  account_nm?: string;
  thstrm_amount?: string;
  thstrm_q_amount?: string;
}

interface PickedValue {
  value: number;
  cumulative: boolean;
}

const REPORTS = [
  { code: "11013", quarter: 1 },
  { code: "11012", quarter: 2 },
  { code: "11014", quarter: 3 },
] as const;

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
  if (qAmount != null) return { value: qAmount, cumulative: false };
  const amount = num(row.thstrm_amount);
  return amount == null ? null : { value: amount, cumulative: preferQuarter };
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
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate)
     DO UPDATE SET value=excluded.value,
                   date_label=excluded.date_label,
                   raw_label=excluded.raw_label,
                   source='dart'`,
    [corpCode, metric, label, year, quarter, periodType, value, dateLabel],
    db,
  );
}

async function backfillCompany(db: Queryable, key: string, c: Company, year: number): Promise<number> {
  const byMetric = new Map<Metric, Map<number, PickedValue>>();
  for (const m of METRICS) byMetric.set(m.metric, new Map());

  for (const r of REPORTS) {
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

  const annualRows = await fetchDart(key, c.corp_code, year, "11011", c.fs_div ?? "CFS");
  const annual = new Map<Metric, number>();
  if (annualRows) {
    for (const m of METRICS) {
      const value = pick(annualRows, m, false);
      if (value != null) annual.set(m.metric, value.value);
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
  const q1 = raw.get(1);
  if (q1) {
    values.set(1, q1.value);
    cumulative.set(1, q1.value);
  }

  for (const q of [2, 3] as const) {
    const picked = raw.get(q);
    if (!picked) continue;
    if (picked.cumulative) {
      const prev = cumulative.get(q - 1);
      if (prev == null) continue;
      values.set(q, picked.value - prev);
      cumulative.set(q, picked.value);
    } else {
      values.set(q, picked.value);
      const prev = cumulative.get(q - 1);
      if (prev != null) cumulative.set(q, prev + picked.value);
    }
  }

  return { values, cumulativeQ3: cumulative.get(3) ?? null };
}

async function main() {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY 필요");

  const year = Number(arg("year") || "2024");
  const limit = Number(arg("limit") || "0");
  const corp = arg("corp");
  const includeFilled = process.argv.includes("--all");

  const db = getDb();
  await migrate(db);

  const where = ["c.has_consensus = 1"];
  const params: Array<string | number> = [year];
  if (corp) {
    params.push(corp);
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
      ${includeFilled ? "" : "HAVING COUNT(f.*) FILTER (WHERE f.period_type = 'Q') < 12 OR COUNT(f.*) FILTER (WHERE f.period_type = 'A') < 3"}
      ORDER BY c.market_cap DESC NULLS LAST
      ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ""}`,
    params,
    db,
  );

  process.stdout.write(
    `DART ${year} 재무 백필 대상 ${companies.length}개${corp ? ` (corp=${corp})` : ""}${includeFilled ? " (--all)" : " (missing-only)"}\n`,
  );

  let ok = 0;
  let fail = 0;
  let writes = 0;
  let i = 0;
  for (const c of companies) {
    i++;
    try {
      const n = await backfillCompany(db, key, c, year);
      writes += n;
      ok++;
      if (i <= 20 || i % 50 === 0) {
        process.stdout.write(`  [${i}/${companies.length}] ${c.name}(${c.stock_code ?? c.corp_code}) rows=${n}\n`);
      }
    } catch (e) {
      fail++;
      process.stdout.write(`  [${i}/${companies.length}] ${c.name}(${c.stock_code ?? c.corp_code}) ERROR ${(e as Error).message}\n`);
    }
  }

  process.stdout.write(`완료 — ok=${ok} fail=${fail} writes=${writes}\n`);
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
