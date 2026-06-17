import type Database from "better-sqlite3";
import { butler, type ScreenRow, type CompanyDetail } from "./butler";
import { nowIso } from "./db";
import { parseDateLabel } from "./format";
import { classifySector } from "./sectors";

/**
 * industry_code 가 이미 있는 기업의 sector_code/sector_name 를 로컬에서 재분류한다
 * (API 호출 없음). 섹터 분류 규칙을 바꾼 뒤 일괄 적용할 때 사용.
 */
export function reclassifySectors(db: Database.Database): number {
  const rows = db
    .prepare("SELECT corp_code, industry_code, sector FROM companies")
    .all() as Array<{ corp_code: string; industry_code: string | null; sector: string | null }>;
  const upd = db.prepare(
    "UPDATE companies SET sector_code = ?, sector_name = ? WHERE corp_code = ?",
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      const s = classifySector(r.industry_code, r.sector);
      upd.run(s.code, s.name, r.corp_code);
    }
  });
  tx();
  return rows.length;
}

/* ---------------------------------------------------------------------------
 * 공통 헬퍼
 * ------------------------------------------------------------------------- */

function normalizeDate(s: string): string {
  // '2026.06.12' | '2026-6-12' → '2026-06-12'
  const m = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function isFinancialSector(industryCode?: string): boolean {
  if (!industryCode) return false;
  return /^6[456]/.test(industryCode); // 64 금융, 65 보험, 66 금융보조
}

function marketFromCls(cls?: string): string {
  return cls === "Y" ? "KOSPI" : cls === "K" ? "KOSDAQ" : (cls ?? "");
}

interface ChangeRow {
  corp_code: string;
  entity_type: string;
  entity_key?: string;
  field?: string;
  old_value?: string | number | null;
  new_value?: string | number | null;
  delta?: number | null;
  delta_pct?: number | null;
  change_kind?: string;
  note?: string;
  occurred_at?: string; // 실제 발생일 (리포트일/분기말). 없으면 관측일.
}

export function logChange(db: Database.Database, c: ChangeRow) {
  const observed = nowIso();
  db.prepare(
    `INSERT INTO change_logs
       (corp_code, entity_type, entity_key, field, old_value, new_value,
        delta, delta_pct, change_kind, note, source, occurred_at, observed_at)
     VALUES (@corp_code, @entity_type, @entity_key, @field, @old_value, @new_value,
        @delta, @delta_pct, @change_kind, @note, 'butler', @occurred_at, @observed_at)`,
  ).run({
    entity_key: c.entity_key ?? null,
    field: c.field ?? null,
    delta: c.delta ?? null,
    delta_pct: c.delta_pct ?? null,
    change_kind: c.change_kind ?? null,
    note: c.note ?? null,
    corp_code: c.corp_code,
    entity_type: c.entity_type,
    old_value: c.old_value == null ? null : String(c.old_value),
    new_value: c.new_value == null ? null : String(c.new_value),
    occurred_at: c.occurred_at ?? observed.slice(0, 10),
    observed_at: observed,
  });
}

/** 분기/연도 → 분기말 날짜 (실적 변경의 발생일). quarter 0 = 연간. */
export function periodEndDate(year: number, quarter: number): string {
  if (!quarter) return `${year}-12-31`;
  const md = ["03-31", "06-30", "09-30", "12-31"][quarter - 1] ?? "12-31";
  return `${year}-${md}`;
}

function getBrokerId(db: Database.Database, name: string, url?: string): number {
  const existing = db
    .prepare("SELECT id, research_url FROM brokers WHERE name = ?")
    .get(name) as { id: number; research_url: string | null } | undefined;
  if (existing) {
    if (url && !existing.research_url)
      db.prepare("UPDATE brokers SET research_url = ? WHERE id = ?").run(url, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO brokers (name, research_url) VALUES (?, ?)")
    .run(name, url ?? null);
  return Number(info.lastInsertRowid);
}

/* ---------------------------------------------------------------------------
 * 1) 기업 목록 — 스크리너로 전종목 enumerate
 * ------------------------------------------------------------------------- */

export async function ingestCompanies(
  db: Database.Database,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<{ total: number; upserted: number }> {
  const { count } = await butler.screenerCount([]);
  const size = 50;
  const pages = Math.ceil(count / size);
  let upserted = 0;
  const now = nowIso();

  for (let page = 1; page <= pages; page++) {
    const { results } = await butler.screen(page, size);
    const tx = db.transaction((rows: ScreenRow[]) => {
      for (const r of rows) upsertCompanyFromScreen(db, r, now);
    });
    tx(results);
    upserted += results.length;
    opts.onProgress?.(Math.min(upserted, count), count);
    if (results.length === 0) break;
  }
  return { total: count, upserted };
}

export function upsertCompanyFromScreen(db: Database.Database, r: ScreenRow, now: string) {
  const marketCap = r.marketCap ? Number(r.marketCap) : null;
  const existing = db
    .prepare("SELECT corp_code, target_price_avg FROM companies WHERE corp_code = ?")
    .get(r.corpCode) as { corp_code: string } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO companies
         (corp_code, stock_code, name, market_cap, price, fluctuation_rate,
          source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'butler', ?, ?)`,
    ).run(
      r.corpCode,
      r.stockCode,
      r.stockName,
      marketCap,
      r.price ?? null,
      r.fluctuationRate ? Number(r.fluctuationRate) : null,
      now,
      now,
    );
  } else {
    db.prepare(
      `UPDATE companies
         SET stock_code = ?, name = ?, market_cap = ?, price = ?,
             fluctuation_rate = ?, updated_at = ?
       WHERE corp_code = ?`,
    ).run(
      r.stockCode,
      r.stockName,
      marketCap,
      r.price ?? null,
      r.fluctuationRate ? Number(r.fluctuationRate) : null,
      now,
      r.corpCode,
    );
  }
}

/* ---------------------------------------------------------------------------
 * 2) 기업 상세 — 시세/재무/밸류/컨센서스 + 변경 감지
 * ------------------------------------------------------------------------- */

export async function ingestDetail(
  db: Database.Database,
  corpCode: string,
  opts: { feedPages?: number } = {},
): Promise<{ corpCode: string; reports: number; quarters: number; changes: number }> {
  const feedPages = opts.feedPages ?? 6;
  const now = nowIso();
  const changesBefore = (
    db.prepare("SELECT COUNT(*) c FROM change_logs WHERE corp_code = ?").get(corpCode) as {
      c: number;
    }
  ).c;

  // -- 2a) 기업 상세 (시세/PER/PBR) -----------------------------------------
  const detail = await butler.company(corpCode);
  upsertCompanyDetail(db, detail, now);

  // -- 2b) 목표주가 집계 (월별 + 요약 테이블) -------------------------------
  let cover = 0;
  try {
    const tp = await butler.targetPrices(corpCode);
    cover = tp.tables?.coverSecurities ?? 0;
    upsertTargetPriceMonthly(db, corpCode, tp);
    updateCompanyConsensusSummary(db, corpCode, tp, now);
  } catch {
    /* 커버리지 없는 기업은 404 가능 — 무시 */
  }

  // -- 2c) 재무 (분기 + 연간) & 밸류에이션 ----------------------------------
  let quarters = 0;
  try {
    const [q, acc] = await Promise.all([
      butler.summary(corpCode, "quarter"),
      butler.summary(corpCode, "accumulated"),
    ]);
    quarters = upsertFinancials(db, corpCode, q, acc);
    upsertValuations(db, corpCode, acc);
  } catch {
    /* 일부 기업 재무 미존재 */
  }

  // -- 2d) 컨센서스 리포트 (증권사별 목표주가) ------------------------------
  const reports = await ingestConsensusReports(db, corpCode, feedPages);

  db.prepare(
    "UPDATE companies SET detail_ingested_at = ?, has_consensus = ?, updated_at = ? WHERE corp_code = ?",
  ).run(now, reports > 0 || cover > 0 ? 1 : 0, now, corpCode);

  db.prepare(
    "INSERT INTO ingest_runs (kind, corp_code, started_at, finished_at, ok) VALUES ('detail', ?, ?, ?, 1)",
  ).run(corpCode, now, nowIso());

  const changesAfter = (
    db.prepare("SELECT COUNT(*) c FROM change_logs WHERE corp_code = ?").get(corpCode) as {
      c: number;
    }
  ).c;

  return { corpCode, reports, quarters, changes: changesAfter - changesBefore };
}

export function upsertCompanyDetail(db: Database.Database, d: CompanyDetail, now: string) {
  const p = d.priceInfo;
  // companies 행이 없으면(=목록 수집 전에 상세부터 호출) 먼저 stub 생성 → FK 보장
  db.prepare(
    `INSERT INTO companies (corp_code, stock_code, name, source, created_at, updated_at)
     VALUES (?, ?, ?, 'butler', ?, ?)
     ON CONFLICT(corp_code) DO NOTHING`,
  ).run(d.corpCode, d.stockCode, d.stockName, now, now);
  const sec = classifySector(d.industryCode, d.codeNameKR);
  db.prepare(
    `UPDATE companies SET
        stock_code = ?, name = ?, name_eng = ?, market = ?, sector = ?,
        sector_code = ?, sector_name = ?,
        industry_code = ?, is_financial = ?, fs_div = ?,
        market_cap = ?, price = ?, fluctuation_rate = ?,
        per = ?, pbr = ?, fper = ?, eps = ?, feps = ?, bps = ?, dps = ?,
        dividend_yield = ?, treasury_ratio = ?, updated_at = ?
      WHERE corp_code = ?`,
  ).run(
    d.stockCode,
    d.stockName,
    d.corpNameEng ?? null,
    marketFromCls(d.corpCls),
    d.codeNameKR ?? null,
    sec.code,
    sec.name,
    d.industryCode ?? null,
    isFinancialSector(d.industryCode) ? 1 : 0,
    d.fsDiv ?? null,
    p?.marketCapital ? Number(p.marketCapital) : null,
    p?.price ?? null,
    p?.fluctuationRate ? Number(p.fluctuationRate) : null,
    p?.per ? Number(p.per) : null,
    p?.pbr ? Number(p.pbr) : null,
    p?.fper ? Number(p.fper) : null,
    p?.eps ?? null,
    p?.feps ?? null,
    p?.bps ?? null,
    p?.dps ?? null,
    p?.marketDividendYield ? Number(p.marketDividendYield) : null,
    d.treasuryOutstandingRatio ? Number(d.treasuryOutstandingRatio) : null,
    now,
    d.corpCode,
  );
}

export function updateCompanyConsensusSummary(
  db: Database.Database,
  corpCode: string,
  tp: Awaited<ReturnType<typeof butler.targetPrices>>,
  now: string,
) {
  const t = tp.tables;
  if (!t) return;
  const prev = db
    .prepare("SELECT target_price_avg, cover_securities FROM companies WHERE corp_code = ?")
    .get(corpCode) as { target_price_avg: number | null; cover_securities: number | null };

  if (prev?.target_price_avg != null && t.targetPriceAvg !== prev.target_price_avg) {
    const delta = t.targetPriceAvg - prev.target_price_avg;
    logChange(db, {
      corp_code: corpCode,
      entity_type: "consensus_avg",
      field: "target_price_avg",
      old_value: prev.target_price_avg,
      new_value: t.targetPriceAvg,
      delta,
      delta_pct: prev.target_price_avg ? (delta / prev.target_price_avg) * 100 : null,
      change_kind: delta > 0 ? "up" : "down",
      note: "평균 목표주가 변동",
    });
  }

  db.prepare(
    "UPDATE companies SET target_price_avg = ?, target_return_rate = ?, cover_securities = ?, updated_at = ? WHERE corp_code = ?",
  ).run(t.targetPriceAvg ?? null, t.returnRate ? Number(t.returnRate) : null, t.coverSecurities ?? null, now, corpCode);
}

export function upsertTargetPriceMonthly(
  db: Database.Database,
  corpCode: string,
  tp: Awaited<ReturnType<typeof butler.targetPrices>>,
) {
  const rows = tp.charts?.targetPrices ?? [];
  const stmt = db.prepare(
    `INSERT INTO target_price_monthly
       (corp_code, month, full_date, tp_max, tp_avg, tp_min, price, cover_securities, return_ratio, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'butler')
     ON CONFLICT(corp_code, month) DO UPDATE SET
       full_date=excluded.full_date, tp_max=excluded.tp_max, tp_avg=excluded.tp_avg,
       tp_min=excluded.tp_min, price=excluded.price,
       cover_securities=excluded.cover_securities, return_ratio=excluded.return_ratio`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(
        corpCode,
        r.date,
        r.fullDate ?? null,
        r.max ?? null,
        r.avg ?? null,
        r.min ?? null,
        r.price ?? null,
        r.coverSecurities ?? null,
        r.returnRatio ?? null,
      );
    }
  });
  tx();
}

/** 분기 실적(quarter) + 연간 실적(accumulated Q4) + 컨센서스 추정치 저장. */
export function upsertFinancials(
  db: Database.Database,
  corpCode: string,
  q: Awaited<ReturnType<typeof butler.summary>>,
  acc: Awaited<ReturnType<typeof butler.summary>>,
): number {
  const metricMap: Array<[keyof typeof q.fs, string, string]> = [
    ["isRevenue", "REVENUE", "매출액"],
    ["isOperatingProfitLoss", "OPERATING_PROFIT", "영업이익"],
    ["isNetIncome", "NET_INCOME", "당기순이익"],
  ];

  const selExisting = db.prepare(
    "SELECT value FROM financials WHERE corp_code=? AND metric=? AND fiscal_year=? AND quarter=? AND period_type=? AND is_estimate=?",
  );
  const upsert = db.prepare(
    `INSERT INTO financials
       (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'butler')
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate)
     DO UPDATE SET value=excluded.value, date_label=excluded.date_label, raw_label=excluded.raw_label`,
  );

  const newQuarterly: Array<{ metric: string; year: number; quarter: number }> = [];
  let count = 0;

  // 시계열 1건의 (year, quarter)는 bsnsYear/quarter 필드가 있으면 그걸,
  // 없으면(예: isNetIncome) date 라벨 'YY.MM' 을 파싱해 얻는다.
  const periodOf = (it: any): { year: number; quarter: number } | null => {
    if (it.bsnsYear && it.quarter) return { year: Number(it.bsnsYear), quarter: Number(it.quarter) };
    return it.date ? parseDateLabel(it.date) : null;
  };

  const writeRow = (
    metric: string,
    label: string,
    year: number,
    quarter: number,
    period: "Q" | "A",
    value: number,
    isEst: 0 | 1,
    dateLabel: string | null,
  ) => {
    if (period === "Q" && isEst === 0) {
      const ex = selExisting.get(corpCode, metric, year, quarter, "Q", 0) as
        | { value: number }
        | undefined;
      if (!ex) newQuarterly.push({ metric, year, quarter });
    }
    upsert.run(corpCode, metric, label, year, quarter, period, value, isEst, dateLabel);
    count++;
  };

  const tx = db.transaction(() => {
    for (const [key, metric, label] of metricMap) {
      // (1) 분기 실적 — quarter 엔드포인트 fs.* (분기 단독 값; 비로그인은 ~2023 까지)
      for (const it of (q.fs[key] as any[]) ?? []) {
        const pq = periodOf(it);
        if (it.value == null || !pq) continue;
        writeRow(metric, label, pq.year, pq.quarter, "Q", it.value, 0, it.date ?? null);
      }
      // (2) 연간 실적 — accumulated(TTM) 의 4분기 값(= 회계연도 전체)
      for (const it of (acc.fs[key] as any[]) ?? []) {
        const pq = periodOf(it);
        if (it.value == null || !pq || pq.quarter !== 4) continue;
        writeRow(metric, label, pq.year, 0, "A", it.value, 0, it.date ?? null);
      }
    }
    // (3) consensus 분기 시계열 — REVENUE / OPERATING_PROFIT 만 제공.
    //     isPreliminary 로 실적/추정 구분: false|true = 확정/잠정 실적(is_estimate=0),
    //     null/없음 = 미래 추정치(=1). (2) 의 quarter fs 보다 최신이므로 ON CONFLICT 덮어씀.
    //     - is* (isRevenue …): 확정/잠정 실적값. 인증 세션이면 최신 분기까지 완전,
    //       비로그인이면 ~2023 까지만(value 마스킹).
    //     - consensus*Avg (consensusRevenueAvg …): 애널리스트 컨센서스 평균 추정치로
    //       비로그인에도 향후 분기(예: 2025) 값이 옴 → is* 와 별개 데이터(is_estimate=1)
    //       라 PK 충돌 없이 함께 적재. 둘 중 하나만 읽으면 추정치 계층이 비므로 둘 다 본다.
    const consMap: Array<[string, string, string]> = [
      ["isRevenue", "REVENUE", "매출액"],
      ["isOperatingProfitLoss", "OPERATING_PROFIT", "영업이익"],
      ["consensusRevenueAvg", "REVENUE", "매출액"],
      ["consensusOperatingProfitLossAvg", "OPERATING_PROFIT", "영업이익"],
    ];
    for (const [key, metric, label] of consMap) {
      for (const it of ((acc.consensus as any)?.[key] as any[]) ?? []) {
        const pq = periodOf(it);
        if (it.value == null || !pq) continue;
        const isEst: 0 | 1 = it.isPreliminary == null ? 1 : 0;
        writeRow(metric, label, pq.year, pq.quarter, "Q", it.value, isEst, it.date ?? null);
      }
    }
  });
  tx();

  // 새로 들어온 분기에 대해 QoQ / YoY 변화 로깅 (최근 8개 한정)
  const growth = db
    .prepare(
      `SELECT metric, fiscal_year, quarter, value, qoq_pct, yoy_pct
       FROM v_financials_growth
       WHERE corp_code=? AND period_type='Q' AND is_estimate=0
       ORDER BY fiscal_year DESC, quarter DESC LIMIT 12`,
    )
    .all(corpCode) as Array<{
    metric: string;
    fiscal_year: number;
    quarter: number;
    value: number;
    qoq_pct: number | null;
    yoy_pct: number | null;
  }>;
  const newSet = new Set(newQuarterly.map((n) => `${n.metric}:${n.year}:${n.quarter}`));
  let logged = 0;
  for (const row of growth) {
    if (logged >= 8) break;
    if (!newSet.has(`${row.metric}:${row.fiscal_year}:${row.quarter}`)) continue;
    if (row.qoq_pct == null && row.yoy_pct == null) continue;
    logChange(db, {
      corp_code: corpCode,
      entity_type: "financial",
      entity_key: `${row.metric} ${row.fiscal_year}Q${row.quarter}`,
      field: row.metric,
      new_value: row.value,
      delta_pct: row.yoy_pct ?? row.qoq_pct,
      change_kind: row.yoy_pct != null ? "yoy" : "qoq",
      note: `QoQ ${row.qoq_pct ?? "-"}% / YoY ${row.yoy_pct ?? "-"}%`,
      occurred_at: periodEndDate(row.fiscal_year, row.quarter),
    });
    logged++;
  }
  return count;
}

export function upsertValuations(
  db: Database.Database,
  corpCode: string,
  acc: Awaited<ReturnType<typeof butler.summary>>,
) {
  const series: Array<[string, { data?: Array<{ date: string; value?: number }> }]> = [
    ["PER", acc.valuations?.valPER],
    ["PBR", acc.valuations?.valPBR],
  ];
  const stmt = db.prepare(
    `INSERT INTO valuations (corp_code, metric, date_label, fiscal_year, quarter, value, source)
     VALUES (?, ?, ?, ?, ?, ?, 'butler')
     ON CONFLICT(corp_code, metric, date_label) DO UPDATE SET value=excluded.value`,
  );
  const tx = db.transaction(() => {
    for (const [metric, s] of series) {
      for (const it of s?.data ?? []) {
        if (it.value == null) continue;
        const ymq = parseDateLabel(it.date);
        stmt.run(corpCode, metric, it.date, ymq?.year ?? null, ymq?.quarter ?? null, it.value);
      }
    }
  });
  tx();
}

export type CollectedReport = {
  reportId: string;
  values: NonNullable<import("./butler").FeedItem["contents"]["values"]>;
};

/** 피드에서 CONSENSUS 항목을 페이지네이션 수집 → 증권사별 리포트 저장 + 변경 감지. */
async function ingestConsensusReports(
  db: Database.Database,
  corpCode: string,
  maxPages: number,
): Promise<number> {
  const collected: CollectedReport[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const res = await butler.feed(corpCode, cursor, 15);
    for (const it of res.data) {
      if (it.type === "CONSENSUS" && it.contents?.reportId && it.contents.values) {
        collected.push({ reportId: it.contents.reportId, values: it.contents.values });
      }
    }
    if (!res.hasNext || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return writeConsensusReports(db, corpCode, collected);
}

/** 수집된 컨센서스 리포트를 DB 에 저장 + 증권사별 목표주가 변경 감지 (sync). */
export function writeConsensusReports(
  db: Database.Database,
  corpCode: string,
  collected: CollectedReport[],
): number {
  // 시간 오름차순으로 정렬해 직전 리포트 대비 변화 계산
  collected.sort((a, b) => normalizeDate(a.values.date).localeCompare(normalizeDate(b.values.date)));

  const selReport = db.prepare("SELECT report_id FROM consensus_reports WHERE report_id = ?");
  const insReport = db.prepare(
    `INSERT INTO consensus_reports
       (report_id, corp_code, broker_id, title, analyst, report_date, rating, rating_change,
        target_price, target_price_change, price_close, return_rate, ai_summary, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'butler', ?)`,
  );
  const prevBrokerTarget = db.prepare(
    `SELECT target_price FROM consensus_reports
     WHERE corp_code=? AND broker_id=? AND report_date < ?
     ORDER BY report_date DESC LIMIT 1`,
  );

  let inserted = 0;
  for (const c of collected) {
    if (selReport.get(c.reportId)) continue; // 멱등
    const v = c.values;
    const brokerId = getBrokerId(db, v.securitiesCompany);
    const date = normalizeDate(v.date);
    const tx = db.transaction(() => {
      const prev = prevBrokerTarget.get(corpCode, brokerId, date) as
        | { target_price: number | null }
        | undefined;
      insReport.run(
        c.reportId,
        corpCode,
        brokerId,
        null,
        v.analyst ?? null,
        date,
        v.rating ?? null,
        v.ratingChange ?? null,
        v.targetPrice ?? null,
        v.targetPriceChange ?? null,
        v.priceClose ?? null,
        v.returnRate ? Number(v.returnRate) : null,
        v.aiSummary ?? null,
        nowIso(),
      );
      // 증권사별 목표주가 변경 로깅
      const oldTp = prev?.target_price ?? null;
      const newTp = v.targetPrice ?? null;
      if (newTp != null && oldTp != null && newTp !== oldTp) {
        const delta = newTp - oldTp;
        logChange(db, {
          corp_code: corpCode,
          entity_type: "target_price",
          entity_key: v.securitiesCompany,
          field: "target_price",
          old_value: oldTp,
          new_value: newTp,
          delta,
          delta_pct: oldTp ? (delta / oldTp) * 100 : null,
          change_kind: delta > 0 ? "up" : "down",
          note: `${v.securitiesCompany} 목표주가 ${v.targetPriceChange ?? ""} (${v.analyst ?? ""})`,
          occurred_at: date, // 리포트 발행일 = 실제 목표가 수정일
        });
      } else if (newTp != null && oldTp == null) {
        logChange(db, {
          corp_code: corpCode,
          entity_type: "target_price",
          entity_key: v.securitiesCompany,
          field: "target_price",
          new_value: newTp,
          change_kind: "new",
          note: `${v.securitiesCompany} 신규 커버리지 (${v.analyst ?? ""})`,
          occurred_at: date,
        });
      }
    });
    tx();
    inserted++;
  }
  return inserted;
}

/* ---------------------------------------------------------------------------
 * 3) 증분(incremental) + 멱등(idempotent) 일일 갱신
 *    - 피드는 최신순 → 이미 가진 report_id 를 만나면 즉시 중단(그 이후는 다 보유).
 *      → 매일 돌리면 보통 1페이지만 받고 끝(최근 신규 리포트만).
 *    - 시세/목표가는 값이 바뀐 경우에만 UPDATE(같은 데이터면 안 씀).
 * ------------------------------------------------------------------------- */

/** 신규 컨센서스 리포트만 증분 수집 (이미 가진 리포트를 만나면 중단). */
export async function ingestNewReports(
  db: Database.Database,
  corpCode: string,
  maxPages = 20,
): Promise<number> {
  const known = db.prepare("SELECT 1 FROM consensus_reports WHERE report_id = ?");
  const fresh: CollectedReport[] = [];
  let cursor = "";
  let hitKnown = false;
  for (let page = 0; page < maxPages && !hitKnown; page++) {
    const res = await butler.feed(corpCode, cursor, 15);
    for (const it of res.data) {
      if (it.type !== "CONSENSUS" || !it.contents?.reportId || !it.contents.values) continue;
      if (known.get(it.contents.reportId)) {
        hitKnown = true; // 최신순이므로 이후는 모두 보유분 → 중단
        break;
      }
      fresh.push({ reportId: it.contents.reportId, values: it.contents.values });
    }
    if (!res.hasNext || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  if (fresh.length === 0) return 0; // 신규 없음 → DB 무변경
  return writeConsensusReports(db, corpCode, fresh);
}

/**
 * 목표가만 경량 수집 (재무 생략). 호출 ≈ 목표주가(1) + 피드(maxPages).
 * 커버리지 전종목 일괄 채우기용 — 재무는 나중에 별도 패스.
 */
export async function ingestTargetsOnly(
  db: Database.Database,
  corpCode: string,
  feedPages = 2,
): Promise<{ reports: number; cover: number }> {
  const now = nowIso();
  let cover = 0;
  try {
    const tp = await butler.targetPrices(corpCode);
    cover = tp.tables?.coverSecurities ?? 0;
    upsertTargetPriceMonthly(db, corpCode, tp);
    updateCompanyConsensusSummary(db, corpCode, tp, now);
  } catch {
    /* 커버리지 없음 */
  }
  const reports = await ingestNewReports(db, corpCode, feedPages);
  db.prepare(
    "UPDATE companies SET detail_ingested_at = ?, has_consensus = ?, updated_at = ? WHERE corp_code = ?",
  ).run(now, reports > 0 || cover > 0 ? 1 : 0, now, corpCode);
  return { reports, cover };
}

const approxEq = (a: number | null, b: number | null) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-6;
};

/** 숫자/숫자문자열 → number | null. "N/A"·""·NaN 등은 null (NaN 저장/오탐 방지). */
const toNum = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/**
 * 시세/밸류/목표가 스냅샷을 갱신하되 **값이 바뀐 경우에만** companies 를 UPDATE.
 * 같은 데이터로 여러 번 실행해도 updated_at 조차 바뀌지 않는다(완전 멱등).
 * @returns 'updated' | 'unchanged'
 */
export async function refreshCompanyQuote(
  db: Database.Database,
  corpCode: string,
): Promise<"updated" | "unchanged"> {
  const detail = await butler.company(corpCode);
  let tp: Awaited<ReturnType<typeof butler.targetPrices>> | null = null;
  try {
    tp = await butler.targetPrices(corpCode);
  } catch {
    /* 커버리지 없음 */
  }
  const p = detail.priceInfo;
  const t = tp?.tables;
  const next = {
    price: toNum(p?.price),
    fluctuation_rate: toNum(p?.fluctuationRate),
    market_cap: toNum(p?.marketCapital),
    per: toNum(p?.per),
    pbr: toNum(p?.pbr),
    fper: toNum(p?.fper),
    eps: toNum(p?.eps),
    feps: toNum(p?.feps),
    bps: toNum(p?.bps),
    dps: toNum(p?.dps),
    dividend_yield: toNum(p?.marketDividendYield),
    target_price_avg: toNum(t?.targetPriceAvg),
    target_return_rate: toNum(t?.returnRate),
    cover_securities: toNum(t?.coverSecurities),
  };

  const cur = db
    .prepare(
      `SELECT price, fluctuation_rate, market_cap, per, pbr, fper, eps, feps, bps, dps,
              dividend_yield, target_price_avg, target_return_rate, cover_securities
       FROM companies WHERE corp_code = ?`,
    )
    .get(corpCode) as Record<string, number | null> | undefined;

  const changed =
    !cur || (Object.keys(next) as (keyof typeof next)[]).some((k) => !approxEq(next[k], cur[k] ?? null));
  if (!changed) return "unchanged";

  // 평균 목표주가 변동은 별도 변경이력으로(발생일=오늘)
  if (cur && next.target_price_avg != null && cur.target_price_avg != null &&
      !approxEq(next.target_price_avg, cur.target_price_avg)) {
    const delta = next.target_price_avg - cur.target_price_avg;
    logChange(db, {
      corp_code: corpCode,
      entity_type: "consensus_avg",
      field: "target_price_avg",
      old_value: cur.target_price_avg,
      new_value: next.target_price_avg,
      delta,
      delta_pct: cur.target_price_avg ? (delta / cur.target_price_avg) * 100 : null,
      change_kind: delta > 0 ? "up" : "down",
      note: "평균 목표주가 변동",
      occurred_at: nowIso().slice(0, 10),
    });
  }

  if (tp) upsertTargetPriceMonthly(db, corpCode, tp);
  db.prepare(
    `UPDATE companies SET price=@price, fluctuation_rate=@fluctuation_rate, market_cap=@market_cap,
        per=@per, pbr=@pbr, fper=@fper, eps=@eps, feps=@feps, bps=@bps, dps=@dps,
        dividend_yield=@dividend_yield, target_price_avg=@target_price_avg,
        target_return_rate=@target_return_rate, cover_securities=@cover_securities,
        updated_at=@updated_at WHERE corp_code=@corp_code`,
  ).run({ ...next, updated_at: nowIso(), corp_code: corpCode });
  return "updated";
}
