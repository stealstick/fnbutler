-- ============================================================================
-- Legacy SQLite schema kept only as the migration source/reference for
-- scripts/migrate-sqlite-to-postgres.ts. Runtime schema lives in
-- db/postgres/schema.sql.
--
-- 설계 원칙 (fnguide 본 프로젝트 schema.sql 의 철학을 그대로 계승)
--  1. 기업별 테이블 분리(X) → 단일 팩트 테이블 + corp_code FK (O).
--     "기업별 관리"는 인덱스 걸린 WHERE 로 충분. 교차 집계가 가능해진다.
--  2. 컨센서스 리포트는 불변(immutable) + 멱등 저장. 같은 증권사가 추정치를
--     수정한 새 리포트를 내면 새 행이 쌓이고, "최신값"은 뷰로 계산한다.
--     → 증권사별 목표주가 리비전 이력이 공짜로 남는다.
--  3. 지표는 long format(행 단위). 업종마다 라벨이 다르다:
--     제조업 매출액 = 은행 순이자이익, 영업이익 = 증권 총영업이익.
--     canonical metric 코드로 정규화하되 raw_label 원문을 보존한다.
--  4. 멱등성: PK / UNIQUE 로 매일 다시 훑어도 중복 없음 (UPSERT).
--  5. 모든 외부 유래 데이터는 source='butler' 로 출처를 박는다.
--  6. 변경 이력(change_logs): 재수집 시 직전 스냅샷과 diff → 무엇이
--     언제 어떻게 바뀌었는지(목표주가 상향/하향, 새 분기 실적 등) 기록.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 기업 마스터 — 스크리너(POST /api/screener/screen, filters:[])로 전종목 2555개
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
    corp_code          TEXT PRIMARY KEY,            -- DART 고유번호 8자리 (butler corpCode)
    stock_code         TEXT NOT NULL,               -- '005930'
    name               TEXT NOT NULL,               -- '삼성전자'
    name_eng           TEXT,
    market             TEXT,                         -- 'KOSPI' | 'KOSDAQ' (corpCls Y/K 에서 유도)
    sector             TEXT,                         -- 업종명 원문 (codeNameKR)
    sector_code        TEXT,                         -- 광역 섹터 슬러그 (sectors.ts)
    sector_name        TEXT,                         -- 광역 섹터 표시명
    industry_code      TEXT,                         -- 표준산업분류 코드(KSIC)
    is_financial       INTEGER NOT NULL DEFAULT 0,   -- 1이면 매출→순이자이익 라벨 치환
    fs_div             TEXT,                         -- 'CFS'(연결) | 'OFS'(별도)
    -- 시세/밸류 스냅샷 (companies/{corpCode}.priceInfo) — 최신값만 유지
    market_cap         INTEGER,
    price              INTEGER,
    fluctuation_rate   REAL,
    per                REAL,
    pbr                REAL,
    fper               REAL,                         -- forward PER (선행 PER)
    eps                REAL,
    feps               REAL,
    bps                REAL,
    dps                REAL,
    dividend_yield     REAL,
    treasury_ratio     REAL,
    has_consensus      INTEGER NOT NULL DEFAULT 0,   -- 애널리스트 커버리지 존재 여부
    cover_securities   INTEGER,                      -- 커버 증권사 수 (target-prices.tables)
    target_price_avg   INTEGER,                      -- 평균 목표주가 (최신)
    target_return_rate REAL,                         -- 평균 목표가 기준 상승여력 %
    detail_ingested_at TEXT,                         -- 상세(재무/컨센서스) 수집 시각 (NULL=목록만)
    source             TEXT NOT NULL DEFAULT 'butler',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_stock   ON companies(stock_code);
CREATE INDEX IF NOT EXISTS idx_companies_name    ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_mcap    ON companies(market_cap DESC);
CREATE INDEX IF NOT EXISTS idx_companies_cover   ON companies(has_consensus, market_cap DESC);

-- ----------------------------------------------------------------------------
-- 증권사 마스터
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brokers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,              -- '신한투자증권'
    research_url TEXT                                -- 리서치 포털 랜딩 (securitiesCompanyUrl)
);

-- ----------------------------------------------------------------------------
-- 컨센서스 리포트 — 리포트 1건 = 증권사 1곳의 한 시점 목표주가/투자의견
-- 불변 저장 (report_id 멱등). "증권사별로 어떻게 기대주가를 했는지"의 원천.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consensus_reports (
    report_id           TEXT PRIMARY KEY,           -- butler /consensus/reports/{id}
    corp_code           TEXT NOT NULL REFERENCES companies(corp_code),
    broker_id           INTEGER NOT NULL REFERENCES brokers(id),
    title               TEXT,
    analyst             TEXT,                        -- '오강호' / '리서치센터'
    report_date         TEXT NOT NULL,               -- 'YYYY-MM-DD'
    rating              TEXT,                        -- '매수 (BUY)'
    rating_change       TEXT,                        -- '유지' | '상향' | '하향'
    target_price        INTEGER,                     -- 목표주가
    target_price_change TEXT,                        -- '유지' | '상향' | '하향'
    price_close         INTEGER,                     -- 리포트 시점 종가
    return_rate         REAL,                        -- 목표가 대비 상승여력 % (butler 제공)
    ai_summary          TEXT,                        -- 리포트 AI 요약 (butler 생성)
    source              TEXT NOT NULL DEFAULT 'butler',
    ingested_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_corp_date ON consensus_reports(corp_code, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_reports_broker    ON consensus_reports(broker_id);

-- ----------------------------------------------------------------------------
-- 월별 목표주가 집계 스냅샷 — GET /api/consensus/target-prices.charts.targetPrices
-- (증권사 전체의 월말 min/avg/max 와 커버 수)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS target_price_monthly (
    corp_code        TEXT NOT NULL REFERENCES companies(corp_code),
    month            TEXT NOT NULL,                  -- '25.07'
    full_date        TEXT,                           -- '2025.07.31'
    tp_max           INTEGER,
    tp_avg           INTEGER,
    tp_min           INTEGER,
    price            INTEGER,                         -- 월말 주가
    cover_securities INTEGER,
    return_ratio     REAL,
    source           TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, month)
);

-- ----------------------------------------------------------------------------
-- 재무 팩트 (long format) — 매출액/영업이익/당기순이익 등 분기·연간 시계열
-- GET /api/v2/analysis/summary/{corpCode}.fs.* (실적) + .consensus.* (추정치)
-- metric(canonical): REVENUE / OPERATING_PROFIT / NET_INCOME / GROSS_PROFIT ...
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financials (
    corp_code   TEXT NOT NULL REFERENCES companies(corp_code),
    metric      TEXT NOT NULL,                       -- canonical 코드
    raw_label   TEXT,                                -- 업종별 원문 라벨 ('매출액'/'순이자이익')
    fiscal_year INTEGER NOT NULL,
    quarter     INTEGER NOT NULL,                    -- 1..4 (분기), 0 = 연간/누적
    period_type TEXT NOT NULL CHECK (period_type IN ('Q','A')),  -- Quarter / Annual(accumulated)
    value       REAL,
    is_estimate INTEGER NOT NULL DEFAULT 0,          -- 1=컨센서스 추정치, 0=실적
    date_label  TEXT,                                -- '17.03'
    source      TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, metric, fiscal_year, quarter, period_type, is_estimate)
);
CREATE INDEX IF NOT EXISTS idx_fin_corp_metric ON financials(corp_code, metric, fiscal_year, quarter);

-- ----------------------------------------------------------------------------
-- 밸류에이션 시계열 — PER / PBR (분기) GET .../summary.valuations.{valPER,valPBR}.data
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS valuations (
    corp_code  TEXT NOT NULL REFERENCES companies(corp_code),
    metric     TEXT NOT NULL,                        -- 'PER' | 'PBR'
    date_label TEXT NOT NULL,                        -- '17.03'
    fiscal_year INTEGER,
    quarter    INTEGER,
    value      REAL,
    source     TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, metric, date_label)
);

-- ----------------------------------------------------------------------------
-- 변경 이력 — 재수집 시 직전 상태와 비교해 바뀐 것만 기록.
-- entity_type: 'target_price'(증권사별) | 'consensus_avg' | 'financial' |
--              'valuation' | 'price' | 'report'(신규 리포트)
-- change_kind: 'new' | 'up' | 'down' | 'revised' | 'qoq' | 'yoy'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    corp_code   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_key  TEXT,                                -- 증권사명 / metric+period 등
    field       TEXT,
    old_value   TEXT,
    new_value   TEXT,
    delta       REAL,                                -- 수치 변화량 (가능 시)
    delta_pct   REAL,                                -- 변화율 % (가능 시)
    change_kind TEXT,
    note        TEXT,
    source      TEXT NOT NULL DEFAULT 'butler',
    occurred_at TEXT,                                -- 실제 발생일(리포트일/분기말) — 원본 기준
    observed_at TEXT NOT NULL                         -- 우리가 수집/감지한 시각
);
CREATE INDEX IF NOT EXISTS idx_changes_corp ON change_logs(corp_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_type ON change_logs(entity_type, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- 수집 실행 로그 — 멱등 재실행 추적
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,                       -- 'companies' | 'detail'
    corp_code   TEXT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    ok          INTEGER,
    note        TEXT
);

-- ----------------------------------------------------------------------------
-- 일별 스냅샷 — 매일 폴링이 기업별 핵심 지표를 하루 1행 기록(추이/일변동 분석)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_snapshots (
    corp_code          TEXT NOT NULL REFERENCES companies(corp_code),
    snapshot_date      TEXT NOT NULL,                -- 'YYYY-MM-DD'
    price              INTEGER,
    target_price_avg   INTEGER,
    target_return_rate REAL,
    cover_securities   INTEGER,
    per                REAL,
    pbr                REAL,
    source             TEXT NOT NULL DEFAULT 'butler',
    PRIMARY KEY (corp_code, snapshot_date)
);

-- ----------------------------------------------------------------------------
-- 사용자 / 세션 / 관심목록 / 알림 (로그인 + 즐겨찾기 + 텔레그램)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    email            TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,                  -- scrypt: salt:hash
    telegram_chat_id TEXT,                           -- 텔레그램 알림 수신용
    alerts_enabled   INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    corp_code  TEXT NOT NULL REFERENCES companies(corp_code),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, corp_code)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_corp ON watchlist(corp_code);

-- 알림 발송 기록 (멱등: 같은 변경을 같은 유저에게 두 번 안 쏨)
CREATE TABLE IF NOT EXISTS notifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    change_log_id INTEGER NOT NULL REFERENCES change_logs(id),
    channel       TEXT NOT NULL DEFAULT 'telegram',
    status        TEXT NOT NULL DEFAULT 'sent',      -- 'sent' | 'failed'
    sent_at       TEXT NOT NULL,
    UNIQUE (user_id, change_log_id, channel)
);

-- 텔레그램 자동 연결용 일회성 토큰. /settings 에서 발급 → 봇 딥링크(/start <token>)로 소비.
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 계정별 캘린더 필터 저장 + 개인 구독 피드 토큰.
--   prefs_json: {categories:[], countries:[], minImportance:int, subcategories:[]}
--   feed_token: 개인 ICS 구독 URL(/api/calendar/ics?u=<token>)용 불투명 토큰.
-- (prod 는 Firestore 의 calendar_prefs 컬렉션 사용 — 이 테이블은 레거시 SQLite 폴백)
CREATE TABLE IF NOT EXISTS calendar_prefs (
    user_id    TEXT PRIMARY KEY,
    prefs_json TEXT NOT NULL,
    feed_token TEXT UNIQUE,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calprefs_token ON calendar_prefs(feed_token);

-- ----------------------------------------------------------------------------
-- 경제/실적 캘린더 — FOMC·BOJ·한국은행 금리결정, 미국 CPI/PPI/고용/소매,
--   중국 경기·물가·소비 지표(거시), 해외 실적발표(시총 상위), 국내 실적발표.
-- 출처별(source) 멱등 적재. id 는 (category|country|date|title|symbol) 결정적 해시.
--   재수집 시 actual/consensus/previous 가 채워지면 UPSERT 로 갱신된다.
-- category   : 'macro' | 'earnings_intl' | 'earnings_kr'
-- subcategory: 거시 = 'central_bank'|'inflation'|'employment'|'activity'|'other'
-- country    : 'US' | 'CN' | 'JP' | 'KR' | 'EZ' (ISO 유사 슬러그)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    subcategory TEXT,
    country     TEXT,
    event_date  TEXT NOT NULL,                 -- 'YYYY-MM-DD'
    event_time  TEXT,                           -- 'HH:MM' (tz 기준) | NULL=종일
    tz          TEXT,                           -- 'GMT' 등
    title       TEXT NOT NULL,                  -- 지표명 / 기업명
    symbol      TEXT,                           -- 티커(실적) / 종목코드
    importance  INTEGER NOT NULL DEFAULT 1,     -- 1..3 (3=최상)
    actual      TEXT,
    consensus   TEXT,
    previous    TEXT,
    market_cap  REAL,                           -- 실적 랭킹용(원/USD)
    url         TEXT,                           -- 상세 링크(선택)
    note        TEXT,
    source      TEXT NOT NULL,                  -- 'nasdaq' | 'dart' | ...
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calevt_date ON calendar_events(event_date);
CREATE INDEX IF NOT EXISTS idx_calevt_cat  ON calendar_events(category, event_date);
CREATE INDEX IF NOT EXISTS idx_calevt_ctry ON calendar_events(country, event_date);

-- ============================================================================
-- 뷰: "최신값"과 파생지표(QoQ/YoY)는 저장하지 않고 계산한다.
-- ============================================================================

-- 증권사별 최신 리포트 (각 증권사의 가장 최근 목표주가) — 기업뷰 증권사 비교표
CREATE VIEW IF NOT EXISTS v_latest_broker_target AS
SELECT r.*
FROM consensus_reports r
JOIN (
    SELECT corp_code, broker_id, MAX(report_date) AS md
    FROM consensus_reports
    GROUP BY corp_code, broker_id
) t ON t.corp_code = r.corp_code AND t.broker_id = r.broker_id AND t.md = r.report_date;

-- 재무 QoQ / YoY (분기 실적 기준). 윈도우 함수로 직전분기/전년동기 대비 증감률.
--  QoQ: 직전 분기 대비 (LAG 1)
--  YoY: 전년 동기 대비 (분기는 LAG 4, 연간은 LAG 1)
-- 섹터별 집계 (기업뷰/섹터뷰 공용). 컨센서스 보유 기업의 평균 상승여력 등.
CREATE VIEW IF NOT EXISTS v_sector_agg AS
SELECT
    sector_code,
    sector_name,
    COUNT(*)                                   AS company_count,
    SUM(CASE WHEN has_consensus=1 THEN 1 ELSE 0 END) AS covered_count,
    SUM(market_cap)                            AS market_cap_sum,
    ROUND(AVG(NULLIF(per,0)), 2)               AS per_avg,
    ROUND(AVG(NULLIF(pbr,0)), 2)               AS pbr_avg,
    ROUND(AVG(CASE WHEN has_consensus=1 THEN target_return_rate END), 2) AS return_rate_avg,
    SUM(cover_securities)                       AS cover_securities_sum
FROM companies
WHERE sector_code IS NOT NULL
GROUP BY sector_code, sector_name;

CREATE VIEW IF NOT EXISTS v_financials_growth AS
WITH ordered AS (
    SELECT
        corp_code, metric, raw_label, fiscal_year, quarter, period_type,
        is_estimate, value, date_label,
        LAG(value, 1) OVER w  AS prev_q,
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
         THEN ROUND((value - prev_q) / ABS(prev_q) * 100.0, 1) END AS qoq_pct,
    CASE WHEN prev_y IS NOT NULL AND prev_y <> 0
         THEN ROUND((value - prev_y) / ABS(prev_y) * 100.0, 1) END AS yoy_pct
FROM ordered;
