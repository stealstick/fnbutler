import { butler, type ScreenRow, type CompanyDetail } from "./butler";
import { all, one, query, tx, nowIso, type Queryable } from "./db";
import { parseDateLabel } from "./format";
import { classifySector } from "./sectors";

/**
 * industry_code 가 이미 있는 기업의 sector_code/sector_name 를 로컬에서 재분류한다
 * (API 호출 없음). 섹터 분류 규칙을 바꾼 뒤 일괄 적용할 때 사용.
 */
export async function reclassifySectors(db: Queryable): Promise<number> {
  const rows = await all<{ corp_code: string; industry_code: string | null; sector: string | null }>(
    "SELECT corp_code, industry_code, sector FROM companies",
    [],
    db,
  );
  await tx(async (client) => {
    for (const r of rows) {
      const s = classifySector(r.industry_code, r.sector);
      await query("UPDATE companies SET sector_code = $1, sector_name = $2 WHERE corp_code = $3", [
        s.code,
        s.name,
        r.corp_code,
      ], client);
    }
  });
  return rows.length;
}

function normalizeDate(s: string): string {
  const m = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function isFinancialSector(industryCode?: string): boolean {
  if (!industryCode) return false;
  return /^6[456]/.test(industryCode);
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
  occurred_at?: string;
}

export async function logChange(db: Queryable, c: ChangeRow) {
  const observed = nowIso();
  await query(
    `INSERT INTO change_logs
       (corp_code, entity_type, entity_key, field, old_value, new_value,
        delta, delta_pct, change_kind, note, source, occurred_at, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'butler', $11, $12)`,
    [
      c.corp_code,
      c.entity_type,
      c.entity_key ?? null,
      c.field ?? null,
      c.old_value == null ? null : String(c.old_value),
      c.new_value == null ? null : String(c.new_value),
      c.delta ?? null,
      c.delta_pct ?? null,
      c.change_kind ?? null,
      c.note ?? null,
      c.occurred_at ?? observed.slice(0, 10),
      observed,
    ],
    db,
  );
}

/** 분기/연도 → 분기말 날짜 (실적 변경의 발생일). quarter 0 = 연간. */
export function periodEndDate(year: number, quarter: number): string {
  if (!quarter) return `${year}-12-31`;
  const md = ["03-31", "06-30", "09-30", "12-31"][quarter - 1] ?? "12-31";
  return `${year}-${md}`;
}

async function getBrokerId(db: Queryable, name: string, url?: string): Promise<number> {
  const existing = await one<{ id: number; research_url: string | null }>(
    "SELECT id, research_url FROM brokers WHERE name = $1",
    [name],
    db,
  );
  if (existing) {
    if (url && !existing.research_url)
      await query("UPDATE brokers SET research_url = $1 WHERE id = $2", [url, existing.id], db);
    return existing.id;
  }
  const inserted = await one<{ id: number }>(
    "INSERT INTO brokers (name, research_url) VALUES ($1, $2) RETURNING id",
    [name, url ?? null],
    db,
  );
  if (!inserted) throw new Error(`failed to insert broker: ${name}`);
  return inserted.id;
}

/* ---------------------------------------------------------------------------
 * 1) 기업 목록 — 스크리너로 전종목 enumerate
 * ------------------------------------------------------------------------- */

export async function ingestCompanies(
  db: Queryable,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<{ total: number; upserted: number }> {
  const { count } = await butler.screenerCount([]);
  const size = 50;
  const pages = Math.ceil(count / size);
  let upserted = 0;
  const now = nowIso();

  for (let page = 1; page <= pages; page++) {
    const { results } = await butler.screen(page, size);
    await tx(async (client) => {
      for (const r of results) await upsertCompanyFromScreen(client, r, now);
    });
    upserted += results.length;
    opts.onProgress?.(Math.min(upserted, count), count);
    if (results.length === 0) break;
  }
  return { total: count, upserted };
}

export async function upsertCompanyFromScreen(db: Queryable, r: ScreenRow, now: string) {
  await query(
    `INSERT INTO companies
       (corp_code, stock_code, name, market_cap, price, fluctuation_rate, currency, country, active, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'KRW', 'KR', 1, 'butler', $7, $8)
     ON CONFLICT(corp_code) DO UPDATE SET
       stock_code=excluded.stock_code,
       name=excluded.name,
       market_cap=excluded.market_cap,
       price=excluded.price,
       fluctuation_rate=excluded.fluctuation_rate,
       currency='KRW',
       country='KR',
       active=1,
       updated_at=excluded.updated_at`,
    [
      r.corpCode,
      r.stockCode,
      r.stockName,
      r.marketCap ? Number(r.marketCap) : null,
      r.price ?? null,
      r.fluctuationRate ? Number(r.fluctuationRate) : null,
      now,
      now,
    ],
    db,
  );
}

/* ---------------------------------------------------------------------------
 * 2) 기업 상세 — 시세/재무/밸류/컨센서스 + 변경 감지
 * ------------------------------------------------------------------------- */

export async function ingestDetail(
  db: Queryable,
  corpCode: string,
  opts: { feedPages?: number } = {},
): Promise<{ corpCode: string; reports: number; quarters: number; changes: number }> {
  const feedPages = opts.feedPages ?? 6;
  const now = nowIso();
  const changesBefore = Number(
    (await one<{ c: number }>("SELECT COUNT(*)::int c FROM change_logs WHERE corp_code = $1", [corpCode], db))?.c ?? 0,
  );

  const detail = await butler.company(corpCode);
  await upsertCompanyDetail(db, detail, now);

  let cover = 0;
  try {
    const tp = await butler.targetPrices(corpCode);
    cover = tp.tables?.coverSecurities ?? 0;
    await upsertTargetPriceMonthly(db, corpCode, tp);
    await updateCompanyConsensusSummary(db, corpCode, tp, now);
  } catch {
    /* 커버리지 없는 기업은 404 가능 — 무시 */
  }

  let quarters = 0;
  try {
    const [q, acc] = await Promise.all([
      butler.summary(corpCode, "quarter"),
      butler.summary(corpCode, "accumulated"),
    ]);
    quarters = await upsertFinancials(db, corpCode, q, acc);
    await upsertValuations(db, corpCode, acc);
  } catch {
    /* 일부 기업 재무 미존재 */
  }

  const reports = await ingestConsensusReports(db, corpCode, feedPages);
  await fillTargetMonthlyConsensus(db, corpCode);

  await query(
    "UPDATE companies SET detail_ingested_at = $1, has_consensus = $2, updated_at = $3 WHERE corp_code = $4",
    [now, reports > 0 || cover > 0 ? 1 : 0, now, corpCode],
    db,
  );

  await query(
    "INSERT INTO ingest_runs (kind, corp_code, started_at, finished_at, ok) VALUES ('detail', $1, $2, $3, 1)",
    [corpCode, now, nowIso()],
    db,
  );

  const changesAfter = Number(
    (await one<{ c: number }>("SELECT COUNT(*)::int c FROM change_logs WHERE corp_code = $1", [corpCode], db))?.c ?? 0,
  );
  return { corpCode, reports, quarters, changes: changesAfter - changesBefore };
}

export async function upsertCompanyDetail(db: Queryable, d: CompanyDetail, now: string) {
  const p = d.priceInfo;
  await query(
    `INSERT INTO companies (corp_code, stock_code, name, source, created_at, updated_at)
     VALUES ($1, $2, $3, 'butler', $4, $5)
     ON CONFLICT(corp_code) DO NOTHING`,
    [d.corpCode, d.stockCode, d.stockName, now, now],
    db,
  );
  const sec = classifySector(d.industryCode, d.codeNameKR);
  await query(
    `UPDATE companies SET
        stock_code = $1, name = $2, name_eng = $3, market = $4, sector = $5,
        sector_code = $6, sector_name = $7,
        industry_code = $8, is_financial = $9, fs_div = $10,
        market_cap = $11, price = $12, fluctuation_rate = $13,
        per = $14, pbr = $15, fper = $16, eps = $17, feps = $18, bps = $19, dps = $20,
        dividend_yield = $21, treasury_ratio = $22, currency = 'KRW', country = 'KR', active = 1, updated_at = $23
      WHERE corp_code = $24`,
    [
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
    ],
    db,
  );
}

export async function updateCompanyConsensusSummary(
  db: Queryable,
  corpCode: string,
  tp: Awaited<ReturnType<typeof butler.targetPrices>>,
  now: string,
) {
  const t = tp.tables;
  if (!t) return;
  const prev = await one<{ target_price_avg: number | null; cover_securities: number | null }>(
    "SELECT target_price_avg, cover_securities FROM companies WHERE corp_code = $1",
    [corpCode],
    db,
  );

  if (prev?.target_price_avg != null && t.targetPriceAvg !== prev.target_price_avg) {
    const delta = t.targetPriceAvg - prev.target_price_avg;
    await logChange(db, {
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

  await query(
    "UPDATE companies SET target_price_avg = $1, target_return_rate = $2, cover_securities = $3, updated_at = $4 WHERE corp_code = $5",
    [t.targetPriceAvg ?? null, t.returnRate ? Number(t.returnRate) : null, t.coverSecurities ?? null, now, corpCode],
    db,
  );
}

export async function upsertTargetPriceMonthly(
  db: Queryable,
  corpCode: string,
  tp: Awaited<ReturnType<typeof butler.targetPrices>>,
) {
  for (const r of tp.charts?.targetPrices ?? []) {
    await query(
      `INSERT INTO target_price_monthly
         (corp_code, month, full_date, tp_max, tp_avg, tp_min, price, cover_securities, return_ratio, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'butler')
       ON CONFLICT(corp_code, month) DO UPDATE SET
         full_date=excluded.full_date, tp_max=excluded.tp_max, tp_avg=excluded.tp_avg,
         tp_min=excluded.tp_min, price=excluded.price,
         cover_securities=excluded.cover_securities, return_ratio=excluded.return_ratio`,
      [
        corpCode,
        r.date,
        r.fullDate ?? null,
        r.max ?? null,
        r.avg ?? null,
        r.min ?? null,
        r.price ?? null,
        r.coverSecurities ?? null,
        r.returnRatio ?? null,
      ],
      db,
    );
  }
}

/**
 * butler 월별 목표가 차트는 최근 몇 달의 월말 주가(price)는 주지만 컨센서스
 * 목표가 평균/고저(tp_avg/min/max)는 비워서 보낸다. 그래서 "월별 목표가 추이"
 * 평균선이 최근 달에서 끊긴다. 우리가 자체 보유한 consensus_reports 로 그 빈 달을
 * 각 월말 기준 활성 커버리지(증권사별 최신 목표가, 12개월 이내)로 다시 채운다.
 *
 * - butler 가 채운 달(source='butler', tp_avg NOT NULL)은 건드리지 않는다.
 * - 우리가 채운 달(source='consensus-fill')은 새 리포트가 들어오면 매번 갱신한다.
 * - 활성 증권사가 3곳 미만인 달은 노이즈라 비워둔다.
 */
export async function fillTargetMonthlyConsensus(db: Queryable, corpCode: string): Promise<number> {
  const res = await query(
    `WITH gap AS (
       SELECT month,
         (to_date('20' || substr(month, 1, 2) || substr(month, 4, 2) || '01', 'YYYYMMDD')
            + interval '1 month' - interval '1 day')::date AS mend
       FROM target_price_monthly
       WHERE corp_code = $1
         AND price IS NOT NULL
         AND (tp_avg IS NULL OR source = 'consensus-fill')
     ),
     calc AS (
       SELECT g.month,
         ROUND(AVG(lt.target_price)::numeric)::double precision AS avg,
         MIN(lt.target_price) AS min,
         MAX(lt.target_price) AS max,
         COUNT(*)::int AS cnt
       FROM gap g
       JOIN LATERAL (
         SELECT DISTINCT ON (r.broker_id) r.broker_id, r.target_price
         FROM consensus_reports r
         WHERE r.corp_code = $1
           AND r.target_price IS NOT NULL
           AND r.report_date::date <= g.mend
           AND r.report_date::date > g.mend - interval '12 months'
         ORDER BY r.broker_id, r.report_date::date DESC, r.report_id DESC
       ) lt ON true
       GROUP BY g.month
     )
     UPDATE target_price_monthly t
        SET tp_avg = calc.avg,
            tp_min = calc.min,
            tp_max = calc.max,
            cover_securities = calc.cnt,
            source = 'consensus-fill'
       FROM calc
      WHERE t.corp_code = $1
        AND t.month = calc.month
        AND calc.cnt >= 3`,
    [corpCode],
    db,
  );
  return res.rowCount ?? 0;
}

/** 분기 실적(quarter) + 연간 실적(accumulated Q4) + 컨센서스 추정치 저장. */
export async function upsertFinancials(
  db: Queryable,
  corpCode: string,
  q: Awaited<ReturnType<typeof butler.summary>>,
  acc: Awaited<ReturnType<typeof butler.summary>>,
): Promise<number> {
  const metricMap: Array<[keyof typeof q.fs, string, string]> = [
    ["isRevenue", "REVENUE", "매출액"],
    ["isOperatingProfitLoss", "OPERATING_PROFIT", "영업이익"],
    ["isNetIncome", "NET_INCOME", "당기순이익"],
  ];

  const newQuarterly: Array<{ metric: string; year: number; quarter: number }> = [];
  let count = 0;

  const periodOf = (it: any): { year: number; quarter: number } | null => {
    if (it.bsnsYear && it.quarter) return { year: Number(it.bsnsYear), quarter: Number(it.quarter) };
    return it.date ? parseDateLabel(it.date) : null;
  };

  await tx(async (client) => {
    const writeRow = async (
      metric: string,
      label: string,
      year: number,
      quarter: number,
      period: "Q" | "A",
      val: number,
      isEst: 0 | 1,
      dateLabel: string | null,
    ) => {
      if (period === "Q" && isEst === 0) {
        const ex = await one<{ value: number }>(
          "SELECT value FROM financials WHERE corp_code=$1 AND metric=$2 AND fiscal_year=$3 AND quarter=$4 AND period_type=$5 AND is_estimate=$6",
          [corpCode, metric, year, quarter, "Q", 0],
          client,
        );
        if (!ex) newQuarterly.push({ metric, year, quarter });
      }
      await query(
        `INSERT INTO financials
           (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'butler')
         ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate, source)
         DO UPDATE SET value=excluded.value, date_label=excluded.date_label, raw_label=excluded.raw_label`,
        [corpCode, metric, label, year, quarter, period, val, isEst, dateLabel],
        client,
      );
      count++;
    };

    for (const [key, metric, label] of metricMap) {
      for (const it of (q.fs[key] as any[]) ?? []) {
        const pq = periodOf(it);
        if (it.value == null || !pq) continue;
        await writeRow(metric, label, pq.year, pq.quarter, "Q", it.value, 0, it.date ?? null);
      }
      for (const it of (acc.fs[key] as any[]) ?? []) {
        const pq = periodOf(it);
        if (it.value == null || !pq || pq.quarter !== 4) continue;
        await writeRow(metric, label, pq.year, 0, "A", it.value, 0, it.date ?? null);
      }
    }

    const consMap: Array<[string, string, string]> = [
      ["isRevenue", "REVENUE", "매출액"],
      ["isOperatingProfitLoss", "OPERATING_PROFIT", "영업이익"],
      ["isRevenueForComparison", "REVENUE", "매출액"],
      ["isOperatingProfitLossForComparison", "OPERATING_PROFIT", "영업이익"],
      ["consensusRevenueAvg", "REVENUE", "매출액"],
      ["consensusOperatingProfitLossAvg", "OPERATING_PROFIT", "영업이익"],
    ];
    for (const [key, metric, label] of consMap) {
      for (const it of ((acc.consensus as any)?.[key] as any[]) ?? []) {
        const pq = periodOf(it);
        if (it.value == null || !pq) continue;
        const isEst: 0 | 1 = it.isPreliminary == null ? 1 : 0;
        await writeRow(metric, label, pq.year, pq.quarter, "Q", it.value, isEst, it.date ?? null);
      }
    }
  });

  const growth = await all<{
    metric: string;
    fiscal_year: number;
    quarter: number;
    value: number;
    qoq_pct: number | null;
    yoy_pct: number | null;
  }>(
    `SELECT metric, fiscal_year, quarter, value, qoq_pct, yoy_pct
     FROM v_financials_growth
     WHERE corp_code=$1 AND period_type='Q' AND is_estimate=0
     ORDER BY fiscal_year DESC, quarter DESC LIMIT 12`,
    [corpCode],
    db,
  );
  const newSet = new Set(newQuarterly.map((n) => `${n.metric}:${n.year}:${n.quarter}`));
  let logged = 0;
  for (const row of growth) {
    if (logged >= 8) break;
    if (!newSet.has(`${row.metric}:${row.fiscal_year}:${row.quarter}`)) continue;
    if (row.qoq_pct == null && row.yoy_pct == null) continue;
    await logChange(db, {
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

export async function upsertValuations(
  db: Queryable,
  corpCode: string,
  acc: Awaited<ReturnType<typeof butler.summary>>,
) {
  const series: Array<[string, { data?: Array<{ date: string; value?: number }> }]> = [
    ["PER", acc.valuations?.valPER],
    ["PBR", acc.valuations?.valPBR],
  ];
  for (const [metric, s] of series) {
    for (const it of s?.data ?? []) {
      if (it.value == null) continue;
      const ymq = parseDateLabel(it.date);
      await query(
        `INSERT INTO valuations (corp_code, metric, date_label, fiscal_year, quarter, value, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'butler')
         ON CONFLICT(corp_code, metric, date_label) DO UPDATE SET value=excluded.value`,
        [corpCode, metric, it.date, ymq?.year ?? null, ymq?.quarter ?? null, it.value],
        db,
      );
    }
  }
}

export type CollectedReport = {
  reportId: string;
  values: NonNullable<import("./butler").FeedItem["contents"]["values"]>;
  /** 리포트 상세 API(/api/consensus/reports/:id)의 전체 AI 요약. 피드의 짧은 요약보다 풍부함. */
  aiSummaryFull?: string;
};

async function attachFullSummaries(db: Queryable, reports: CollectedReport[]): Promise<void> {
  for (const r of reports) {
    if (await one("SELECT 1 FROM consensus_reports WHERE report_id = $1", [r.reportId], db)) continue;
    try {
      const detail = await butler.reportDetail(r.reportId);
      if (detail?.aiSummary) r.aiSummaryFull = detail.aiSummary;
    } catch {
      /* 상세 미존재/실패 — 피드 짧은 요약 유지 */
    }
  }
}

/** 피드에서 CONSENSUS 항목을 페이지네이션 수집 → 증권사별 리포트 저장 + 변경 감지. */
async function ingestConsensusReports(
  db: Queryable,
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
  await attachFullSummaries(db, collected);
  return writeConsensusReports(db, corpCode, collected);
}

/** 수집된 컨센서스 리포트를 DB 에 저장 + 증권사별 목표주가 변경 감지. */
export async function writeConsensusReports(
  db: Queryable,
  corpCode: string,
  collected: CollectedReport[],
): Promise<number> {
  collected.sort((a, b) => normalizeDate(a.values.date).localeCompare(normalizeDate(b.values.date)));
  let inserted = 0;

  for (const c of collected) {
    if (await one("SELECT 1 FROM consensus_reports WHERE report_id = $1", [c.reportId], db)) continue;
    const v = c.values;
    const date = normalizeDate(v.date);
    await tx(async (client) => {
      const brokerId = await getBrokerId(client, v.securitiesCompany);
      const prev = await one<{ target_price: number | null }>(
        `SELECT target_price FROM consensus_reports
         WHERE corp_code=$1 AND broker_id=$2 AND report_date < $3
         ORDER BY report_date DESC LIMIT 1`,
        [corpCode, brokerId, date],
        client,
      );
      await query(
        `INSERT INTO consensus_reports
           (report_id, corp_code, broker_id, title, analyst, report_date, rating, rating_change,
            target_price, target_price_change, price_close, return_rate, ai_summary, source, ingested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'butler', $14)
         ON CONFLICT(report_id) DO NOTHING`,
        [
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
          c.aiSummaryFull ?? v.aiSummary ?? null,
          nowIso(),
        ],
        client,
      );

      const oldTp = prev?.target_price ?? null;
      const newTp = v.targetPrice ?? null;
      if (newTp != null && oldTp != null && newTp !== oldTp) {
        const delta = newTp - oldTp;
        await logChange(client, {
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
          occurred_at: date,
        });
      } else if (newTp != null && oldTp == null) {
        await logChange(client, {
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
    inserted++;
  }
  return inserted;
}

/* ---------------------------------------------------------------------------
 * 3) 증분(incremental) + 멱등(idempotent) 일일 갱신
 * ------------------------------------------------------------------------- */

export async function ingestNewReports(
  db: Queryable,
  corpCode: string,
  maxPages = 20,
): Promise<number> {
  const fresh: CollectedReport[] = [];
  let cursor = "";
  let hitKnown = false;
  for (let page = 0; page < maxPages && !hitKnown; page++) {
    const res = await butler.feed(corpCode, cursor, 15);
    for (const it of res.data) {
      if (it.type !== "CONSENSUS" || !it.contents?.reportId || !it.contents.values) continue;
      if (await one("SELECT 1 FROM consensus_reports WHERE report_id = $1", [it.contents.reportId], db)) {
        hitKnown = true;
        break;
      }
      fresh.push({ reportId: it.contents.reportId, values: it.contents.values });
    }
    if (!res.hasNext || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  if (fresh.length === 0) return 0;
  await attachFullSummaries(db, fresh);
  return writeConsensusReports(db, corpCode, fresh);
}

export async function ingestTargetsOnly(
  db: Queryable,
  corpCode: string,
  feedPages = 2,
): Promise<{ reports: number; cover: number }> {
  const now = nowIso();
  let cover = 0;
  try {
    const tp = await butler.targetPrices(corpCode);
    cover = tp.tables?.coverSecurities ?? 0;
    await upsertTargetPriceMonthly(db, corpCode, tp);
    await updateCompanyConsensusSummary(db, corpCode, tp, now);
  } catch {
    /* 커버리지 없음 */
  }
  const reports = await ingestNewReports(db, corpCode, feedPages);
  await fillTargetMonthlyConsensus(db, corpCode);
  await query(
    "UPDATE companies SET detail_ingested_at = $1, has_consensus = $2, updated_at = $3 WHERE corp_code = $4",
    [now, reports > 0 || cover > 0 ? 1 : 0, now, corpCode],
    db,
  );
  return { reports, cover };
}

const approxEq = (a: number | null, b: number | null) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-6;
};

const toNum = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/**
 * 시세/밸류/목표가 스냅샷을 갱신하되 값이 바뀐 경우에만 companies 를 UPDATE.
 * 같은 데이터로 여러 번 실행해도 updated_at 조차 바뀌지 않는다.
 */
export async function refreshCompanyQuote(
  db: Queryable,
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

  const cur = await one<Record<string, number | null>>(
    `SELECT price, fluctuation_rate, market_cap, per, pbr, fper, eps, feps, bps, dps,
            dividend_yield, target_price_avg, target_return_rate, cover_securities
     FROM companies WHERE corp_code = $1`,
    [corpCode],
    db,
  );
  const changed =
    !cur || (Object.keys(next) as (keyof typeof next)[]).some((k) => !approxEq(next[k], cur[k] ?? null));
  if (!changed) return "unchanged";

  if (
    cur &&
    next.target_price_avg != null &&
    cur.target_price_avg != null &&
    !approxEq(next.target_price_avg, cur.target_price_avg)
  ) {
    const delta = next.target_price_avg - cur.target_price_avg;
    await logChange(db, {
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

  if (tp) await upsertTargetPriceMonthly(db, corpCode, tp);
  await query(
    `UPDATE companies SET price=$1, fluctuation_rate=$2, market_cap=$3,
        per=$4, pbr=$5, fper=$6, eps=$7, feps=$8, bps=$9, dps=$10,
        dividend_yield=$11, target_price_avg=$12,
        target_return_rate=$13, cover_securities=$14,
        updated_at=$15 WHERE corp_code=$16`,
    [
      next.price,
      next.fluctuation_rate,
      next.market_cap,
      next.per,
      next.pbr,
      next.fper,
      next.eps,
      next.feps,
      next.bps,
      next.dps,
      next.dividend_yield,
      next.target_price_avg,
      next.target_return_rate,
      next.cover_securities,
      nowIso(),
      corpCode,
    ],
    db,
  );
  return "updated";
}
