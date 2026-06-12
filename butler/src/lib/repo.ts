import { getDb } from "./db";

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
  observed_at: string;
}

export function getCompany(corpCode: string): CompanyRow | undefined {
  return getDb()
    .prepare("SELECT * FROM companies WHERE corp_code = ?")
    .get(corpCode) as CompanyRow | undefined;
}

export interface ListOpts {
  q?: string;
  market?: string;
  onlyConsensus?: boolean;
  sort?: "market_cap" | "target_return_rate" | "cover_securities" | "name";
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
  if (opts.onlyConsensus) where.push("has_consensus = 1");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sortCol =
    opts.sort === "target_return_rate"
      ? "target_return_rate DESC"
      : opts.sort === "cover_securities"
        ? "cover_securities DESC"
        : opts.sort === "name"
          ? "name ASC"
          : "market_cap DESC";

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
      "SELECT * FROM change_logs WHERE corp_code = ? ORDER BY observed_at DESC, id DESC LIMIT ?",
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
         WHERE c.entity_type = ? ORDER BY c.observed_at DESC, c.id DESC LIMIT ?`,
      )
      .all(entityType, limit) as ChangeRow[];
  }
  return db
    .prepare(
      `SELECT c.*, co.name AS corp_name FROM change_logs c
       JOIN companies co ON co.corp_code = c.corp_code
       ORDER BY c.observed_at DESC, c.id DESC LIMIT ?`,
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
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN cl.change_kind='up' THEN 1 ELSE 0 END)   AS ups,
         SUM(CASE WHEN cl.change_kind='down' THEN 1 ELSE 0 END) AS downs
       FROM change_logs cl JOIN companies c ON c.corp_code = cl.corp_code
       WHERE c.sector_code = ? AND cl.entity_type='target_price' AND cl.observed_at >= ?`,
    )
    .get(code, since) as { ups: number | null; downs: number | null };
}

/* --------------------------- 관심목록 --------------------------- */
export function addWatch(userId: number, corpCode: string) {
  getDb()
    .prepare(
      "INSERT INTO watchlist (user_id, corp_code, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .run(userId, corpCode, new Date().toISOString());
}
export function removeWatch(userId: number, corpCode: string) {
  getDb().prepare("DELETE FROM watchlist WHERE user_id = ? AND corp_code = ?").run(userId, corpCode);
}
export function isWatched(userId: number, corpCode: string): boolean {
  return !!getDb()
    .prepare("SELECT 1 FROM watchlist WHERE user_id = ? AND corp_code = ?")
    .get(userId, corpCode);
}
export function getWatchlist(userId: number): CompanyRow[] {
  return getDb()
    .prepare(
      `SELECT c.* FROM watchlist w JOIN companies c ON c.corp_code = w.corp_code
       WHERE w.user_id = ? ORDER BY c.market_cap DESC NULLS LAST`,
    )
    .all(userId) as CompanyRow[];
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
