-- ============================================================================
-- fnguide 리서치 추정치 DB 스키마 (PostgreSQL 기준)
--
-- 설계 원칙
--  1. 기업별 테이블 분리(X) → 단일 팩트 테이블 + company_id FK (O)
--     기업마다 테이블을 만들면 기업 추가 시 DDL이 필요하고, 교차 조회/집계가
--     불가능해진다. "기업별 관리"는 인덱스 걸린 WHERE 절로 충분하다.
--  2. 리포트 단위 불변(immutable) 저장 + "최신값"은 뷰로 계산.
--     같은 증권사가 추정치를 수정한 새 리포트를 내면 새 report 행이 쌓이고,
--     v_latest_estimates 가 자동으로 최신 리포트를 가리킨다.
--     → 과거 추정치 변화 이력이 공짜로 남는다 (추정치 리비전 분석 가능).
--  3. 지표는 long format(행 단위) 저장.
--     업종마다 라벨이 다르다: 제조업 매출액 = 은행 순이자이익 = 보험 원수보험료.
--     canonical metric 코드로 정규화하되 raw_label 원문을 보존한다.
--  4. 멱등성: fn_rpt_id UNIQUE → 매일 크론이 같은 기간을 다시 훑어도 중복 없음.
-- ============================================================================

CREATE TABLE companies (
    id          BIGSERIAL PRIMARY KEY,
    stock_code  VARCHAR(12) NOT NULL UNIQUE,   -- '005830' (fnguide CATEGORY.VALUE)
    name        TEXT        NOT NULL,          -- 'DB손해보험'
    sector      TEXT,                          -- '손해보험' 등 (선택)
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,  -- 수집 대상 여부
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE brokers (
    id         BIGSERIAL PRIMARY KEY,
    fn_brk_cd  VARCHAR(12) UNIQUE,             -- fnguide BROKERAGE.VALUE ('24'=NH투자증권)
    name       TEXT NOT NULL UNIQUE            -- 'NH투자증권'
);

CREATE TABLE reports (
    id             BIGSERIAL PRIMARY KEY,
    fn_rpt_id      BIGINT      NOT NULL UNIQUE,    -- fnguide rptId — 멱등성 키
    company_id     BIGINT      NOT NULL REFERENCES companies(id),
    broker_id      BIGINT      NOT NULL REFERENCES brokers(id),
    title          TEXT,
    analysts       TEXT,                            -- '정준섭, 전채원'
    published_date DATE        NOT NULL,            -- ANL_DT
    recomm         TEXT,                            -- 'BUY' / 'HOLD' / '매수'
    target_price   NUMERIC(18, 2),
    page_cnt       INTEGER,
    pdf_path       TEXT,                            -- 로컬 보관 경로
    parse_status   TEXT NOT NULL DEFAULT 'pending'
                   CHECK (parse_status IN ('pending','parsed','no_table','failed')),
    parse_error    TEXT,
    raw_tables     JSONB,                           -- 파싱 원본(라벨 매핑 전) — 룰 변경 시 재적용용
    parsed_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reports_company_pub ON reports (company_id, published_date DESC);
CREATE INDEX idx_reports_broker ON reports (broker_id);

CREATE TABLE report_financials (
    id             BIGSERIAL PRIMARY KEY,
    report_id      BIGINT  NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    period_type    CHAR(1) NOT NULL CHECK (period_type IN ('A','Q')),  -- Annual/Quarter
    fiscal_year    SMALLINT NOT NULL,
    fiscal_quarter SMALLINT CHECK (fiscal_quarter BETWEEN 1 AND 4),    -- 연간이면 NULL
    period_label   TEXT    NOT NULL,            -- 원문: '2026E', '2Q26E', '2028F'
    is_estimate    BOOLEAN NOT NULL,            -- E/F 접미사 또는 미래 기간
    metric         TEXT    NOT NULL,            -- canonical: revenue/operating_profit/
                                                --   net_income/pretax_income/per/pbr/
                                                --   eps/bps/roe/dps ...
    raw_label      TEXT    NOT NULL,            -- 원문 라벨: '순이자이익', '보험손익' 등
    value          NUMERIC(20, 4) NOT NULL,
    unit           TEXT    NOT NULL,            -- KRW_100M(억원)/KRW(원)/X(배)/PCT(%)
    -- 한 리포트 안에서 같은 (기간, 지표)는 하나만 — 요약테이블(첫 등장) 우선
    CONSTRAINT uq_rf UNIQUE (report_id, period_type, fiscal_year, fiscal_quarter, metric)
);
CREATE INDEX idx_rf_metric ON report_financials (metric, fiscal_year);

-- ----------------------------------------------------------------------------
-- 최신 추정치 뷰: 기업 → 증권사별 "가장 최근 파싱 성공 리포트"의 기간별 지표 피벗.
-- UI 계층(기업 > 증권사 > 분기/연도 > 5개 지표)이 이 뷰 한 장으로 나온다.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_latest_estimates AS
WITH latest AS (
    SELECT DISTINCT ON (company_id, broker_id) id
    FROM reports
    WHERE parse_status = 'parsed'
    ORDER BY company_id, broker_id, published_date DESC, fn_rpt_id DESC
)
SELECT
    c.stock_code,
    c.name                       AS company,
    b.name                       AS broker,
    r.published_date,
    r.recomm,
    r.target_price,
    f.period_type,
    f.fiscal_year,
    f.fiscal_quarter,
    f.period_label,
    f.is_estimate,
    MAX(CASE WHEN f.metric = 'revenue'          THEN f.value END) AS revenue,
    MAX(CASE WHEN f.metric = 'operating_profit' THEN f.value END) AS operating_profit,
    MAX(CASE WHEN f.metric = 'net_income'       THEN f.value END) AS net_income,
    MAX(CASE WHEN f.metric = 'per'              THEN f.value END) AS per,
    MAX(CASE WHEN f.metric = 'pbr'              THEN f.value END) AS pbr
FROM report_financials f
JOIN reports   r ON r.id = f.report_id AND r.id IN (SELECT id FROM latest)
JOIN companies c ON c.id = r.company_id
JOIN brokers   b ON b.id = r.broker_id
GROUP BY c.stock_code, c.name, b.name, r.published_date, r.recomm, r.target_price,
         f.period_type, f.fiscal_year, f.fiscal_quarter, f.period_label, f.is_estimate
ORDER BY c.stock_code, b.name, f.period_type, f.fiscal_year, f.fiscal_quarter NULLS FIRST;
