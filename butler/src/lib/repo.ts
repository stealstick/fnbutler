import { getDb } from "./db";
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

export function getCompany(corpCode: string): CompanyRow | undefined {
  return getDb()
    .prepare("SELECT * FROM companies WHERE corp_code = ?")
    .get(corpCode) as CompanyRow | undefined;
}

/** 여러 기업을 corp_code 로 한 번에 조회 (기업 비교). 입력한 codes 순서를 보존한다. */
export function getCompaniesByCodes(codes: string[]): CompanyRow[] {
  if (codes.length === 0) return [];
  const ph = codes.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM companies WHERE corp_code IN (${ph})`)
    .all(...codes) as CompanyRow[];
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

/**
 * 기업 비교용 재무 성장률. v_financials_growth 와 달리 실적(is_estimate=0)과
 * 추정치(=1)를 **한 시계열로 합쳐** QoQ/YoY 를 계산한다 → 실적→추정 경계를 넘어
 * "이번분기→다음분기(E)", "전년→올해(E)", "올해(E)→다음년도(E)" 증감률이 나온다.
 * 같은 (연,분기)에 실적·추정이 둘 다 있으면 실적을 택한다(realized 우선).
 */
export function getCompareGrowth(codes: string[]): CompareGrowthRow[] {
  if (codes.length === 0) return [];
  const ph = codes.map(() => "?").join(",");
  return getDb()
    .prepare(
      // 달력 기준 매칭(위치 기반 LAG 금지): 시계열에 공백이 있어도 직전 분기/전년
      // 동분기가 실제로 존재할 때만 증감률을 계산한다. 없으면 NULL → 화면에 '-'.
      `WITH picked AS (
         SELECT corp_code, metric, period_type, fiscal_year, quarter, value, is_estimate,
                ROW_NUMBER() OVER (
                  PARTITION BY corp_code, metric, period_type, fiscal_year, quarter
                  ORDER BY is_estimate ASC
                ) AS rn
         FROM financials
         WHERE corp_code IN (${ph}) AND value IS NOT NULL
       ),
       u AS (SELECT * FROM picked WHERE rn = 1)
       SELECT u.corp_code, u.metric, u.period_type, u.fiscal_year, u.quarter, u.value, u.is_estimate,
              CASE WHEN u.period_type = 'Q' THEN (
                SELECT CASE WHEN p.value <> 0
                            THEN ROUND((u.value - p.value) / ABS(p.value) * 100.0, 1) END
                FROM u p
                WHERE p.corp_code = u.corp_code AND p.metric = u.metric AND p.period_type = 'Q'
                  AND ((u.quarter > 1 AND p.fiscal_year = u.fiscal_year     AND p.quarter = u.quarter - 1)
                    OR (u.quarter = 1 AND p.fiscal_year = u.fiscal_year - 1 AND p.quarter = 4))
              ) END AS qoq_pct,
              (
                SELECT CASE WHEN p.value <> 0
                            THEN ROUND((u.value - p.value) / ABS(p.value) * 100.0, 1) END
                FROM u p
                WHERE p.corp_code = u.corp_code AND p.metric = u.metric
                  AND p.period_type = u.period_type AND p.fiscal_year = u.fiscal_year - 1
                  AND (u.period_type = 'A' OR p.quarter = u.quarter)
              ) AS yoy_pct
       FROM u
       ORDER BY u.corp_code, u.metric, u.period_type, u.fiscal_year, u.quarter`,
    )
    .all(...codes) as CompareGrowthRow[];
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

// 정렬 허용 컬럼 화이트리스트 (SQL 인젝션 방지)
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

export function listCompanies(opts: ListOpts = {}): { total: number; rows: CompanyRow[] } {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.q) {
    where.push("(name LIKE @q OR stock_code LIKE @q OR corp_code LIKE @q)");
    params.q = `%${opts.q}%`;
  }
  if (opts.market) {
    where.push("market = @market");
    params.market = opts.market;
  }
  if (opts.sector) {
    where.push("sector_code = @sector");
    params.sector = opts.sector;
  }
  if (opts.onlyConsensus) where.push("has_consensus = 1");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const col = SORT_WHITELIST[opts.sort as SortCol] ?? "market_cap";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const sortCol = `${col} ${dir}`;

  const total = (
    db.prepare(`SELECT COUNT(*) c FROM companies ${w}`).get(params) as { c: number }
  ).c;
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT * FROM companies ${w} ORDER BY ${sortCol} NULLS LAST LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as CompanyRow[];
  return { total, rows };
}

/** 증권사별 "최신" 목표주가 (각 증권사의 가장 최근 리포트). 목표가 내림차순. */
export function getBrokerTargets(corpCode: string): BrokerTarget[] {
  return getDb()
    .prepare(
      `SELECT b.name AS broker, b.research_url, v.analyst, v.report_date, v.target_price,
              v.target_price_change, v.rating, v.rating_change, v.return_rate,
              v.price_close, v.ai_summary, v.report_id
       FROM v_latest_broker_target v JOIN brokers b ON b.id = v.broker_id
       WHERE v.corp_code = ?
       ORDER BY v.target_price DESC NULLS LAST, v.report_date DESC`,
    )
    .all(corpCode) as BrokerTarget[];
}

/** 한 증권사의 목표주가 변경 이력(전체 리포트). */
export function getBrokerHistory(corpCode: string): Array<BrokerTarget> {
  return getDb()
    .prepare(
      `SELECT b.name AS broker, b.research_url, r.analyst, r.report_date, r.target_price,
              r.target_price_change, r.rating, r.rating_change, r.return_rate,
              r.price_close, r.ai_summary, r.report_id
       FROM consensus_reports r JOIN brokers b ON b.id = r.broker_id
       WHERE r.corp_code = ?
       ORDER BY r.report_date DESC, b.name`,
    )
    .all(corpCode) as BrokerTarget[];
}

/** 증권사별 목표주가 전체 히스토리. 직전 리포트 대비 변화율을 같이 계산한다. */
export function getBrokerTargetHistory(corpCode: string): BrokerTargetHistory[] {
  return getDb()
    .prepare(
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
         WHERE r.corp_code = ?
       )
       SELECT *,
              CASE
                WHEN previous_target_price IS NOT NULL AND target_price IS NOT NULL
                THEN target_price - previous_target_price
              END AS target_delta,
              CASE
                WHEN previous_target_price IS NOT NULL AND previous_target_price != 0 AND target_price IS NOT NULL
                THEN (target_price - previous_target_price) * 100.0 / previous_target_price
              END AS target_delta_pct
       FROM report_rows
       ORDER BY report_date DESC, broker`,
    )
    .all(corpCode) as BrokerTargetHistory[];
}

/** 재무 (QoQ/YoY 포함). periodType: 'Q' 분기 | 'A' 연간. 실적+추정 모두. */
export function getFinancials(corpCode: string, periodType: "Q" | "A"): GrowthRow[] {
  return getDb()
    .prepare(
      `SELECT metric, raw_label, fiscal_year, quarter, period_type, is_estimate,
              value, date_label, qoq_pct, yoy_pct
       FROM v_financials_growth
       WHERE corp_code = ? AND period_type = ?
       ORDER BY metric, fiscal_year, quarter`,
    )
    .all(corpCode, periodType) as GrowthRow[];
}

export function getValuationSeries(corpCode: string): Array<{
  metric: string;
  date_label: string;
  value: number;
}> {
  return getDb()
    .prepare(
      "SELECT metric, date_label, value FROM valuations WHERE corp_code = ? ORDER BY date_label",
    )
    .all(corpCode) as Array<{ metric: string; date_label: string; value: number }>;
}

export function getTargetMonthly(corpCode: string): Array<{
  month: string;
  full_date: string | null;
  tp_max: number | null;
  tp_avg: number | null;
  tp_min: number | null;
  price: number | null;
  cover_securities: number | null;
}> {
  return getDb()
    .prepare(
      `SELECT month, full_date, tp_max, tp_avg, tp_min, price, cover_securities
       FROM target_price_monthly WHERE corp_code = ? ORDER BY month`,
    )
    .all(corpCode) as any;
}

export function getChanges(corpCode: string, limit = 100): ChangeRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM change_logs WHERE corp_code = ?
       ORDER BY COALESCE(occurred_at, observed_at) DESC, id DESC LIMIT ?`,
    )
    .all(corpCode, limit) as ChangeRow[];
}

export function getRecentChanges(limit = 100, entityType?: string): ChangeRow[] {
  const db = getDb();
  if (entityType) {
    return db
      .prepare(
        `SELECT c.*, co.name AS corp_name FROM change_logs c
         JOIN companies co ON co.corp_code = c.corp_code
         WHERE c.entity_type = ?
         ORDER BY COALESCE(c.occurred_at, c.observed_at) DESC, c.id DESC LIMIT ?`,
      )
      .all(entityType, limit) as ChangeRow[];
  }
  return db
    .prepare(
      `SELECT c.*, co.name AS corp_name FROM change_logs c
       JOIN companies co ON co.corp_code = c.corp_code
       ORDER BY COALESCE(c.occurred_at, c.observed_at) DESC, c.id DESC LIMIT ?`,
    )
    .all(limit) as ChangeRow[];
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

export function listSectorAggs(): SectorAgg[] {
  return getDb()
    .prepare("SELECT * FROM v_sector_agg ORDER BY market_cap_sum DESC NULLS LAST")
    .all() as SectorAgg[];
}

export function getSectorAgg(code: string): SectorAgg | undefined {
  return getDb()
    .prepare("SELECT * FROM v_sector_agg WHERE sector_code = ?")
    .get(code) as SectorAgg | undefined;
}

export function getSectorCompanies(code: string, sort = "market_cap"): CompanyRow[] {
  const order =
    sort === "target_return_rate" ? "target_return_rate DESC" : "market_cap DESC";
  return getDb()
    .prepare(`SELECT * FROM companies WHERE sector_code = ? ORDER BY ${order} NULLS LAST`)
    .all(code) as CompanyRow[];
}

/** 섹터 내 증권사별 목표가 상향/하향 카운트 (최근 N일). */
export function getSectorMomentum(code: string, days = 90) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN cl.change_kind='up' THEN 1 ELSE 0 END)   AS ups,
         SUM(CASE WHEN cl.change_kind='down' THEN 1 ELSE 0 END) AS downs
       FROM change_logs cl JOIN companies c ON c.corp_code = cl.corp_code
       WHERE c.sector_code = ? AND cl.entity_type='target_price'
         AND COALESCE(cl.occurred_at, cl.observed_at) >= ?`,
    )
    .get(code, since) as { ups: number | null; downs: number | null };
}

/* --------------------------- 관심목록 --------------------------- */
/** 관심목록 보유 corpCode(userStore)로 companies(SQLite) 조회 → 시총순. */
export async function getWatchlistCompanies(userId: string): Promise<CompanyRow[]> {
  const codes = await userStore.listWatchCorpCodes(userId);
  if (codes.length === 0) return [];
  const ph = codes.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM companies WHERE corp_code IN (${ph}) ORDER BY market_cap DESC NULLS LAST`)
    .all(...codes) as CompanyRow[];
}

export function getStats() {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    companies: one("SELECT COUNT(*) c FROM companies"),
    withDetail: one("SELECT COUNT(*) c FROM companies WHERE detail_ingested_at IS NOT NULL"),
    withConsensus: one("SELECT COUNT(*) c FROM companies WHERE has_consensus = 1"),
    brokers: one("SELECT COUNT(*) c FROM brokers"),
    reports: one("SELECT COUNT(*) c FROM consensus_reports"),
    financialRows: one("SELECT COUNT(*) c FROM financials"),
    changes: one("SELECT COUNT(*) c FROM change_logs"),
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
  from?: string; // YYYY-MM-DD (포함)
  to?: string; // YYYY-MM-DD (포함)
  categories?: string[]; // macro / earnings_intl / earnings_kr
  countries?: string[]; // US/CN/JP/KR
  minImportance?: number;
}

// 같은 날짜 내 표시 우선순위: 통화정책(0) > 그 외 거시(1) > 실적(2).
const dispRank = (e: CalendarEventRow) =>
  e.category === "macro" ? (e.subcategory === "central_bank" ? 0 : 1) : 2;

/** 캘린더 이벤트 조회 (날짜·카테고리·국가·중요도 필터). userStore(Firestore/SQLite)에서 읽어 메모리 필터/정렬. */
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

/** 캘린더 적재 현황. */
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
