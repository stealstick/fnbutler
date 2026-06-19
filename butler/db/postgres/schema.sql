-- ============================================================================
-- keystone PostgreSQL schema
--
-- Runtime source of truth for the Postgres database.
-- ============================================================================

CREATE TABLE IF NOT EXISTS companies (
    corp_code          TEXT PRIMARY KEY,
    stock_code         TEXT NOT NULL,
    name               TEXT NOT NULL,
    name_eng           TEXT,
    market             TEXT,
    sector             TEXT,
    sector_code        TEXT,
    sector_name        TEXT,
    industry_code      TEXT,
    is_financial       INTEGER NOT NULL DEFAULT 0,
    fs_div             TEXT,
    market_cap         BIGINT,
    price              BIGINT,
    fluctuation_rate   DOUBLE PRECISION,
    per                DOUBLE PRECISION,
    pbr                DOUBLE PRECISION,
    fper               DOUBLE PRECISION,
    eps                DOUBLE PRECISION,
    feps               DOUBLE PRECISION,
    bps                DOUBLE PRECISION,
    dps                DOUBLE PRECISION,
    dividend_yield     DOUBLE PRECISION,
    treasury_ratio     DOUBLE PRECISION,
    has_consensus      INTEGER NOT NULL DEFAULT 0,
    cover_securities   INTEGER,
    target_price_avg   BIGINT,
    target_return_rate DOUBLE PRECISION,
    detail_ingested_at TEXT,
    source             TEXT NOT NULL DEFAULT 'butler',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_stock ON companies(stock_code);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_mcap ON companies(market_cap DESC);
CREATE INDEX IF NOT EXISTS idx_companies_cover ON companies(has_consensus, market_cap DESC);

CREATE TABLE IF NOT EXISTS brokers (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    research_url TEXT
);

CREATE TABLE IF NOT EXISTS consensus_reports (
    report_id           TEXT PRIMARY KEY,
    corp_code           TEXT NOT NULL REFERENCES companies(corp_code),
    broker_id           BIGINT NOT NULL REFERENCES brokers(id),
    title               TEXT,
    analyst             TEXT,
    report_date         TEXT NOT NULL,
    rating              TEXT,
    rating_change       TEXT,
    target_price        BIGINT,
    target_price_change TEXT,
    price_close         BIGINT,
    return_rate         DOUBLE PRECISION,
    ai_summary          TEXT,
    source              TEXT NOT NULL DEFAULT 'butler',
    ingested_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_corp_date ON consensus_reports(corp_code, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_reports_broker ON consensus_reports(broker_id);

CREATE TABLE IF NOT EXISTS target_price_monthly (
    corp_code        TEXT NOT NULL REFERENCES companies(corp_code),
    month            TEXT NOT NULL,
    full_date        TEXT,
    tp_max           BIGINT,
    tp_avg           BIGINT,
    tp_min           BIGINT,
    price            BIGINT,
    cover_securities INTEGER,
    return_ratio     DOUBLE PRECISION,
    source           TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, month)
);

CREATE TABLE IF NOT EXISTS financials (
    corp_code   TEXT NOT NULL REFERENCES companies(corp_code),
    metric      TEXT NOT NULL,
    raw_label   TEXT,
    fiscal_year INTEGER NOT NULL,
    quarter     INTEGER NOT NULL,
    period_type TEXT NOT NULL CHECK (period_type IN ('Q','A')),
    value       DOUBLE PRECISION,
    is_estimate INTEGER NOT NULL DEFAULT 0,
    date_label  TEXT,
    source      TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, metric, fiscal_year, quarter, period_type, is_estimate)
);
CREATE INDEX IF NOT EXISTS idx_fin_corp_metric ON financials(corp_code, metric, fiscal_year, quarter);

CREATE TABLE IF NOT EXISTS valuations (
    corp_code   TEXT NOT NULL REFERENCES companies(corp_code),
    metric      TEXT NOT NULL,
    date_label  TEXT NOT NULL,
    fiscal_year INTEGER,
    quarter     INTEGER,
    value       DOUBLE PRECISION,
    source      TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, metric, date_label)
);

CREATE TABLE IF NOT EXISTS change_logs (
    id          BIGSERIAL PRIMARY KEY,
    corp_code   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_key  TEXT,
    field       TEXT,
    old_value   TEXT,
    new_value   TEXT,
    delta       DOUBLE PRECISION,
    delta_pct   DOUBLE PRECISION,
    change_kind TEXT,
    note        TEXT,
    source      TEXT NOT NULL DEFAULT 'butler',
    occurred_at TEXT,
    observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_corp ON change_logs(corp_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_type ON change_logs(entity_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS ingest_runs (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,
    corp_code   TEXT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    ok          INTEGER,
    note        TEXT
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
    corp_code          TEXT NOT NULL REFERENCES companies(corp_code),
    snapshot_date      TEXT NOT NULL,
    price              BIGINT,
    target_price_avg   BIGINT,
    target_return_rate DOUBLE PRECISION,
    cover_securities   INTEGER,
    per                DOUBLE PRECISION,
    pbr                DOUBLE PRECISION,
    source             TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, snapshot_date)
);

CREATE TABLE IF NOT EXISTS users (
    id               BIGSERIAL PRIMARY KEY,
    email            TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    telegram_chat_id TEXT,
    alerts_enabled   INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    corp_code  TEXT NOT NULL REFERENCES companies(corp_code),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, corp_code)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_corp ON watchlist(corp_code);

CREATE TABLE IF NOT EXISTS notifications (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    change_log_id BIGINT NOT NULL REFERENCES change_logs(id),
    channel       TEXT NOT NULL DEFAULT 'telegram',
    status        TEXT NOT NULL DEFAULT 'sent',
    sent_at       TEXT NOT NULL,
    UNIQUE (user_id, change_log_id, channel)
);

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    token      TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_prefs (
    user_id    TEXT PRIMARY KEY,
    prefs_json TEXT NOT NULL,
    feed_token TEXT UNIQUE,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calprefs_token ON calendar_prefs(feed_token);

CREATE TABLE IF NOT EXISTS calendar_events (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    subcategory TEXT,
    country     TEXT,
    event_date  TEXT NOT NULL,
    event_time  TEXT,
    tz          TEXT,
    title       TEXT NOT NULL,
    symbol      TEXT,
    importance  INTEGER NOT NULL DEFAULT 1,
    actual      TEXT,
    consensus   TEXT,
    previous    TEXT,
    market_cap  DOUBLE PRECISION,
    url         TEXT,
    note        TEXT,
    source      TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calevt_date ON calendar_events(event_date);
CREATE INDEX IF NOT EXISTS idx_calevt_cat ON calendar_events(category, event_date);
CREATE INDEX IF NOT EXISTS idx_calevt_ctry ON calendar_events(country, event_date);

CREATE OR REPLACE VIEW v_latest_broker_target AS
SELECT r.*
FROM consensus_reports r
JOIN (
    SELECT corp_code, broker_id, MAX(report_date) AS md
    FROM consensus_reports
    GROUP BY corp_code, broker_id
) t ON t.corp_code = r.corp_code AND t.broker_id = r.broker_id AND t.md = r.report_date;

CREATE OR REPLACE VIEW v_sector_agg AS
SELECT
    sector_code,
    sector_name,
    COUNT(*) AS company_count,
    SUM(CASE WHEN has_consensus=1 THEN 1 ELSE 0 END) AS covered_count,
    SUM(market_cap) AS market_cap_sum,
    ROUND(AVG(NULLIF(per,0))::numeric, 2)::double precision AS per_avg,
    ROUND(AVG(NULLIF(pbr,0))::numeric, 2)::double precision AS pbr_avg,
    ROUND(AVG(CASE WHEN has_consensus=1 THEN target_return_rate END)::numeric, 2)::double precision AS return_rate_avg,
    SUM(cover_securities) AS cover_securities_sum
FROM companies
WHERE sector_code IS NOT NULL
GROUP BY sector_code, sector_name;

CREATE OR REPLACE VIEW v_financials_growth AS
WITH ordered AS (
    SELECT
        corp_code, metric, raw_label, fiscal_year, quarter, period_type,
        is_estimate, value, date_label,
        LAG(value, 1) OVER w AS prev_q,
        LAG(value, CASE WHEN period_type='Q' THEN 4 ELSE 1 END) OVER w AS prev_y
    FROM financials
    WINDOW w AS (
        PARTITION BY corp_code, metric, period_type, is_estimate
        ORDER BY fiscal_year, quarter
    )
)
SELECT
    *,
    CASE WHEN prev_q IS NOT NULL AND prev_q <> 0
         THEN ROUND(((value - prev_q) / ABS(prev_q) * 100.0)::numeric, 1)::double precision END AS qoq_pct,
    CASE WHEN prev_y IS NOT NULL AND prev_y <> 0
         THEN ROUND(((value - prev_y) / ABS(prev_y) * 100.0)::numeric, 1)::double precision END AS yoy_pct
FROM ordered;
