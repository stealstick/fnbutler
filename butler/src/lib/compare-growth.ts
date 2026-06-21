import { won } from "./format";
import { ESTIMATE_PROVIDER_LABEL, type EstimateProvider } from "./estimate-provider";
import type { CompanyRow, CompareGrowthRow } from "./repo";

export const GROWTH_METRICS = ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"] as const;
export type GrowthMetric = (typeof GROWTH_METRICS)[number];

export type GrowthBox = { value: number; chg: number | null; isEst: boolean; period: string; source: string } | null;
export type GrowthTrans = { p: number | null; t: string };
export type GrowthBundle = {
  qoqPrevCur: GrowthTrans;
  qoqCurNext: GrowthTrans;
  yoyPrevThis: GrowthTrans;
  yoyThisNext: GrowthTrans;
  yoyNextNext2: GrowthTrans;
};
export type GrowthByMetric = Record<GrowthMetric, GrowthBundle>;

type MetricCells = { qPrev: GrowthBox; qCur: GrowthBox; qNext: GrowthBox; annual: Record<number, GrowthBox> };
type CompanyMetricCells = Record<GrowthMetric, MetricCells>;

const periodOrd = (r: CompareGrowthRow) => r.fiscal_year * 4 + (r.quarter - 1);
const qLabel = (r: CompareGrowthRow) => `${String(r.fiscal_year).slice(2)}.${r.quarter}Q`;

function box(r: CompareGrowthRow, chg: number | null): GrowthBox {
  return {
    value: r.value,
    chg,
    isEst: r.is_estimate === 1,
    period: r.period_type === "Q" ? qLabel(r) : `${r.fiscal_year}`,
    source: r.source,
  };
}

function buildMetricCells(rows: CompareGrowthRow[]): CompanyMetricCells {
  const cg = {} as CompanyMetricCells;
  for (const m of GROWTH_METRICS) {
    const q = rows.filter((r) => r.metric === m && r.period_type === "Q");
    const a = rows.filter((r) => r.metric === m && r.period_type === "A");
    const actualsQ = q.filter((r) => r.is_estimate === 0);
    const estsQ = q.filter((r) => r.is_estimate === 1);

    const cur = actualsQ.length ? actualsQ[actualsQ.length - 1] : undefined;
    let prev: CompareGrowthRow | undefined;
    let next: CompareGrowthRow | undefined;
    if (cur) {
      const py = cur.quarter > 1 ? cur.fiscal_year : cur.fiscal_year - 1;
      const pq = cur.quarter > 1 ? cur.quarter - 1 : 4;
      prev = q.find((r) => r.fiscal_year === py && r.quarter === pq);
      next = estsQ
        .filter((r) => periodOrd(r) > periodOrd(cur))
        .sort((x, y) => periodOrd(x) - periodOrd(y))[0];
    } else {
      next = estsQ[0];
    }

    const annual: Record<number, GrowthBox> = {};
    for (const r of a) annual[r.fiscal_year] = box(r, r.yoy_pct);

    cg[m] = {
      qPrev: prev ? box(prev, null) : null,
      qCur: cur ? box(cur, cur.qoq_pct) : null,
      qNext: next ? box(next, next.qoq_pct) : null,
      annual,
    };
  }
  return cg;
}

function trans(from: GrowthBox, to: GrowthBox, chgBox: GrowthBox, la: string, lb: string): GrowthTrans {
  const parts: string[] = [];
  const sourceLabel = (b: NonNullable<GrowthBox>) =>
    b.isEst
      ? ` ${ESTIMATE_PROVIDER_LABEL[b.source as EstimateProvider] ?? b.source}`
      : "";
  if (from) parts.push(`${la} ${from.period}${from.isEst ? "E" : ""}${sourceLabel(from)} ${won(from.value)}`);
  if (to) parts.push(`${lb} ${to.period}${to.isEst ? "E" : ""}${sourceLabel(to)} ${won(to.value)}`);
  return { p: chgBox?.chg ?? null, t: parts.join("  ->  ") };
}

function bundleFor(mc: MetricCells, currentYear: number): GrowthBundle {
  return {
    qoqPrevCur: trans(mc.qPrev, mc.qCur, mc.qCur, "직전", "현재"),
    qoqCurNext: trans(mc.qCur, mc.qNext, mc.qNext, "현재", "다음"),
    yoyPrevThis: trans(mc.annual[currentYear - 1], mc.annual[currentYear], mc.annual[currentYear], "전년", "올해"),
    yoyThisNext: trans(mc.annual[currentYear], mc.annual[currentYear + 1], mc.annual[currentYear + 1], "올해", "다음년도"),
    yoyNextNext2: trans(
      mc.annual[currentYear + 1],
      mc.annual[currentYear + 2],
      mc.annual[currentYear + 2],
      "다음년도",
      "2년뒤",
    ),
  };
}

export function buildGrowthByCompany(rows: CompareGrowthRow[], currentYear = new Date().getFullYear()) {
  const byCompany: Record<string, GrowthByMetric> = {};
  const codes = Array.from(new Set(rows.map((r) => r.corp_code)));
  for (const code of codes) {
    const cg = buildMetricCells(rows.filter((r) => r.corp_code === code));
    byCompany[code] = {
      REVENUE: bundleFor(cg.REVENUE, currentYear),
      OPERATING_PROFIT: bundleFor(cg.OPERATING_PROFIT, currentYear),
      NET_INCOME: bundleFor(cg.NET_INCOME, currentYear),
    };
  }
  return byCompany;
}

export function epsGrowth(c: Pick<CompanyRow, "eps" | "feps">): number | null {
  if (c.eps == null || c.feps == null || c.eps === 0) return null;
  return ((c.feps - c.eps) / Math.abs(c.eps)) * 100;
}
