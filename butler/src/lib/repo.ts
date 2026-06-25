import { all, one, value } from "./db";
import {
  DEFAULT_ESTIMATE_PROVIDER,
  DEFAULT_GLOBAL_ESTIMATE_PROVIDER,
  estimateProviderOrder,
  type EstimateProvider,
} from "./estimate-provider";
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
  currency: string;
  country: string | null;
  active: number;
  fmp_estimates_at: string | null;
  fmp_targets_at: string | null;
  seekingalpha_estimates_at: string | null;
  yahoo_estimates_at: string | null;
  yahoo_targets_at: string | null;
  has_consensus: number;
  cover_securities: number | null;
  target_price_avg: number | null;
  target_return_rate: number | null;
  forward_per_y0: number | null;
  forward_per_y1: number | null;
  forward_per_y2: number | null;
  detail_ingested_at: string | null;
  source: string;
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
  corp_code: string;
  metric: string;
  raw_label: string | null;
  fiscal_year: number;
  quarter: number;
  period_type: string;
  is_estimate: number;
  value: number;
  date_label: string | null;
  source: string;
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

export interface CompanyNewsRow {
  id: number;
  corp_code: string;
  provider: string;
  query: string;
  source_name: string | null;
  title: string;
  description: string | null;
  url: string;
  origin_url: string | null;
  published_at: string | null;
  ingested_at: string;
}

const placeholders = (values: unknown[], start = 1) => values.map((_, i) => `$${i + start}`).join(",");

export async function getCompany(corpCode: string): Promise<CompanyRow | undefined> {
  return one<CompanyRow>("SELECT * FROM companies WHERE corp_code = $1", [corpCode]);
}

/** 여러 기업을 corp_code 로 한 번에 조회 (기업 비교). 입력한 codes 순서를 보존한다. */
export async function getCompaniesByCodes(codes: string[]): Promise<CompanyRow[]> {
  if (codes.length === 0) return [];
  const rows = await all<CompanyRow>(
    `SELECT * FROM companies WHERE active = 1 AND corp_code IN (${placeholders(codes)})`,
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
  source: string;
  qoq_pct: number | null;
  yoy_pct: number | null;
}

const ACTUAL_SOURCE_RANK_SQL = `CASE f.source
  WHEN 'dart' THEN 0
  WHEN 'butler' THEN 1
  WHEN 'fnguide' THEN 2
  WHEN 'wisereport' THEN 3
  ELSE 9
END`;

function rankedFinancialsCte(codeWhereSql: string, providerParam: string) {
  return `WITH provider_order AS (
       SELECT source, ord
       FROM unnest(${providerParam}::text[]) WITH ORDINALITY AS p(source, ord)
     ),
     ranked AS (
       SELECT f.corp_code, f.metric, f.raw_label, f.period_type, f.fiscal_year, f.quarter,
              f.value, f.is_estimate, f.date_label, f.source,
              ROW_NUMBER() OVER (
                PARTITION BY f.corp_code, f.metric, f.period_type, f.fiscal_year, f.quarter, f.is_estimate
                ORDER BY CASE
                           WHEN f.is_estimate = 0 THEN ${ACTUAL_SOURCE_RANK_SQL}
                           ELSE COALESCE(po.ord, 99)
                         END,
                         f.source
              ) AS rn
       FROM financials f
       LEFT JOIN provider_order po ON po.source = f.source
       WHERE ${codeWhereSql}
         AND f.value IS NOT NULL
         AND (f.is_estimate = 0 OR po.source IS NOT NULL)
     ),
     u AS (SELECT * FROM ranked WHERE rn = 1)`;
}

function rankedFinancialsByMarketCte(codeWhereSql: string, domesticProviderParam: string, globalProviderParam: string) {
  const providerArray = companyEstimateProviderArray(domesticProviderParam, globalProviderParam);
  return `WITH ranked AS (
       SELECT f.corp_code, f.metric, f.raw_label, f.period_type, f.fiscal_year, f.quarter,
              f.value, f.is_estimate, f.date_label, f.source,
              ROW_NUMBER() OVER (
                PARTITION BY f.corp_code, f.metric, f.period_type, f.fiscal_year, f.quarter, f.is_estimate
                ORDER BY CASE
                           WHEN f.is_estimate = 0 THEN ${ACTUAL_SOURCE_RANK_SQL}
                           ELSE COALESCE(array_position(${providerArray}, f.source), 99)
                         END,
                         f.source
              ) AS rn
       FROM financials f
       JOIN companies c ON c.corp_code = f.corp_code
       WHERE ${codeWhereSql}
         AND f.value IS NOT NULL
         AND (f.is_estimate = 0 OR f.source = ANY(${providerArray}))
     ),
     u AS (SELECT * FROM ranked WHERE rn = 1)`;
}

export async function getCompareGrowth(
  codes: string[],
  domesticEstimateProvider: EstimateProvider = DEFAULT_ESTIMATE_PROVIDER,
  globalEstimateProvider: EstimateProvider = DEFAULT_GLOBAL_ESTIMATE_PROVIDER,
): Promise<CompareGrowthRow[]> {
  if (codes.length === 0) return [];
  const domesticProviderParam = `$${codes.length + 1}`;
  const globalProviderParam = `$${codes.length + 2}`;
  return all<CompareGrowthRow>(
    `${rankedFinancialsByMarketCte(`f.corp_code IN (${placeholders(codes)})`, domesticProviderParam, globalProviderParam)}
     SELECT u.corp_code, u.metric, u.period_type, u.fiscal_year, u.quarter, u.value, u.is_estimate, u.source,
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
    [...codes, estimateProviderOrder(domesticEstimateProvider), estimateProviderOrder(globalEstimateProvider)],
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
  | "forward_per_y0"
  | "forward_per_y1"
  | "forward_per_y2"
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
  forward_per_y0: "forward_per_y0",
  forward_per_y1: "forward_per_y1",
  forward_per_y2: "forward_per_y2",
  pbr: "pbr",
  target_price_avg: "target_price_avg",
};

const COMPANY_WITH_FORWARD_PER_SELECT = `
  c.*,
  CASE WHEN c.price IS NOT NULL AND eps_y0.value > 0 THEN ROUND((c.price / eps_y0.value)::numeric, 1)::double precision END AS forward_per_y0,
  CASE WHEN c.price IS NOT NULL AND eps_y1.value > 0 THEN ROUND((c.price / eps_y1.value)::numeric, 1)::double precision END AS forward_per_y1,
  CASE WHEN c.price IS NOT NULL AND eps_y2.value > 0 THEN ROUND((c.price / eps_y2.value)::numeric, 1)::double precision END AS forward_per_y2
`;

function companyEstimateProviderArray(domesticProviderParam: string, globalProviderParam: string) {
  return `CASE
      WHEN c.source = 'nasdaq' OR c.market IN ('NASDAQ', 'NYSE', 'AMEX') THEN ${globalProviderParam}::text[]
      ELSE ${domesticProviderParam}::text[]
    END`;
}

function companyForwardPerJoins(domesticProviderParam: string, globalProviderParam: string) {
  const providerArray = companyEstimateProviderArray(domesticProviderParam, globalProviderParam);
  return `
  LEFT JOIN LATERAL (
    SELECT value
    FROM financials f
    WHERE f.corp_code = c.corp_code
      AND f.metric = 'EPS'
      AND f.period_type = 'A'
      AND f.is_estimate = 1
      AND f.fiscal_year = EXTRACT(YEAR FROM CURRENT_DATE)::int
      AND f.value IS NOT NULL
      AND f.source = ANY(${providerArray})
    ORDER BY COALESCE(array_position(${providerArray}, f.source), 99), f.source
    LIMIT 1
  ) eps_y0 ON TRUE
  LEFT JOIN LATERAL (
    SELECT value
    FROM financials f
    WHERE f.corp_code = c.corp_code
      AND f.metric = 'EPS'
      AND f.period_type = 'A'
      AND f.is_estimate = 1
      AND f.fiscal_year = EXTRACT(YEAR FROM CURRENT_DATE)::int + 1
      AND f.value IS NOT NULL
      AND f.source = ANY(${providerArray})
    ORDER BY COALESCE(array_position(${providerArray}, f.source), 99), f.source
    LIMIT 1
  ) eps_y1 ON TRUE
  LEFT JOIN LATERAL (
    SELECT value
    FROM financials f
    WHERE f.corp_code = c.corp_code
      AND f.metric = 'EPS'
      AND f.period_type = 'A'
      AND f.is_estimate = 1
      AND f.fiscal_year = EXTRACT(YEAR FROM CURRENT_DATE)::int + 2
      AND f.value IS NOT NULL
      AND f.source = ANY(${providerArray})
    ORDER BY COALESCE(array_position(${providerArray}, f.source), 99), f.source
    LIMIT 1
  ) eps_y2 ON TRUE
`;
}

export interface ListOpts {
  q?: string;
  market?: string | string[];
  sector?: string;
  industry?: string;
  onlyConsensus?: boolean;
  sort?: SortCol;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  estimateProvider?: EstimateProvider;
  domesticEstimateProvider?: EstimateProvider;
  globalEstimateProvider?: EstimateProvider;
}

export async function listCompanies(opts: ListOpts = {}): Promise<{ total: number; rows: CompanyRow[] }> {
  const where: string[] = ["active = 1"];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.q) {
    const p = push(`%${opts.q}%`);
    where.push(`(name ILIKE ${p} OR name_eng ILIKE ${p} OR stock_code ILIKE ${p} OR corp_code ILIKE ${p})`);
  }
  const markets = Array.isArray(opts.market) ? opts.market : opts.market ? [opts.market] : [];
  if (markets.length) where.push(`market IN (${markets.map((m) => push(m)).join(", ")})`);
  if (opts.sector) where.push(`sector_code = ${push(opts.sector)}`);
  if (opts.industry) where.push(`sector = ${push(opts.industry)}`);
  if (opts.onlyConsensus) where.push("has_consensus = 1");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const col = SORT_WHITELIST[opts.sort as SortCol] ?? "market_cap";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;
  const domesticProviderOrder = estimateProviderOrder(opts.domesticEstimateProvider ?? opts.estimateProvider ?? DEFAULT_ESTIMATE_PROVIDER);
  const globalProviderOrder = estimateProviderOrder(opts.globalEstimateProvider ?? opts.estimateProvider ?? DEFAULT_GLOBAL_ESTIMATE_PROVIDER);

  const total = Number(await value("SELECT COUNT(*)::int AS c FROM companies " + w, params));
  const domesticProviderOrderParam = push(domesticProviderOrder);
  const globalProviderOrderParam = push(globalProviderOrder);
  const rows = await all<CompanyRow>(
    `SELECT ${COMPANY_WITH_FORWARD_PER_SELECT}
     FROM companies c
     ${companyForwardPerJoins(domesticProviderOrderParam, globalProviderOrderParam)}
     ${w}
     ORDER BY ${col} ${dir} NULLS LAST LIMIT ${push(limit)} OFFSET ${push(offset)}`,
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
         r.previous_target_price AS source_previous_target_price,
         LAG(r.target_price) OVER (
           PARTITION BY r.broker_id
           ORDER BY r.report_date, r.report_id
         ) AS lag_previous_target_price
       FROM consensus_reports r
       JOIN brokers b ON b.id = r.broker_id
       WHERE r.corp_code = $1
     )
     SELECT
            broker,
            research_url,
            analyst,
            report_date,
            target_price,
            target_price_change,
            rating,
            rating_change,
            return_rate,
            price_close,
            ai_summary,
            report_id,
            COALESCE(source_previous_target_price, lag_previous_target_price) AS previous_target_price,
            CASE
              WHEN COALESCE(source_previous_target_price, lag_previous_target_price) IS NOT NULL AND target_price IS NOT NULL
              THEN target_price - COALESCE(source_previous_target_price, lag_previous_target_price)
            END AS target_delta,
            CASE
              WHEN COALESCE(source_previous_target_price, lag_previous_target_price) IS NOT NULL
               AND COALESCE(source_previous_target_price, lag_previous_target_price) <> 0
               AND target_price IS NOT NULL
              THEN ((target_price - COALESCE(source_previous_target_price, lag_previous_target_price)) * 100.0 / COALESCE(source_previous_target_price, lag_previous_target_price))::double precision
            END AS target_delta_pct
     FROM report_rows
     ORDER BY report_date DESC, broker`,
    [corpCode],
  );
}

export async function getFinancials(
  corpCode: string,
  periodType: "Q" | "A",
  estimateProvider: EstimateProvider = DEFAULT_ESTIMATE_PROVIDER,
): Promise<GrowthRow[]> {
  const providerOrder = estimateProviderOrder(estimateProvider);
  return all<GrowthRow>(
    `${rankedFinancialsCte("f.corp_code = $1 AND f.period_type = $2", "$3")}
     SELECT u.corp_code, u.metric, u.raw_label, u.fiscal_year, u.quarter, u.period_type, u.is_estimate,
            u.value, u.date_label, u.source,
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
     ORDER BY u.metric, u.fiscal_year, u.quarter`,
    [corpCode, periodType, providerOrder],
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

export async function getCompanyNews(corpCode: string, limit = 8): Promise<CompanyNewsRow[]> {
  return all<CompanyNewsRow>(
    `SELECT *
     FROM company_news
     WHERE corp_code = $1
     ORDER BY published_at DESC NULLS LAST, ingested_at DESC, id DESC
     LIMIT $2`,
    [corpCode, limit],
  );
}

export async function getRecentChanges(limit = 100, entityType?: string, changeKind?: string): Promise<ChangeRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (entityType) where.push(`c.entity_type = ${push(entityType)}`);
  if (changeKind) where.push(`c.change_kind = ${push(changeKind)}`);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  return all<ChangeRow>(
    `SELECT c.*, co.name AS corp_name FROM change_logs c
     JOIN companies co ON co.corp_code = c.corp_code
     ${w}
     ORDER BY COALESCE(c.occurred_at, c.observed_at) DESC, c.id DESC LIMIT $${params.length}`,
    params,
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
  children?: SectorChildAgg[];
}

export interface SectorChildAgg {
  sector_code: string;
  industry: string;
  label: string;
  company_count: number;
  market_cap_sum: number | null;
}

export async function listSectorAggs(): Promise<SectorAgg[]> {
  const sectors = await all<SectorAgg>("SELECT * FROM v_sector_agg ORDER BY market_cap_sum DESC NULLS LAST");
  const children = await all<SectorChildAgg>(
    `SELECT
       sector_code,
       sector AS industry,
       regexp_replace(regexp_replace(sector, ' (제조업|서비스업|사업|업)$', ''), ' 및 ', '·', 'g') AS label,
       COUNT(*)::int AS company_count,
       SUM(market_cap) AS market_cap_sum
     FROM companies
     WHERE active = 1 AND sector_code IS NOT NULL AND sector IS NOT NULL AND sector <> ''
     GROUP BY sector_code, sector
     HAVING COUNT(*) > 0
     ORDER BY sector_code, SUM(market_cap) DESC NULLS LAST, COUNT(*) DESC, sector`,
  );
  const bySector = new Map<string, SectorChildAgg[]>();
  for (const child of children) {
    const group = bySector.get(child.sector_code) ?? [];
    group.push(child);
    bySector.set(child.sector_code, group);
  }
  return sectors.map((s) => ({ ...s, children: bySector.get(s.sector_code) ?? [] }));
}

export async function getSectorAgg(code: string): Promise<SectorAgg | undefined> {
  return one<SectorAgg>("SELECT * FROM v_sector_agg WHERE sector_code = $1", [code]);
}

export async function getSectorCompanies(
  code: string,
  sort = "market_cap",
  domesticEstimateProvider: EstimateProvider = DEFAULT_ESTIMATE_PROVIDER,
  globalEstimateProvider: EstimateProvider = DEFAULT_GLOBAL_ESTIMATE_PROVIDER,
): Promise<CompanyRow[]> {
  const order = sort === "target_return_rate" ? "target_return_rate DESC" : "market_cap DESC";
  return all<CompanyRow>(
    `SELECT ${COMPANY_WITH_FORWARD_PER_SELECT}
     FROM companies c
     ${companyForwardPerJoins("$2", "$3")}
     WHERE active = 1 AND sector_code = $1
     ORDER BY ${order} NULLS LAST`,
    [code, estimateProviderOrder(domesticEstimateProvider), estimateProviderOrder(globalEstimateProvider)],
  );
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
    `SELECT * FROM companies WHERE active = 1 AND corp_code IN (${placeholders(codes)}) ORDER BY market_cap DESC NULLS LAST`,
    codes,
  );
}

export async function getStats() {
  const oneCount = (sql: string) => value<number>(sql).then((v) => Number(v ?? 0));
  return {
    companies: await oneCount("SELECT COUNT(*)::int c FROM companies WHERE active = 1"),
    withDetail: await oneCount("SELECT COUNT(*)::int c FROM companies WHERE active = 1 AND detail_ingested_at IS NOT NULL"),
    withConsensus: await oneCount("SELECT COUNT(*)::int c FROM companies WHERE active = 1 AND has_consensus = 1"),
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

const calPad = (n: number) => String(n).padStart(2, "0");

function normalizeCalendarTime(e: CalendarEventRow): CalendarEventRow {
  const title = translateCalendarTitle(e.title);
  if (!e.event_time || e.tz !== "GMT") return title === e.title ? e : { ...e, title };
  const dt = new Date(`${e.event_date}T${e.event_time}:00Z`);
  const kst = new Date(dt.getTime() + 9 * 3600_000);
  return {
    ...e,
    event_date: `${kst.getUTCFullYear()}-${calPad(kst.getUTCMonth() + 1)}-${calPad(kst.getUTCDate())}`,
    event_time: `${calPad(kst.getUTCHours())}:${calPad(kst.getUTCMinutes())}`,
    tz: "Asia/Seoul",
    title,
  };
}

function translateCalendarTitle(title: string): string {
  const t = title.trim();
  const rules: Array<[RegExp, string]> = [
    [/^FOMC Economic Projections$/i, "FOMC 경제전망"],
    [/^FOMC Press Conference$/i, "FOMC 기자회견"],
    [/^Fed Interest Rate Decision$/i, "미 연준 기준금리 결정"],
    [/^FOMC Statement$/i, "FOMC 성명서"],
    [/^Interest Rate Decision$/i, "기준금리 결정"],
    [/^BoJ Interest Rate Decision$/i, "일본은행 기준금리 결정"],
    [/^BoJ Monetary Policy Statement$/i, "일본은행 통화정책 성명서"],
    [/^BoJ Monetary Policy Meeting Minutes$/i, "일본은행 통화정책회의 의사록"],
    [/^BoJ Press Conference$/i, "일본은행 기자회견"],
    [/^Monetary Policy Meeting Minutes$/i, "통화정책회의 의사록"],
    [/^ECB Interest Rate Decision$/i, "ECB 기준금리 결정"],
    [/^National Core CPI/i, "전국 근원 소비자물가지수(Core CPI)"],
    [/^National CPI/i, "전국 소비자물가지수(CPI)"],
    [/^Tokyo Core CPI/i, "도쿄 근원 소비자물가지수(Core CPI)"],
    [/^Tokyo CPI/i, "도쿄 소비자물가지수(CPI)"],
    [/^CPI Tokyo Ex Food (?:&|and) Energy/i, "도쿄 식품·에너지 제외 소비자물가지수(CPI)"],
    [/^Core CPI Index/i, "근원 소비자물가지수(Core CPI)"],
    [/^CPI Index,\s*n\.s\.a\./i, "소비자물가지수(CPI, 비계절조정)"],
    [/^CPI Index,\s*s\.a/i, "소비자물가지수(CPI, 계절조정)"],
    [/^Cleveland CPI/i, "클리블랜드 연은 CPI"],
    [/^Core CPI/i, "근원 소비자물가지수(Core CPI)"],
    [/^CPI/i, "소비자물가지수(CPI)"],
    [/^PPI ex\. Food\/Energy\/Transport/i, "식품·에너지·운송 제외 생산자물가지수(PPI)"],
    [/^Core PPI/i, "근원 생산자물가지수(Core PPI)"],
    [/^PPI/i, "생산자물가지수(PPI)"],
    [/^Core PCE Prices/i, "근원 PCE 물가"],
    [/^PCE Prices/i, "PCE 물가"],
    [/^Dallas Fed PCE/i, "댈러스 연은 PCE"],
    [/^PCE Price Index/i, "PCE 물가지수"],
    [/^Core PCE Price Index/i, "근원 PCE 물가지수"],
    [/^Nonfarm Payrolls/i, "비농업 고용"],
    [/^Private Nonfarm Payrolls/i, "민간 비농업 고용"],
    [/^Government Payrolls/i, "정부 고용"],
    [/^Manufacturing Payrolls/i, "제조업 고용"],
    [/^U6 Unemployment Rate/i, "U6 실업률"],
    [/^Unemployment Rate/i, "실업률"],
    [/^Initial Jobless Claims/i, "신규 실업수당 청구건수"],
    [/^Continuing Jobless Claims/i, "계속 실업수당 청구건수"],
    [/^Core Retail Sales/i, "근원 소매판매"],
    [/^Retail Sales Ex Gas\/Autos/i, "주유소·자동차 제외 소매판매"],
    [/^Large Scale Retail Sales YoY/i, "대형소매점 판매(YoY)"],
    [/^Retail Sales/i, "소매판매"],
    [/^Industrial Production forecast 1m ahead/i, "산업생산 1개월 전망"],
    [/^Industrial Production forecast 2m ahead/i, "산업생산 2개월 전망"],
    [/^Industrial Production/i, "산업생산"],
    [/^Manufacturing Production/i, "제조업 생산"],
    [/^Capacity Utilization Rate/i, "설비가동률"],
    [/^Capacity Utilization/i, "설비가동률"],
    [/^Adjusted Current Account/i, "계절조정 경상수지"],
    [/^Current Account n\.s\.a\./i, "경상수지(비계절조정)"],
    [/^Current Account/i, "경상수지"],
    [/^Export Price Index/i, "수출물가지수"],
    [/^Import Price Index/i, "수입물가지수"],
    [/^Chinese Unemployment Rate/i, "중국 실업률"],
    [/^Fixed Asset Investment/i, "고정자산투자"],
    [/^Chinese Industrial Production YTD/i, "중국 산업생산(YTD)"],
    [/^Chinese Retail Sales YTD/i, "중국 소매판매(YTD)"],
    [/^ADP Employment Change Weekly/i, "ADP 주간 고용 변화"],
    [/^ADP Nonfarm Employment Change/i, "ADP 민간고용 변화"],
    [/^Average Hourly Earnings/i, "평균 시간당 임금"],
    [/^Jobless Claims 4-Week Avg\./i, "실업수당 청구 4주 평균"],
    [/^Nonfarm Productivity/i, "비농업 생산성"],
    [/^JOLTs Job Openings/i, "JOLTs 구인건수"],
    [/^Labor Force Participation Rate/i, "경제활동참가율"],
    [/^ISM Manufacturing Employment/i, "ISM 제조업 고용"],
    [/^ISM Manufacturing New Orders/i, "ISM 제조업 신규주문"],
    [/^ISM Manufacturing Prices/i, "ISM 제조업 가격"],
    [/^ISM Manufacturing PMI/i, "ISM 제조업 PMI"],
    [/^ISM Non-Manufacturing Business Activity/i, "ISM 서비스업 사업활동"],
    [/^ISM Non-Manufacturing Employment/i, "ISM 서비스업 고용"],
    [/^ISM Non-Manufacturing New Orders/i, "ISM 서비스업 신규주문"],
    [/^ISM Non-Manufacturing Prices/i, "ISM 서비스업 가격"],
    [/^ISM Non-Manufacturing PMI/i, "ISM 서비스업 PMI"],
    [/^S&P Global Manufacturing PMI/i, "S&P 글로벌 제조업 PMI"],
    [/^S&P Global Services PMI/i, "S&P 글로벌 서비스업 PMI"],
    [/^S&P Global Composite PMI/i, "S&P 글로벌 종합 PMI"],
    [/^S&P Global South Korea Manufacturing PMI/i, "S&P 글로벌 한국 제조업 PMI"],
    [/^Manufacturing & Services PMI/i, "제조업·서비스업 PMI"],
    [/^RatingDog Services PMI/i, "RatingDog 서비스업 PMI"],
    [/^RatingDog Manufacturing PMI/i, "RatingDog 제조업 PMI"],
    [/^Chinese Composite PMI/i, "중국 종합 PMI"],
    [/^Non-Manufacturing PMI/i, "비제조업 PMI"],
    [/^Chicago PMI/i, "시카고 PMI"],
    [/^Manufacturing PMI/i, "제조업 PMI"],
    [/^Services PMI/i, "서비스업 PMI"],
    [/^Composite PMI/i, "종합 PMI"],
    [/^M3 Money Supply/i, "M3 통화공급"],
    [/^M2 Money supply/i, "M2 통화공급"],
    [/^M2 Money Supply/i, "M2 통화공급"],
    [/^Adjusted Trade Balance/i, "계절조정 무역수지"],
    [/^Trade Balance/i, "무역수지"],
    [/^NFIB Small Business Optimism/i, "NFIB 중소기업 낙관지수"],
    [/^BSI Large Manufacturing Conditions/i, "BSI 대형 제조업 업황"],
    [/^NAHB Housing Market Index/i, "NAHB 주택시장지수"],
    [/^CB Employment Trends Index/i, "컨퍼런스보드 고용추세지수"],
    [/^CB Consumer Confidence/i, "컨퍼런스보드 소비자신뢰지수"],
    [/^NY Empire State Manufacturing Index/i, "뉴욕 엠파이어스테이트 제조업지수"],
    [/^Philadelphia Fed Manufacturing Index/i, "필라델피아 연은 제조업지수"],
    [/^Philly Fed Employment/i, "필라델피아 연은 고용"],
    [/^Philly Fed Business Conditions/i, "필라델피아 연은 기업환경"],
    [/^Richmond Manufacturing Index/i, "리치먼드 제조업지수"],
    [/^Richmond Manufacturing Shipments/i, "리치먼드 제조업 출하"],
    [/^KC Fed Manufacturing Index/i, "캔자스시티 연은 제조업지수"],
    [/^Dallas Fed Mfg Business Index/i, "댈러스 연은 제조업 기업지수"],
    [/^NY Fed 1-Year Consumer Inflation Expectations/i, "뉴욕 연은 1년 기대인플레이션"],
    [/^NBS Press Conference$/i, "중국 국가통계국 기자회견"],
    [/^Consumer Confidence/i, "소비자신뢰지수"],
    [/^Consumer Sentiment/i, "소비자심리지수"],
    [/^Durable Goods Orders/i, "내구재 주문"],
    [/^Core Durable Goods Orders/i, "근원 내구재 주문"],
    [/^Factory Orders ex transportation/i, "운송 제외 공장주문"],
    [/^Factory Orders/i, "공장주문"],
    [/^Housing Starts/i, "주택착공"],
    [/^Building Permits/i, "건축허가"],
    [/^Business Inventories/i, "기업재고"],
    [/^US Leading Index/i, "미국 경기선행지수"],
    [/^Leading Index/i, "경기선행지수"],
    [/^Jobs\/applications ratio/i, "유효구인배율"],
    [/^House Price Index/i, "주택가격지수"],
    [/^Tankan Big Manufacturing Outlook Index/i, "단칸 대형 제조업 전망지수"],
    [/^Tankan Small Manufacturing Index/i, "단칸 소형 제조업지수"],
    [/^Tankan Small Non-Manufacturing Index/i, "단칸 소형 비제조업지수"],
    [/^GDP Price Index/i, "GDP 물가지수"],
    [/^GDP Annualized/i, "GDP 연율"],
    [/^GDP Capital Expenditure/i, "GDP 설비투자"],
    [/^GDP External Demand/i, "GDP 대외수요"],
    [/^GDP Private Consumption/i, "GDP 민간소비"],
    [/^GDP Sales/i, "GDP 판매"],
    [/^GDP/i, "GDP"],
    [/^FOMC Member (.+) Speaks$/i, "FOMC 위원 $1 발언"],
    [/^Fed Chair (.+) Speaks$/i, "연준 의장 $1 발언"],
  ];
  for (const [re, ko] of rules) {
    if (re.test(t)) return t.replace(re, ko);
  }
  return t;
}

export async function getCalendarEvents(q: CalendarQuery = {}): Promise<CalendarEventRow[]> {
  let evs = ((await userStore.getAllCalendarEvents()) as CalendarEventRow[]).map(normalizeCalendarTime);
  if (q.from) evs = evs.filter((e) => e.event_date >= q.from!);
  if (q.to) evs = evs.filter((e) => e.event_date <= q.to!);
  if (q.categories?.length) evs = evs.filter((e) => q.categories!.includes(e.category));
  if (q.countries?.length) evs = evs.filter((e) => e.country != null && q.countries!.includes(e.country));
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
  const evs = ((await userStore.getAllCalendarEvents()) as CalendarEventRow[]).map(normalizeCalendarTime);
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
