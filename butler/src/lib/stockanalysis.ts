import { createHash } from "node:crypto";
import { all, nowIso, one, query, tx, type Queryable } from "./db";
import { normalizeEstimateValue, upsertEstimateConsensus } from "./estimate-consensus";
import { logChange } from "./ingest";
import { fetchUsdKrwRate } from "./nasdaq";

const STOCK_ANALYSIS_BASE = "https://stockanalysis.com/stocks";
const DEFAULT_LIMIT = 20;
const DEFAULT_CALL_DELAY_MS = 7000;
const DEFAULT_JITTER_MS = 3000;
const ESTIMATE_SOURCE = "stockanalysis:forecast";
const ACTUAL_SOURCE = "stockanalysis:financials";
const TARGET_SOURCE = "stockanalysis:forecast";

const STOCK_ANALYSIS_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

type NasdaqCandidate = {
  corp_code: string;
  stock_code: string;
  price: number | null;
  target_price_avg: number | null;
};

type ParsedFinancialRow = {
  fiscalYear: number;
  quarter: number;
  periodType: "Q" | "A";
  isEstimate: boolean;
  dateLabel: string;
  analysts: number | null;
  values: Partial<Record<"REVENUE" | "OPERATING_PROFIT" | "NET_INCOME" | "EPS", number>>;
};

type ParsedBrokerTarget = {
  firm: string;
  analyst: string | null;
  date: string;
  rating: string | null;
  action: string | null;
  target: number | null;
  previousTarget: number | null;
};

type ParsedStats = {
  per: number | null;
  pbr: number | null;
  fper: number | null;
  bps: number | null;
  dps: number | null;
  dividendYield: number | null;
};

type ParsedForecast = {
  currentPrice: number | null;
  targetAvg: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  targetMedian: number | null;
  targetCount: number | null;
  ratingCount: number | null;
  stats: ParsedStats;
  financialRows: ParsedFinancialRow[];
  brokerTargets: ParsedBrokerTarget[];
};

export interface StockAnalysisNasdaqBackfillOptions {
  limit?: number;
  corpCode?: string;
  symbol?: string;
  callDelayMs?: number;
  jitterMs?: number;
  overwriteEstimates?: boolean;
  overwriteTargets?: boolean;
  writeBrokerTargets?: boolean;
  log?: (message: string) => void;
}

export interface StockAnalysisNasdaqBackfillSummary {
  targeted: number;
  ok: number;
  fail: number;
  writes: number;
  actualWrites: number;
  estimateWrites: number;
  valuationWrites: number;
  targetWrites: number;
  reportWrites: number;
  usdKrw: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "null" || s === "void 0" || s === "undefined" || s === '"[PRO]"' || s === "[PRO]") return null;
  const n = Number(s.replace(/^"|"$/g, "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function emptyStats(): ParsedStats {
  return { per: null, pbr: null, fper: null, bps: null, dps: null, dividendYield: null };
}

function parseString(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "null" || s === "void 0" || s === "undefined") return null;
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
}

function fieldNumber(block: string, field: string): number | null {
  const m = new RegExp(`(?:^|[,{])${field}:([^,}]+)`).exec(block);
  return m ? parseNumber(m[1]) : null;
}

function fieldString(block: string, field: string): string | null {
  const m = new RegExp(`(?:^|[,{])${field}:("(?:(?:\\\\")|[^"])*"|null|void 0|undefined)`).exec(block);
  return m ? parseString(m[1]) : null;
}

function findObjectByKey(source: string, key: string): string | null {
  const marker = `${key}:{`;
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) return null;
  const start = markerAt + key.length + 1;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (ch === '"' && prev !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}

function findArrayByKey(source: string, key: string): string | null {
  const marker = `${key}:[`;
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) return null;
  const start = markerAt + key.length + 1;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (ch === '"' && prev !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}

function splitLiterals(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const prev = raw[i - 1];
    if (ch === '"' && prev !== "\\") quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function arrayValues(block: string, key: string): Array<string | number | null> {
  return splitLiterals(findArrayByKey(block, key)).map((v) => {
    const s = parseString(v);
    if (s != null && Number.isNaN(Number(s))) return s;
    return parseNumber(v);
  });
}

function arrayNumber(values: Array<string | number | null>, i: number): number | null {
  return parseNumber(values[i]);
}

function arrayString(values: Array<string | number | null>, i: number): string | null {
  const v = values[i];
  return typeof v === "string" ? v : v == null ? null : String(v);
}

function quarterNumber(raw: string | null): number | null {
  const m = /^Q([1-4])$/.exec(raw ?? "");
  return m ? Number(m[1]) : null;
}

function buildFinancialRows(block: string | null, periodType: "Q" | "A"): ParsedFinancialRow[] {
  if (!block) return [];
  const lastDate = fieldNumber(block, "lastDate");
  const dates = arrayValues(block, "dates");
  const fiscalYears = arrayValues(block, "fiscalYear");
  const fiscalQuarters = arrayValues(block, "fiscalQuarter");
  const analysts = arrayValues(block, "analysts");
  const revenue = arrayValues(block, "revenue");
  const operatingIncome = arrayValues(block, "operatingIncome");
  const netIncome = arrayValues(block, "netIncome");
  const eps = arrayValues(block, "eps");
  const adjustedEps = arrayValues(block, "adjustedEps");
  const length = Math.max(
    dates.length,
    fiscalYears.length,
    fiscalQuarters.length,
    revenue.length,
    operatingIncome.length,
    netIncome.length,
    eps.length,
    adjustedEps.length,
  );
  const rows: ParsedFinancialRow[] = [];

  for (let i = 0; i < length; i++) {
    const year = parseNumber(fiscalYears[i]);
    if (year == null) continue;
    const isEstimate = lastDate == null ? (arrayNumber(analysts, i) ?? 0) > 0 : i > lastDate;
    const quarter = periodType === "A" ? 0 : quarterNumber(arrayString(fiscalQuarters, i));
    if (quarter == null) continue;
    const estimateEps = arrayNumber(adjustedEps, i) ?? arrayNumber(eps, i);
    const actualEps = arrayNumber(eps, i) ?? arrayNumber(adjustedEps, i);
    const values = {
      REVENUE: arrayNumber(revenue, i) ?? undefined,
      OPERATING_PROFIT: arrayNumber(operatingIncome, i) ?? undefined,
      NET_INCOME: arrayNumber(netIncome, i) ?? undefined,
      EPS: (isEstimate ? estimateEps : actualEps) ?? undefined,
    };
    if (Object.values(values).every((v) => v == null)) continue;
    rows.push({
      fiscalYear: year,
      quarter,
      periodType,
      isEstimate,
      dateLabel: arrayString(dates, i) ?? (periodType === "A" ? String(year) : `${year}.${quarter}Q`),
      analysts: arrayNumber(analysts, i),
      values,
    });
  }

  return rows;
}

function parseTargets(html: string): Pick<
  ParsedForecast,
  "targetAvg" | "targetHigh" | "targetLow" | "targetMedian" | "targetCount" | "ratingCount"
> {
  const priceTargets = findObjectByKey(html, "priceTargets");
  const ratings = findObjectByKey(html, "currentRatings");
  const directTargets =
    /targets:\{low:([^,]+),high:([^,]+),count:([^,]+),median:([^,]+),average:([^,]+),updated:/.exec(html);

  const priceTargetAvg = priceTargets ? fieldNumber(priceTargets, "avg") : null;
  return {
    targetAvg: priceTargetAvg ?? (directTargets ? parseNumber(directTargets[5]) : null),
    targetHigh: (priceTargets ? fieldNumber(priceTargets, "high") : null) ?? (directTargets ? parseNumber(directTargets[2]) : null),
    targetLow: (priceTargets ? fieldNumber(priceTargets, "low") : null) ?? (directTargets ? parseNumber(directTargets[1]) : null),
    targetMedian:
      (priceTargets ? fieldNumber(priceTargets, "median") : null) ?? (directTargets ? parseNumber(directTargets[4]) : null),
    targetCount:
      (priceTargets ? fieldNumber(priceTargets, "numPriceTargets") : null) ??
      (directTargets ? parseNumber(directTargets[3]) : null),
    ratingCount: ratings ? fieldNumber(ratings, "count") : null,
  };
}

function parseBrokerTargets(html: string): ParsedBrokerTarget[] {
  const ratingsRaw = findArrayByKey(html, "ratings");
  if (!ratingsRaw) return [];
  const rows: ParsedBrokerTarget[] = [];
  const re = /\{action_rt:[\s\S]*?,curr:"[^"]*"\}/g;
  for (const m of ratingsRaw.matchAll(re)) {
    const block = m[0];
    const firm = fieldString(block, "firm");
    const date = fieldString(block, "date");
    if (!firm || !date) continue;
    rows.push({
      firm,
      analyst: fieldString(block, "analyst"),
      date,
      rating: fieldString(block, "rating_new"),
      action: fieldString(block, "action_rt"),
      target: fieldNumber(block, "pt_now"),
      previousTarget: fieldNumber(block, "pt_old"),
    });
  }
  return rows;
}

function statisticValue(html: string, id: string): number | null {
  const m = new RegExp(`\\{id:"${id}"[^}]*\\}`).exec(html);
  if (!m) return null;
  return fieldNumber(m[0], "hover") ?? fieldNumber(m[0], "value");
}

export function parseStockAnalysisStatistics(html: string): ParsedStats {
  return {
    per: statisticValue(html, "pe"),
    pbr: statisticValue(html, "pb"),
    fper: statisticValue(html, "peForward"),
    bps: statisticValue(html, "bvps"),
    dps: statisticValue(html, "dps"),
    dividendYield: statisticValue(html, "dividendYield"),
  };
}

export function parseStockAnalysisForecast(html: string): ParsedForecast {
  const table = findObjectByKey(html, "table");
  const annual = table ? findObjectByKey(table, "annual") : null;
  const quarterly = table ? findObjectByKey(table, "quarterly") : null;
  const quote = findObjectByKey(html, "quote");
  return {
    currentPrice: quote ? fieldNumber(quote, "p") : null,
    ...parseTargets(html),
    stats: emptyStats(),
    financialRows: [...buildFinancialRows(annual, "A"), ...buildFinancialRows(quarterly, "Q")],
    brokerTargets: parseBrokerTargets(html),
  };
}

async function fetchForecastHtml(symbol: string): Promise<string> {
  const res = await fetch(`${STOCK_ANALYSIS_BASE}/${encodeURIComponent(symbol.toLowerCase())}/forecast/`, {
    headers: STOCK_ANALYSIS_HEADERS,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`StockAnalysis ${symbol} HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  if (/captcha|enable js|blocked|too many requests/i.test(text.slice(0, 1000))) {
    throw new Error(`StockAnalysis ${symbol} blocked`);
  }
  return text;
}

async function fetchStatisticsHtml(symbol: string): Promise<string> {
  const res = await fetch(`${STOCK_ANALYSIS_BASE}/${encodeURIComponent(symbol.toLowerCase())}/statistics/`, {
    headers: STOCK_ANALYSIS_HEADERS,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`StockAnalysis statistics ${symbol} HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  if (/captcha|enable js|blocked|too many requests/i.test(text.slice(0, 1000))) {
    throw new Error(`StockAnalysis statistics ${symbol} blocked`);
  }
  return text;
}

async function candidates(
  db: Queryable,
  limit: number,
  options: Pick<StockAnalysisNasdaqBackfillOptions, "corpCode" | "symbol">,
): Promise<NasdaqCandidate[]> {
  const where = ["active = 1", "source = 'nasdaq'"];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (options.corpCode) where.push(`corp_code = ${push(options.corpCode)}`);
  if (options.symbol) where.push(`stock_code = ${push(options.symbol.toUpperCase())}`);
  params.push(limit);
  return all<NasdaqCandidate>(
    `SELECT corp_code, stock_code, price, target_price_avg
     FROM companies
     WHERE ${where.join(" AND ")}
     ORDER BY
       CASE WHEN per IS NULL OR pbr IS NULL OR fper IS NULL OR bps IS NULL OR eps IS NULL OR dps IS NULL OR dividend_yield IS NULL
            THEN 0 ELSE 1 END,
       CASE WHEN per IS NULL OR pbr IS NULL OR fper IS NULL OR bps IS NULL OR eps IS NULL OR dps IS NULL OR dividend_yield IS NULL
            THEN market_cap END DESC NULLS LAST,
       CASE WHEN stockanalysis_estimates_at IS NULL THEN 0 ELSE 1 END,
       stockanalysis_estimates_at ASC NULLS FIRST,
       market_cap DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
    db,
  );
}

async function markStockAnalysisAttempt(db: Queryable, corpCode: string, observedAt: string): Promise<void> {
  await query(
    `UPDATE companies
     SET stockanalysis_estimates_at = COALESCE(stockanalysis_estimates_at, $2),
         updated_at = $2
     WHERE corp_code = $1`,
    [corpCode, observedAt],
    db,
  );
}

async function insertFinancialRow(
  db: Queryable,
  c: NasdaqCandidate,
  row: ParsedFinancialRow,
  metric: "REVENUE" | "OPERATING_PROFIT" | "NET_INCOME" | "EPS",
  value: number | undefined,
  usdKrw: number,
  overwriteEstimates: boolean,
): Promise<number> {
  if (value == null) return 0;
  const source = row.isEstimate ? ESTIMATE_SOURCE : ACTUAL_SOURCE;
  const storedValue = metric === "EPS" ? value : Math.round(value * usdKrw);
  const conflict =
    row.isEstimate && !overwriteEstimates
      ? "DO NOTHING"
      : `DO UPDATE SET value = excluded.value, raw_label = excluded.raw_label,
                       date_label = excluded.date_label, source = excluded.source`;
  const res = await query(
    `INSERT INTO financials
       (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate, source)
     ${conflict}`,
    [
      c.corp_code,
      metric,
      `StockAnalysis ${row.isEstimate ? "Estimate" : "Actual"} ${metric}`,
      row.fiscalYear,
      row.quarter,
      row.periodType,
      storedValue,
      row.isEstimate ? 1 : 0,
      row.dateLabel,
      source,
    ],
    db,
  );
  return res.rowCount ?? 0;
}

async function getBrokerId(db: Queryable, name: string): Promise<number> {
  const existing = await one<{ id: number }>("SELECT id FROM brokers WHERE name = $1", [name], db);
  if (existing) return existing.id;
  const inserted = await one<{ id: number }>(
    "INSERT INTO brokers (name, research_url) VALUES ($1, $2) RETURNING id",
    [name, null],
    db,
  );
  if (!inserted) throw new Error(`failed to insert broker: ${name}`);
  return inserted.id;
}

function stableReportId(symbol: string, r: ParsedBrokerTarget): string {
  const hash = createHash("sha1")
    .update([symbol, r.firm, r.analyst ?? "", r.date, r.rating ?? "", r.action ?? "", r.target ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `stockanalysis:${symbol}:${hash}`;
}

async function insertBrokerTarget(
  db: Queryable,
  c: NasdaqCandidate,
  currentPrice: number | null,
  r: ParsedBrokerTarget,
): Promise<number> {
  const brokerId = await getBrokerId(db, r.firm);
  const reportId = stableReportId(c.stock_code, r);
  const prev = await one<{ target_price: number | null }>(
    `SELECT target_price FROM consensus_reports
     WHERE corp_code=$1 AND broker_id=$2 AND report_date < $3
     ORDER BY report_date DESC LIMIT 1`,
    [c.corp_code, brokerId, r.date],
    db,
  );
  const returnRate =
    r.target != null && currentPrice != null && currentPrice !== 0
      ? ((r.target - currentPrice) / Math.abs(currentPrice)) * 100
      : null;
  const targetChange =
    r.previousTarget != null && r.target != null
      ? r.target > r.previousTarget
        ? "상향"
        : r.target < r.previousTarget
          ? "하향"
          : "유지"
      : r.action;
  const inserted = await query<{ inserted: boolean }>(
    `INSERT INTO consensus_reports
       (report_id, corp_code, broker_id, title, analyst, report_date, rating, rating_change,
        target_price, target_price_change, previous_target_price, price_close, return_rate, ai_summary, source, ingested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT(report_id) DO UPDATE SET
       previous_target_price = COALESCE(excluded.previous_target_price, consensus_reports.previous_target_price),
       target_price_change = COALESCE(excluded.target_price_change, consensus_reports.target_price_change)
     RETURNING (xmax = 0) AS inserted`,
    [
      reportId,
      c.corp_code,
      brokerId,
      `${r.firm} ${r.rating ?? ""}`.trim() || null,
      r.analyst,
      r.date,
      r.rating,
      r.action,
      r.target,
      targetChange,
      r.previousTarget,
      currentPrice,
      returnRate,
      null,
      TARGET_SOURCE,
      nowIso(),
    ],
    db,
  );

  if (!inserted.rows[0]?.inserted) return 0;
  const oldTp = r.previousTarget ?? prev?.target_price ?? null;
  if (r.target != null && oldTp != null && r.target !== oldTp) {
    const delta = r.target - oldTp;
    await logChange(db, {
      corp_code: c.corp_code,
      entity_type: "target_price",
      entity_key: r.firm,
      field: "target_price",
      old_value: oldTp,
      new_value: r.target,
      delta,
      delta_pct: oldTp ? (delta / oldTp) * 100 : null,
      change_kind: delta > 0 ? "up" : "down",
      note: `${r.firm} 목표주가 ${targetChange ?? ""} (${r.analyst ?? ""})`,
      occurred_at: r.date,
    });
  } else if (r.target != null && oldTp == null) {
    await logChange(db, {
      corp_code: c.corp_code,
      entity_type: "target_price",
      entity_key: r.firm,
      field: "target_price",
      new_value: r.target,
      change_kind: "new",
      note: `${r.firm} 신규 커버리지 (${r.analyst ?? ""})`,
      occurred_at: r.date,
    });
  }
  return 1;
}

async function upsertParsedForecast(
  db: Queryable,
  c: NasdaqCandidate,
  parsed: ParsedForecast,
  usdKrw: number,
  options: Required<Pick<StockAnalysisNasdaqBackfillOptions, "overwriteEstimates" | "overwriteTargets" | "writeBrokerTargets">>,
): Promise<{
  writes: number;
  actualWrites: number;
  estimateWrites: number;
  valuationWrites: number;
  targetWrites: number;
  reportWrites: number;
}> {
  const now = nowIso();
  let actualWrites = 0;
  let estimateWrites = 0;
  let valuationWrites = 0;
  let targetWrites = 0;
  let reportWrites = 0;

  for (const row of parsed.financialRows) {
    for (const metric of ["REVENUE", "OPERATING_PROFIT", "NET_INCOME", "EPS"] as const) {
      const n = await insertFinancialRow(db, c, row, metric, row.values[metric], usdKrw, options.overwriteEstimates);
      if (row.isEstimate) estimateWrites += n;
      else actualWrites += n;
      if (row.isEstimate) {
        estimateWrites += await upsertEstimateConsensus(db, {
          corpCode: c.corp_code,
          metric,
          fiscalYear: row.fiscalYear,
          quarter: row.quarter,
          periodType: row.periodType,
          avgValue: normalizeEstimateValue(metric, row.values[metric], usdKrw),
          analystCount: row.analysts,
          dateLabel: row.dateLabel,
          source: ESTIMATE_SOURCE,
          updatedAt: now,
        });
      }
    }
  }

  const annualEstimates = parsed.financialRows
    .filter((r) => r.isEstimate && r.periodType === "A")
    .sort((a, b) => a.fiscalYear - b.fiscalYear);
  const currentAnnual = annualEstimates[0];
  const nextAnnual = annualEstimates[1];
  const analysts = Math.max(
    0,
    parsed.targetCount ?? 0,
    parsed.ratingCount ?? 0,
    ...parsed.financialRows.map((r) => r.analysts ?? 0),
  );
  const cover = analysts > 0 ? Math.round(analysts) : null;
  const currentPrice = c.price ?? parsed.currentPrice;
  const shouldUpdateTarget = parsed.targetAvg != null && (options.overwriteTargets || c.target_price_avg == null);
  const targetReturn =
    parsed.targetAvg != null && currentPrice != null && currentPrice !== 0
      ? ((parsed.targetAvg - currentPrice) / Math.abs(currentPrice)) * 100
      : null;

  const companyRes = await query(
    `UPDATE companies SET
       eps = CASE WHEN $1::double precision IS NULL THEN eps ELSE COALESCE(eps, $1::double precision) END,
       feps = CASE WHEN $2::double precision IS NULL THEN feps ELSE COALESCE(feps, $2::double precision) END,
       has_consensus = CASE WHEN $3::integer IS NULL THEN has_consensus ELSE 1 END,
       cover_securities = GREATEST(COALESCE(cover_securities, 0), COALESCE($3::integer, 0)),
       target_price_avg = CASE WHEN $4::boolean THEN $5::double precision ELSE target_price_avg END,
       target_return_rate = CASE WHEN $4::boolean THEN $6::double precision ELSE target_return_rate END,
       per = CASE WHEN $7::double precision IS NULL THEN per ELSE $7::double precision END,
       pbr = CASE WHEN $8::double precision IS NULL THEN pbr ELSE $8::double precision END,
       fper = CASE WHEN $9::double precision IS NULL THEN fper ELSE $9::double precision END,
       bps = CASE WHEN $10::double precision IS NULL THEN bps ELSE $10::double precision END,
       dps = CASE WHEN $11::double precision IS NULL THEN dps ELSE $11::double precision END,
       dividend_yield = CASE WHEN $12::double precision IS NULL THEN dividend_yield ELSE $12::double precision END,
       stockanalysis_estimates_at = $13,
       stockanalysis_targets_at = CASE WHEN $14::boolean THEN $13 ELSE stockanalysis_targets_at END,
       updated_at = $13
     WHERE corp_code = $15`,
    [
      currentAnnual?.values.EPS ?? null,
      nextAnnual?.values.EPS ?? null,
      cover,
      shouldUpdateTarget,
      parsed.targetAvg,
      targetReturn,
      parsed.stats.per,
      parsed.stats.pbr,
      parsed.stats.fper,
      parsed.stats.bps,
      parsed.stats.dps,
      parsed.stats.dividendYield,
      now,
      parsed.targetAvg != null,
      c.corp_code,
    ],
    db,
  );
  const hasStats = Object.values(parsed.stats).some((v) => v != null);
  valuationWrites += hasStats ? (companyRes.rowCount ?? 0) : 0;

  if (shouldUpdateTarget) {
    const month = now.slice(0, 7);
    const res = await query(
      `INSERT INTO target_price_monthly
         (corp_code, month, full_date, tp_max, tp_avg, tp_min, price, cover_securities, return_ratio, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(corp_code, month)
       DO UPDATE SET full_date = excluded.full_date,
                     tp_max = COALESCE(excluded.tp_max, target_price_monthly.tp_max),
                     tp_avg = excluded.tp_avg,
                     tp_min = COALESCE(excluded.tp_min, target_price_monthly.tp_min),
                     price = excluded.price,
                     cover_securities = excluded.cover_securities,
                     return_ratio = excluded.return_ratio,
                     source = excluded.source`,
      [
        c.corp_code,
        month,
        now.slice(0, 10),
        parsed.targetHigh,
        parsed.targetAvg,
        parsed.targetLow,
        currentPrice,
        parsed.targetCount,
        targetReturn,
        TARGET_SOURCE,
      ],
      db,
    );
    targetWrites += res.rowCount ?? 0;
  }

  if (options.writeBrokerTargets) {
    for (const r of parsed.brokerTargets) {
      reportWrites += await insertBrokerTarget(db, c, currentPrice, r);
    }
  }

  return {
    writes: actualWrites + estimateWrites + valuationWrites + targetWrites + reportWrites,
    actualWrites,
    estimateWrites,
    valuationWrites,
    targetWrites,
    reportWrites,
  };
}

export async function backfillStockAnalysisNasdaqEstimates(
  db: Queryable,
  options: StockAnalysisNasdaqBackfillOptions = {},
): Promise<StockAnalysisNasdaqBackfillSummary> {
  const limit = Math.max(0, Math.floor(options.limit ?? Number(process.env.STOCKANALYSIS_NASDAQ_LIMIT || String(DEFAULT_LIMIT))));
  const callDelayMs = Math.max(
    0,
    Math.floor(options.callDelayMs ?? Number(process.env.STOCKANALYSIS_CALL_DELAY_MS || String(DEFAULT_CALL_DELAY_MS))),
  );
  const jitterMs = Math.max(
    0,
    Math.floor(options.jitterMs ?? Number(process.env.STOCKANALYSIS_JITTER_MS || String(DEFAULT_JITTER_MS))),
  );
  const overwriteEstimates = options.overwriteEstimates ?? false;
  const overwriteTargets = options.overwriteTargets ?? false;
  const writeBrokerTargets = options.writeBrokerTargets ?? true;
  const log = options.log ?? (() => {});
  const [targets, usdKrw] = await Promise.all([candidates(db, limit, options), fetchUsdKrwRate()]);
  if (targets.length === 0) {
    return {
      targeted: 0,
      ok: 0,
      fail: 0,
      writes: 0,
      actualWrites: 0,
      estimateWrites: 0,
      valuationWrites: 0,
      targetWrites: 0,
      reportWrites: 0,
      usdKrw,
    };
  }

  let ok = 0;
  let fail = 0;
  let writes = 0;
  let actualWrites = 0;
  let estimateWrites = 0;
  let valuationWrites = 0;
  let targetWrites = 0;
  let reportWrites = 0;

  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    try {
      const forecastHtml = await fetchForecastHtml(c.stock_code);
      const parsed = parseStockAnalysisForecast(forecastHtml);
      try {
        parsed.stats = parseStockAnalysisStatistics(await fetchStatisticsHtml(c.stock_code));
      } catch (e) {
        log(`  stockanalysis [${i + 1}/${targets.length}] ${c.stock_code} statistics unavailable ${(e as Error).message}\n`);
      }
      const r = await tx((client) =>
        upsertParsedForecast(client, c, parsed, usdKrw, { overwriteEstimates, overwriteTargets, writeBrokerTargets }),
      );
      ok++;
      writes += r.writes;
      actualWrites += r.actualWrites;
      estimateWrites += r.estimateWrites;
      valuationWrites += r.valuationWrites;
      targetWrites += r.targetWrites;
      reportWrites += r.reportWrites;
      log(
        `  stockanalysis [${i + 1}/${targets.length}] ${c.stock_code} ok writes=${r.writes} ` +
          `actual=${r.actualWrites} estimates=${r.estimateWrites} valuations=${r.valuationWrites} ` +
          `targets=${r.targetWrites} reports=${r.reportWrites}\n`,
      );
    } catch (e) {
      const message = (e as Error).message;
      if (/blocked|captcha|too many requests|HTTP 429/i.test(message)) {
        log(`  stockanalysis [${i + 1}/${targets.length}] ${c.stock_code} BLOCKED ${message}\n`);
        throw e;
      }
      try {
        await markStockAnalysisAttempt(db, c.corp_code, nowIso());
      } catch (markError) {
        log(
          `  stockanalysis [${i + 1}/${targets.length}] ${c.stock_code} attempt mark failed ` +
            `${(markError as Error).message}\n`,
        );
      }
      fail++;
      log(`  stockanalysis [${i + 1}/${targets.length}] ${c.stock_code} ERROR ${message}\n`);
    } finally {
      const delay = callDelayMs + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
      if (delay > 0) await sleep(delay);
    }
  }

  return { targeted: targets.length, ok, fail, writes, actualWrites, estimateWrites, valuationWrites, targetWrites, reportWrites, usdKrw };
}
