import { all, nowIso, query, tx, type Queryable } from "./db";
import { fetchUsdKrwRate } from "./nasdaq";

const FMP_BASE = "https://financialmodelingprep.com/stable";
const DEFAULT_CALL_BUDGET = 240;
const DEFAULT_ESTIMATE_LIMIT = 10;
const ESTIMATE_SOURCE = "fmp:analyst-estimates";
const TARGET_SOURCE = "fmp:price-target";

type NasdaqCandidate = {
  corp_code: string;
  stock_code: string;
  price: number | null;
};

type FmpAnnualEstimate = {
  symbol?: string;
  date?: string;
  revenueAvg?: number | string | null;
  ebitAvg?: number | string | null;
  netIncomeAvg?: number | string | null;
  epsAvg?: number | string | null;
  numAnalystsRevenue?: number | string | null;
  numAnalystsEps?: number | string | null;
};

type FmpTargetConsensus = {
  symbol?: string;
  targetConsensus?: number | string | null;
  targetMedian?: number | string | null;
};

export interface FmpNasdaqBackfillOptions {
  apiKey: string;
  estimateCalls?: number;
  targetCalls?: number;
  estimateLimit?: number;
  corpCode?: string;
  symbol?: string;
  currentYear?: number;
  log?: (message: string) => void;
}

export interface FmpNasdaqBackfillSummary {
  estimateTargeted: number;
  estimateOk: number;
  estimateFail: number;
  targetTargeted: number;
  targetOk: number;
  targetFail: number;
  writes: number;
  estimateCalls: number;
  targetCalls: number;
  usdKrw: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toNum(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fiscalYear(row: FmpAnnualEstimate): number | null {
  const y = Number(String(row.date ?? "").slice(0, 4));
  return Number.isInteger(y) && y > 1900 ? y : null;
}

function analystCount(row: FmpAnnualEstimate): number | null {
  const n = Math.max(toNum(row.numAnalystsRevenue) ?? 0, toNum(row.numAnalystsEps) ?? 0);
  return n > 0 ? Math.round(n) : null;
}

async function fetchFmpJson<T>(path: string, apiKey: string, params: Record<string, string | number>): Promise<T> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, String(v));
  sp.set("apikey", apiKey);
  const url = `${FMP_BASE}${path}?${sp}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    const msg = text.trim().replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`FMP HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`FMP non-JSON response: ${text.slice(0, 120)}`);
  }
}

async function candidates(
  db: Queryable,
  limit: number,
  kind: "estimates" | "targets",
  options: Pick<FmpNasdaqBackfillOptions, "corpCode" | "symbol">,
): Promise<NasdaqCandidate[]> {
  const where = ["active = 1", "market = 'NASDAQ'", "source = 'nasdaq'"];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (options.corpCode) where.push(`corp_code = ${push(options.corpCode)}`);
  if (options.symbol) where.push(`stock_code = ${push(options.symbol.toUpperCase())}`);
  const col = kind === "estimates" ? "fmp_estimates_at" : "fmp_targets_at";
  params.push(limit);
  return all<NasdaqCandidate>(
    `SELECT corp_code, stock_code, price
     FROM companies
     WHERE ${where.join(" AND ")}
     ORDER BY ${col} ASC NULLS FIRST, market_cap DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
    db,
  );
}

async function upsertEstimateRows(
  db: Queryable,
  corpCode: string,
  symbol: string,
  rows: FmpAnnualEstimate[],
  usdKrw: number,
  currentYear: number,
): Promise<number> {
  const now = nowIso();
  let writes = 0;
  const sorted = rows
    .map((row) => ({ row, year: fiscalYear(row) }))
    .filter((x): x is { row: FmpAnnualEstimate; year: number } => x.year != null)
    .sort((a, b) => a.year - b.year);

  for (const { row, year } of sorted) {
    const values: Array<{ metric: string; rawLabel: string; value: number | null }> = [
      { metric: "REVENUE", rawLabel: "FMP Revenue Avg", value: toNum(row.revenueAvg) },
      { metric: "OPERATING_PROFIT", rawLabel: "FMP EBIT Avg", value: toNum(row.ebitAvg) },
      { metric: "NET_INCOME", rawLabel: "FMP Net Income Avg", value: toNum(row.netIncomeAvg) },
      { metric: "EPS", rawLabel: "FMP EPS Avg", value: toNum(row.epsAvg) },
    ];
    for (const v of values) {
      if (v.value == null) continue;
      const storedValue = v.metric === "EPS" ? v.value : Math.round(v.value * usdKrw);
      await query(
        `INSERT INTO financials
           (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
         VALUES ($1, $2, $3, $4, 0, 'A', $5, 1, $6, $7)
         ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate)
         DO UPDATE SET value = excluded.value, raw_label = excluded.raw_label,
                       date_label = excluded.date_label, source = excluded.source`,
        [corpCode, v.metric, v.rawLabel, year, storedValue, row.date ?? String(year), ESTIMATE_SOURCE],
        db,
      );
      writes++;
    }
  }

  const epsRows = sorted
    .map(({ row, year }) => ({ year, eps: toNum(row.epsAvg), analysts: analystCount(row) }))
    .filter((r): r is { year: number; eps: number; analysts: number | null } => r.eps != null);
  const current = epsRows.find((r) => r.year >= currentYear) ?? epsRows[epsRows.length - 2];
  const next = current ? epsRows.find((r) => r.year > current.year) : undefined;
  const cover = Math.max(0, ...epsRows.map((r) => r.analysts ?? 0)) || null;

  await query(
    `UPDATE companies SET
       eps = COALESCE($1, eps),
       feps = COALESCE($2, feps),
       has_consensus = CASE WHEN $3::integer IS NULL THEN has_consensus ELSE 1 END,
       cover_securities = GREATEST(COALESCE(cover_securities, 0), COALESCE($3::integer, 0)),
       fmp_estimates_at = $4,
       updated_at = $4
     WHERE corp_code = $5`,
    [current?.eps ?? null, next?.eps ?? null, cover, now, corpCode],
    db,
  );
  writes++;

  if (sorted.length === 0) {
    await query("UPDATE companies SET fmp_estimates_at = $1, updated_at = $1 WHERE corp_code = $2", [now, corpCode], db);
  }

  return writes;
}

async function refreshAnnualEstimates(
  db: Queryable,
  c: NasdaqCandidate,
  apiKey: string,
  usdKrw: number,
  estimateLimit: number,
  currentYear: number,
): Promise<number> {
  const rows = await fetchFmpJson<FmpAnnualEstimate[]>("/analyst-estimates", apiKey, {
    symbol: c.stock_code,
    period: "annual",
    page: 0,
    limit: estimateLimit,
  });
  if (!Array.isArray(rows)) throw new Error(`unexpected analyst-estimates payload for ${c.stock_code}`);
  return tx((client) => upsertEstimateRows(client, c.corp_code, c.stock_code, rows, usdKrw, currentYear));
}

async function refreshTargetConsensus(db: Queryable, c: NasdaqCandidate, apiKey: string): Promise<number> {
  const rows = await fetchFmpJson<FmpTargetConsensus[]>("/price-target-consensus", apiKey, { symbol: c.stock_code });
  if (!Array.isArray(rows)) throw new Error(`unexpected price-target payload for ${c.stock_code}`);
  const target = toNum(rows[0]?.targetConsensus) ?? toNum(rows[0]?.targetMedian);
  const now = nowIso();
  const ret = target != null && c.price != null && c.price !== 0 ? ((target - c.price) / Math.abs(c.price)) * 100 : null;
  await query(
    `UPDATE companies SET
       target_price_avg = $1,
       target_return_rate = $2,
       has_consensus = CASE WHEN $1::double precision IS NULL THEN has_consensus ELSE 1 END,
       fmp_targets_at = $3,
       updated_at = $3
     WHERE corp_code = $4`,
    [target, ret, now, c.corp_code],
    db,
  );
  if (target != null) {
    const month = now.slice(0, 7);
    await query(
      `INSERT INTO target_price_monthly
         (corp_code, month, full_date, tp_avg, price, return_ratio, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(corp_code, month)
       DO UPDATE SET full_date = excluded.full_date, tp_avg = excluded.tp_avg,
                     price = excluded.price, return_ratio = excluded.return_ratio, source = excluded.source`,
      [c.corp_code, month, now.slice(0, 10), target, c.price, ret, TARGET_SOURCE],
      db,
    );
  }
  return target == null ? 1 : 2;
}

export async function backfillFmpNasdaqEstimates(
  db: Queryable,
  options: FmpNasdaqBackfillOptions,
): Promise<FmpNasdaqBackfillSummary> {
  const log = options.log ?? (() => {});
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("FMP_API_KEY is required");

  const estimateCalls = Math.max(0, Math.floor(options.estimateCalls ?? DEFAULT_CALL_BUDGET));
  const targetCalls = Math.max(0, Math.floor(options.targetCalls ?? 0));
  const estimateLimit = Math.max(1, Math.floor(options.estimateLimit ?? DEFAULT_ESTIMATE_LIMIT));
  const currentYear = options.currentYear ?? new Date().getFullYear();
  const usdKrw = await fetchUsdKrwRate();

  let estimateOk = 0;
  let estimateFail = 0;
  let targetOk = 0;
  let targetFail = 0;
  let writes = 0;
  let usedEstimateCalls = 0;
  let usedTargetCalls = 0;

  const estimateTargets = await candidates(db, estimateCalls, "estimates", options);
  for (let i = 0; i < estimateTargets.length; i++) {
    const c = estimateTargets[i];
    try {
      writes += await refreshAnnualEstimates(db, c, apiKey, usdKrw, estimateLimit, currentYear);
      estimateOk++;
      log(`  estimates [${i + 1}/${estimateTargets.length}] ${c.stock_code} ok\n`);
    } catch (e) {
      estimateFail++;
      log(`  estimates [${i + 1}/${estimateTargets.length}] ${c.stock_code} ERROR ${(e as Error).message}\n`);
    } finally {
      usedEstimateCalls++;
      await sleep(120);
    }
  }

  const targetTargets = targetCalls > 0 ? await candidates(db, targetCalls, "targets", options) : [];
  for (let i = 0; i < targetTargets.length; i++) {
    const c = targetTargets[i];
    try {
      writes += await refreshTargetConsensus(db, c, apiKey);
      targetOk++;
      log(`  targets [${i + 1}/${targetTargets.length}] ${c.stock_code} ok\n`);
    } catch (e) {
      targetFail++;
      log(`  targets [${i + 1}/${targetTargets.length}] ${c.stock_code} ERROR ${(e as Error).message}\n`);
    } finally {
      usedTargetCalls++;
      await sleep(120);
    }
  }

  return {
    estimateTargeted: estimateTargets.length,
    estimateOk,
    estimateFail,
    targetTargeted: targetTargets.length,
    targetOk,
    targetFail,
    writes,
    estimateCalls: usedEstimateCalls,
    targetCalls: usedTargetCalls,
    usdKrw,
  };
}
