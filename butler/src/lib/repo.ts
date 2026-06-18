import { all, one, value } from "./db";
import { userStore } from "./userstore";

/* 기업/컨센서스/재무 조회 — API 라우트와 서버 컴포넌트 공용 데이터 접근 계층. */

export interface CompanyRow {
  corp_code: string;
  stock_code: string;
  name: string;
  name_eng: string | null;
  market: string | null;
  sector: string | null;
  sector_code: string | null;
  sector_name: string | null;
  is_financial: number;
  market_cap: number | null;
  price: number | null;
  fluctuation_rate: number | null;
  per: number | null;
  pbr: number | null;
  fper: number | null;
  eps: number | null;
  feps: number | null;
  bps: number | null;
  dps: number | null;
  dividend_yield: number | null;
  has_consensus: number;
  cover_securities: number | null;
  target_price_avg: number | null;
  target_return_rate: number | null;
  detail_ingested_at: string | null;
  updated_at: string;
}

export interface BrokerTarget {
  broker: string;
  research_url: string | null;
  analyst: string | null;
  report_date: string;
  target_price: number | null;
  target_price_change: string | null;
  rating: string | null;
  rating_change: string | null;
  return_rate: number | null;
  price_close: number | null;
  ai_summary: string | null;
  report_id: string;
}

export interface BrokerTargetHistory extends BrokerTarget {
  previous_target_price: number | null;
  target_delta: number | null;
  target_delta_pct: number | null;
}

export interface GrowthRow {
  metric: string;
  raw_label: string | null;
  fiscal_year: number;
  quarter: number;
  period_type: string;
  is_estimate: number;
  value: number;
  date_label: string | null;
  qoq_pct: number | null;
  yoy_pct: number | null;
}

export interface ChangeRow {
  id: number;
  corp_code: string;
  entity_type: string;
  entity_key: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  delta: number | null;
  delta_pct: number | null;
  change_kind: string | null;
  note: string | null;
  occurred_at: string | null;
  observed_at: string;
  corp_name?: string;
}

const placeholders = (values: unknown[], start = 1) => values.map((_, i) => `$${i + start}`).join(",");

export async function getCompany(corpCode: string): Promise<CompanyRow | undefined> {
  return one<CompanyRow>("SELECT * FROM companies WHERE corp_code = $1", [corpCode]);
}

/** 여러 기업을 corp_code 로 한 번에 조회 (기업 비교). 입력한 codes 순서를 보존한다. */
export async function getCompaniesByCodes(codes: string[]): Promise<CompanyRow[]> {
  if (codes.length === 0) return [];
  const rows = await all<CompanyRow>(
    `SELECT * FROM companies WHERE corp_code IN (${placeholders(codes)})`,
    codes,
  );
  const byCode = new Map(rows.map((r) => [r.corp_code, r]));
  return codes.map((c) => byCode.get(c)).filter((r): r is CompanyRow => !!r);
}

export interface CompareGrowthRow {
  corp_code: string;
  metric: string;
  period_type: "Q" | "A";
  fiscal_year: number;
  quarter: number;
  value: number;
  is_estimate: number;
  qoq_pct: number | null;
  yoy_pct: number | null;
}

export async function getCompareGrowth(codes: string[]): Promise<CompareGrowthRow[]> {
  if (codes.length === 0) return [];
  return all<CompareGrowthRow>(
    `WITH picked AS (
       SELECT corp_code, metric, period_type, fiscal_year, quarter, value, is_estimate,
              ROW_NUMBER() OVER (
                PARTITION BY corp_code, metric, period_type, fiscal_year, quarter
                ORDER BY is_estimate ASC
              ) AS rn
       FROM financials
       WHERE corp_code IN (${placeholders(codes)}) AND value IS NOT NULL
     ),
     u AS (SELECT * FROM picked WHERE rn = 1)
     SELECT u.corp_code, u.metric, u.period_type, u.fiscal_year, u.quarter, u.value, u.is_estimate,
            CASE WHEN u.period_type = 'Q' AND pq.value <> 0
                 THEN ROUND(((u.value - pq.value) / ABS(pq.value) * 100.0)::numeric, 1)::double precision
            END AS qoq_pct,
            CASE WHEN py.value <> 0
                 THEN ROUND(((u.value - py.value) / ABS(py.value) * 100.0)::numeric, 1)::double precision
            END AS yoy_pct
     FROM u
     LEFT JOIN u pq
       ON u.period_type = 'Q'
      AND pq.corp_code = u.corp_code
      AND pq.metric = u.metric
      AND pq.period_type = 'Q'
      AND (
        (u.quarter > 1 AND pq.fiscal_year = u.fiscal_year AND pq.quarter = u.quarter - 1)
        OR (u.quarter = 1 AND pq.fiscal_year = u.fiscal_year - 1 AND pq.quarter = 4)
      )
     LEFT JOIN u py
       ON py.corp_code = u.corp_code
      AND py.metric = u.metric
      AND py.period_type = u.period_type
      AND py.fiscal_year = u.fiscal_year - 1
      AND (u.period_type = 'A' OR py.quarter = u.quarter)
     ORDER BY u.corp_code, u.metric, u.period_type, u.fiscal_year, u.quarter`,
    codes,
  );
}

export type SortCol =
  | "market_cap"
  | "target_return_rate"
  | "cover_securities"
  | "name"
  | "price"
  | "fluctuation_rate"
  | "per"
  | "pbr"
  | "target_price_avg";

const SORT_WHITELIST: Record<SortCol, string> = {
  market_cap: "market_cap",
  target_return_rate: "target_return_rate",
  cover_securities: "cover_securities",
  name: "name",
  price: "price",
  fluctuation_rate: "fluctuation_rate",
  per: "per",
  pbr: "pbr",
  target_price_avg: "target_price_avg",
};

export interface ListOpts {
  q?: string;
  market?: string;
  sector?: string;
  onlyConsensus?: boolean;
  sort?: SortCol;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function listCompanies(opts: ListOpts = {}): Promise<{ total: number; rows: CompanyRow[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.q) {
    const p = push(`%${opts.q}%`);
    where.push(`(name ILIKE ${p} OR stock_code ILIKE ${p} OR corp_code ILIKE ${p})`);
  }
  if (opts.market) where.push(`market = ${push(opts.market)}`);
  if (opts.sector) where.push(`sector_code = ${push(opts.sector)}`);
  if (opts.onlyConsensus) where.push("has_consensus = 1");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const col = SORT_WHITELIST[opts.sort as SortCol] ?? "market_cap";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;

  const total = Number(await value("SELECT COUNT(*)::int AS c FROM companies " + w, params));
  const rows = await all<CompanyRow>(
    `SELECT * FROM companies ${w} ORDER BY ${col} ${dir} NULLS LAST LIMIT ${push(limit)} OFFSET ${push(offset)}`,
    params,
  );
  return { total, rows };
}

/** 증권사별 "최신" 목표주가 (각 증권사의 가장 최근 리포트). 목표가 내림차순. */
export async function getBrokerTargets(corpCode: string): Promise<BrokerTarget[]> {
  return all<BrokerTarget>(
    `SELECT b.name AS broker, b.research_url, v.analyst, v.report_date, v.target_price,
            v.target_price_change, v.rating, v.rating_change, v.return_rate,
            v.price_close, v.ai_summary, v.report_id
     FROM v_latest_broker_target v JOIN brokers b ON b.id = v.broker_id
     WHERE v.corp_code = $1
     ORDER BY v.target_price DESC NULLS LAST, v.report_date DESC`,
    [corpCode],
  );
}

/** 한 증권사의 목표주가 변경 이력(전체 리포트). */
export async function getBrokerHistory(corpCode: string): Promise<BrokerTarget[]> {
  return all<BrokerTarget>(
    `SELECT b.name AS broker, b.research_url, r.analyst, r.report_date, r.target_price,
            r.target_price_change, r.rating, r.rating_change, r.return_rate,
            r.price_close, r.ai_summary, r.report_id
     FROM consensus_reports r JOIN brokers b ON b.id = r.broker_id
     WHERE r.corp_code = $1
     ORDER BY r.report_date DESC, b.name`,
    [corpCode],
  );
}

export async function getBrokerTargetHistory(corpCode: string): Promise<BrokerTargetHistory[]> {
  return all<BrokerTargetHistory>(
    `WITH report_rows AS (
       SELECT
         b.name AS broker,
         b.research_url,
         r.analyst,
         r.report_date,
         r.target_price,
         r.target_price_change,
         r.rating,
         r.rating_change,
         r.return_rate,
         r.price_close,
         r.ai_summary,
         r.report_id,
         LAG(r.target_price) OVER (
           PARTITION BY r.broker_id
           ORDER BY r.report_date, r.report_id
         ) AS previous_target_price
       FROM consensus_reports r
       JOIN brokers b ON b.id = r.broker_id
       WHERE r.corp_code = $1
     )
     SELECT *,
            CASE
              WHEN previous_target_price IS NOT NULL AND target_price IS NOT NULL
              THEN target_price - previous_target_price
            END AS target_delta,
            CASE
              WHEN previous_target_price IS NOT NULL AND previous_target_price <> 0 AND target_price IS NOT NULL
              THEN ((target_price - previous_target_price) * 100.0 / previous_target_price)::double precision
            END AS target_delta_pct
     FROM report_rows
     ORDER BY report_date DESC, broker`,
    [corpCode],
  );
}

export async function getFinancials(corpCode: string, periodType: "Q" | "A"): Promise<GrowthRow[]> {
  return all<GrowthRow>(
    `SELECT metric, raw_label, fiscal_year, quarter, period_type, is_estimate,
            value, date_label, qoq_pct, yoy_pct
     FROM v_financials_growth
     WHERE corp_code = $1 AND period_type = $2
     ORDER BY metric, fiscal_year, quarter`,
    [corpCode, periodType],
  );
}

export async function getValuationSeries(corpCode: string): Promise<Array<{
  metric: string;
  date_label: string;
  value: number;
}>> {
  return all<{ metric: string; date_label: string; value: number }>(
    "SELECT metric, date_label, value FROM valuations WHERE corp_code = $1 ORDER BY date_label",
    [corpCode],
  );
}

export async function getTargetMonthly(corpCode: string): Promise<Array<{
  month: string;
  full_date: string | null;
  tp_max: number | null;
  tp_avg: number | null;
  tp_min: number | null;
  price: number | null;
  cover_securities: number | null;
}>> {
  return all(
    `SELECT month, full_date, tp_max, tp_avg, tp_min, price, cover_securities
     FROM target_price_monthly WHERE corp_code = $1 ORDER BY month`,
    [corpCode],
  );
}

export async function getChanges(corpCode: string, limit = 100): Promise<ChangeRow[]> {
  return all<ChangeRow>(
    `SELECT * FROM change_logs WHERE corp_code = $1
     ORDER BY COALESCE(occurred_at, observed_at) DESC, id DESC LIMIT $2`,
    [corpCode, limit],
  );
}

export async function getRecentChanges(limit = 100, entityType?: string): Promise<ChangeRow[]> {
  if (entityType) {
    return all<ChangeRow>(
      `SELECT c.*, co.name AS corp_name FROM change_logs c
       JOIN companies co ON co.corp_code = c.corp_code
       WHERE c.entity_type = $1
       ORDER BY COALESCE(c.occurred_at, c.observed_at) DESC, c.id DESC LIMIT $2`,
      [entityType, limit],
    );
  }
  return all<ChangeRow>(
    `SELECT c.*, co.name AS corp_name FROM change_logs c
     JOIN companies co ON co.corp_code = c.corp_code
     ORDER BY COALESCE(c.occurred_at, c.observed_at) DESC, c.id DESC LIMIT $1`,
    [limit],
  );
}

/* ----------------------------- 섹터 ----------------------------- */
export interface SectorAgg {
  sector_code: string;
  sector_name: string;
  company_count: number;
  covered_count: number;
  market_cap_sum: number | null;
  per_avg: number | null;
  pbr_avg: number | null;
  return_rate_avg: number | null;
  cover_securities_sum: number | null;
}

export async function listSectorAggs(): Promise<SectorAgg[]> {
  return all<SectorAgg>("SELECT * FROM v_sector_agg ORDER BY market_cap_sum DESC NULLS LAST");
}

export async function getSectorAgg(code: string): Promise<SectorAgg | undefined> {
  return one<SectorAgg>("SELECT * FROM v_sector_agg WHERE sector_code = $1", [code]);
}

export async function getSectorCompanies(code: string, sort = "market_cap"): Promise<CompanyRow[]> {
  const order = sort === "target_return_rate" ? "target_return_rate DESC" : "market_cap DESC";
  return all<CompanyRow>(`SELECT * FROM companies WHERE sector_code = $1 ORDER BY ${order} NULLS LAST`, [code]);
}

/** 섹터 내 증권사별 목표가 상향/하향 카운트 (최근 N일). */
export async function getSectorMomentum(code: string, days = 90): Promise<{ ups: number | null; downs: number | null }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return (await one<{ ups: number | null; downs: number | null }>(
    `SELECT
       SUM(CASE WHEN cl.change_kind='up' THEN 1 ELSE 0 END)::int AS ups,
       SUM(CASE WHEN cl.change_kind='down' THEN 1 ELSE 0 END)::int AS downs
     FROM change_logs cl JOIN companies c ON c.corp_code = cl.corp_code
     WHERE c.sector_code = $1 AND cl.entity_type='target_price'
       AND COALESCE(cl.occurred_at, cl.observed_at) >= $2`,
    [code, since],
  )) ?? { ups: null, downs: null };
}

export async function getWatchlistCompanies(userId: string): Promise<CompanyRow[]> {
  const codes = await userStore.listWatchCorpCodes(userId);
  if (codes.length === 0) return [];
  return all<CompanyRow>(
    `SELECT * FROM companies WHERE corp_code IN (${placeholders(codes)}) ORDER BY market_cap DESC NULLS LAST`,
    codes,
  );
}

export async function getStats() {
  const oneCount = (sql: string) => value<number>(sql).then((v) => Number(v ?? 0));
  return {
    companies: await oneCount("SELECT COUNT(*)::int c FROM companies"),
    withDetail: await oneCount("SELECT COUNT(*)::int c FROM companies WHERE detail_ingested_at IS NOT NULL"),
    withConsensus: await oneCount("SELECT COUNT(*)::int c FROM companies WHERE has_consensus = 1"),
    brokers: await oneCount("SELECT COUNT(*)::int c FROM brokers"),
    reports: await oneCount("SELECT COUNT(*)::int c FROM consensus_reports"),
    financialRows: await oneCount("SELECT COUNT(*)::int c FROM financials"),
    changes: await oneCount("SELECT COUNT(*)::int c FROM change_logs"),
  };
}

/* ----- 경제/실적 캘린더 ----- */

export interface CalendarEventRow {
  id: string;
  category: string;
  subcategory: string | null;
  country: string | null;
  event_date: string;
  event_time: string | null;
  tz: string | null;
  title: string;
  symbol: string | null;
  importance: number;
  actual: string | null;
  consensus: string | null;
  previous: string | null;
  market_cap: number | null;
  url: string | null;
  note: string | null;
  source: string;
}

export interface CalendarQuery {
  from?: string;
  to?: string;
  categories?: string[];
  countries?: string[];
  minImportance?: number;
}

const dispRank = (e: CalendarEventRow) =>
  e.category === "macro" ? (e.subcategory === "central_bank" ? 0 : 1) : 2;

export async function getCalendarEvents(q: CalendarQuery = {}): Promise<CalendarEventRow[]> {
  let evs = (await userStore.getAllCalendarEvents()) as CalendarEventRow[];
  if (q.from) evs = evs.filter((e) => e.event_date >= q.from!);
  if (q.to) evs = evs.filter((e) => e.event_date <= q.to!);
  if (q.categories?.length) evs = evs.filter((e) => q.categories!.includes(e.category));
  if (q.countries?.length) evs = evs.filter((e) => !e.country || q.countries!.includes(e.country));
  if (q.minImportance != null) evs = evs.filter((e) => e.importance >= q.minImportance!);
  evs.sort(
    (a, b) =>
      a.event_date.localeCompare(b.event_date) ||
      dispRank(a) - dispRank(b) ||
      b.importance - a.importance ||
      (a.event_time ?? "99:99").localeCompare(b.event_time ?? "99:99") ||
      (b.market_cap ?? 0) - (a.market_cap ?? 0),
  );
  return evs;
}

export async function getCalendarStats() {
  const evs = (await userStore.getAllCalendarEvents()) as CalendarEventRow[];
  const dates = evs.map((e) => e.event_date).sort();
  return {
    total: evs.length,
    macro: evs.filter((e) => e.category === "macro").length,
    earningsIntl: evs.filter((e) => e.category === "earnings_intl").length,
    earningsKr: evs.filter((e) => e.category === "earnings_kr").length,
    minDate: dates[0] ?? null,
    maxDate: dates[dates.length - 1] ?? null,
  };
}
