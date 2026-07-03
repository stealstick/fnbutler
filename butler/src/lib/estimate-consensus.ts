import { query, type Queryable } from "./db";
import { logChange } from "./ingest";

export type EstimateMetric = "REVENUE" | "OPERATING_PROFIT" | "NET_INCOME" | "EPS";
export type EstimatePeriodType = "Q" | "A";

/**
 * 연간(E) 추정치가 의미 있게 바뀌면 변경 이력(change_logs)에 남긴다.
 * - 연간만: 분기 추정 리비전은 노이즈가 커 헤드라인(연도별 E)만 기록한다.
 * - ±1% 미만은 반올림/재계산 노이즈로 보고 건너뛴다.
 */
export async function logEstimateRevision(
  db: Queryable,
  input: {
    corpCode: string;
    provider: "fnguide" | "wisereport";
    metric: EstimateMetric;
    label: string;
    fiscalYear: number;
    periodType: EstimatePeriodType;
    oldValue: number | null | undefined;
    newValue: number | null | undefined;
  },
): Promise<void> {
  if (input.periodType !== "A") return;
  const oldValue = cleanEstimateNumber(input.oldValue);
  const newValue = cleanEstimateNumber(input.newValue);
  if (oldValue == null || newValue == null || oldValue === 0) return;
  const deltaPct = ((newValue - oldValue) / Math.abs(oldValue)) * 100;
  if (Math.abs(deltaPct) < 1) return;
  const providerLabel = input.provider === "fnguide" ? "FnGuide" : "WiseReport";
  await logChange(db, {
    corp_code: input.corpCode,
    entity_type: "estimate",
    entity_key: `${providerLabel} ${input.fiscalYear}E ${input.label}`,
    field: input.metric,
    old_value: oldValue,
    new_value: newValue,
    delta: newValue - oldValue,
    delta_pct: deltaPct,
    change_kind: deltaPct > 0 ? "up" : "down",
    note: `${providerLabel} ${input.fiscalYear}E ${input.label} 컨센서스 ${deltaPct > 0 ? "상향" : "하향"}`,
  });
}

export interface EstimateConsensusInput {
  corpCode: string;
  metric: EstimateMetric;
  fiscalYear: number;
  quarter: number;
  periodType: EstimatePeriodType;
  avgValue?: number | null;
  lowValue?: number | null;
  highValue?: number | null;
  yearAgoValue?: number | null;
  growthPct?: number | null;
  analystCount?: number | null;
  dateLabel?: string | null;
  endDate?: string | null;
  source: string;
  updatedAt: string;
}

export function cleanEstimateNumber(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}

export function cleanAnalystCount(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

export function ratioToPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.abs(value) <= 1.5 ? value * 100 : value;
}

export function estimateDateLabel(fiscalYear: number, quarter: number, periodType: EstimatePeriodType, fallback?: string | null): string {
  if (fallback) return fallback;
  return periodType === "A" ? String(fiscalYear) : `${fiscalYear}.${quarter}Q`;
}

export function normalizeEstimateValue(
  metric: EstimateMetric,
  value: number | null | undefined,
  usdKrw: number,
): number | null {
  const n = cleanEstimateNumber(value);
  if (n == null) return null;
  return metric === "EPS" ? n : Math.round(n * usdKrw);
}

export async function upsertEstimateConsensus(db: Queryable, input: EstimateConsensusInput): Promise<number> {
  const avgValue = cleanEstimateNumber(input.avgValue);
  const lowValue = cleanEstimateNumber(input.lowValue);
  const highValue = cleanEstimateNumber(input.highValue);
  const yearAgoValue = cleanEstimateNumber(input.yearAgoValue);
  const growthPct = cleanEstimateNumber(input.growthPct);
  const analystCount = cleanAnalystCount(input.analystCount);
  const hasData = [avgValue, lowValue, highValue, yearAgoValue, growthPct, analystCount].some((v) => v != null);
  if (!hasData) return 0;

  const res = await query(
    `INSERT INTO estimate_consensus
       (corp_code, metric, fiscal_year, quarter, period_type,
        avg_value, low_value, high_value, year_ago_value, growth_pct,
        analyst_count, date_label, end_date, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, source)
     DO UPDATE SET
       avg_value = COALESCE(excluded.avg_value, estimate_consensus.avg_value),
       low_value = COALESCE(excluded.low_value, estimate_consensus.low_value),
       high_value = COALESCE(excluded.high_value, estimate_consensus.high_value),
       year_ago_value = COALESCE(excluded.year_ago_value, estimate_consensus.year_ago_value),
       growth_pct = COALESCE(excluded.growth_pct, estimate_consensus.growth_pct),
       analyst_count = COALESCE(excluded.analyst_count, estimate_consensus.analyst_count),
       date_label = COALESCE(excluded.date_label, estimate_consensus.date_label),
       end_date = COALESCE(excluded.end_date, estimate_consensus.end_date),
       updated_at = excluded.updated_at`,
    [
      input.corpCode,
      input.metric,
      input.fiscalYear,
      input.quarter,
      input.periodType,
      avgValue,
      lowValue,
      highValue,
      yearAgoValue,
      growthPct,
      analystCount,
      estimateDateLabel(input.fiscalYear, input.quarter, input.periodType, input.dateLabel),
      input.endDate ?? null,
      input.source,
      input.updatedAt,
    ],
    db,
  );
  return res.rowCount ?? 0;
}
