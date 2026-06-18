import Link from "next/link";
import { getCompaniesByCodes, getCompareGrowth, type CompanyRow, type CompareGrowthRow } from "@/lib/repo";
import { won } from "@/lib/format";
import CompareControls from "./CompareControls";
import CompareGrid, { type RowData, type Bundle, type Trans } from "./CompareGrid";

export const dynamic = "force-dynamic";

const METRICS = ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"] as const;
const MAX_CODES = 10;

type Box = { value: number; chg: number | null; isEst: boolean; period: string } | null;
type MetricCells = { qPrev: Box; qCur: Box; qNext: Box; annual: Record<number, Box> };
type CG = Record<string, MetricCells>;

function parseCodes(raw?: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.slice(0, MAX_CODES);
}

const periodOrd = (r: CompareGrowthRow) => r.fiscal_year * 4 + (r.quarter - 1);
const qLabel = (r: CompareGrowthRow) => `${String(r.fiscal_year).slice(2)}.${r.quarter}Q`;

function box(r: CompareGrowthRow, chg: number | null): Box {
  return {
    value: r.value,
    chg,
    isEst: r.is_estimate === 1,
    period: r.period_type === "Q" ? qLabel(r) : `${r.fiscal_year}`,
  };
}

function buildGrowth(rows: CompareGrowthRow[]): CG {
  const cg: CG = {};
  for (const m of METRICS) {
    const q = rows.filter((r) => r.metric === m && r.period_type === "Q"); // 연·분기 오름차순(쿼리 정렬)
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

    const annual: Record<number, Box> = {};
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

function epsGrowth(c: CompanyRow): number | null {
  if (c.eps == null || c.feps == null || c.eps === 0) return null;
  return ((c.feps - c.eps) / Math.abs(c.eps)) * 100;
}

/** 두 시점 박스 + 증감(from→to)을 Trans 로. chgBox 의 .chg 가 to 기준 증감률. */
function trans(from: Box, to: Box, chgBox: Box, la: string, lb: string): Trans {
  const parts: string[] = [];
  if (from) parts.push(`${la} ${from.period} ${won(from.value)}`);
  if (to) parts.push(`${lb} ${to.period}${to.isEst ? "E" : ""} ${won(to.value)}`);
  return { p: chgBox?.chg ?? null, t: parts.join("  →  ") };
}

function bundleFor(mc: MetricCells, CY: number): Bundle {
  return {
    qoqPrevCur: trans(mc.qPrev, mc.qCur, mc.qCur, "직전", "현재"),
    qoqCurNext: trans(mc.qCur, mc.qNext, mc.qNext, "현재", "다음"),
    yoyPrevThis: trans(mc.annual[CY - 1], mc.annual[CY], mc.annual[CY], "전년", "올해"),
    yoyThisNext: trans(mc.annual[CY], mc.annual[CY + 1], mc.annual[CY + 1], "올해", "다음년도"),
    yoyNextNext2: trans(mc.annual[CY + 1], mc.annual[CY + 2], mc.annual[CY + 2], "다음년도", "2년뒤"),
  };
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ codes?: string }>;
}) {
  const codes = parseCodes((await searchParams).codes);
  const companies = await getCompaniesByCodes(codes);
  const growthRows = await getCompareGrowth(companies.map((c) => c.corp_code));
  const CY = new Date().getFullYear();

  if (companies.length === 0) {
    return (
      <div className="panel">
        <h2>기업 비교</h2>
        <div className="empty">
          비교할 기업이 없습니다.{" "}
          <Link href="/companies" style={{ color: "var(--accent)" }}>
            전체 기업
          </Link>{" "}
          목록에서 체크박스로 기업을 골라 “기업 비교하기”를 눌러주세요.
        </div>
      </div>
    );
  }

  const data: RowData[] = companies.map((c) => {
    const cg = buildGrowth(growthRows.filter((r) => r.corp_code === c.corp_code));
    return {
      corp_code: c.corp_code,
      name: c.name,
      stock_code: c.stock_code,
      sector_name: c.sector_name,
      market: c.market,
      market_cap: c.market_cap,
      price: c.price,
      per: c.per,
      fper: c.fper,
      pbr: c.pbr,
      target_return_rate: c.target_return_rate,
      epsGrowth: epsGrowth(c),
      growth: {
        REVENUE: bundleFor(cg.REVENUE, CY),
        OPERATING_PROFIT: bundleFor(cg.OPERATING_PROFIT, CY),
        NET_INCOME: bundleFor(cg.NET_INCOME, CY),
      },
    };
  });

  return (
    <div className="panel">
      <h2>
        기업 비교{" "}
        <span className="sub">{companies.length}개 · 기업=행 / 증감=열 · 헤더 클릭 정렬 · URL 복사 시 동일</span>
        <span style={{ marginLeft: "auto" }}>
          <CompareControls codes={companies.map((c) => c.corp_code)} />
        </span>
      </h2>

      <CompareGrid data={data} />

      <p className="note">
        QoQ(직전→현재 / 현재→다음)·YoY(전년→올해→다음년도→2년뒤) 증감률입니다. 셀에 마우스를 올리면 비교한
        시점·금액이 보입니다. 추정치(현재→다음, 연간 E)는 컨센서스 구독 데이터라 데이터가 적재된 기업·기간에서만
        채워집니다. 평균 목표주가는 주가 컨센서스이므로 분기 실적 추정치 대체값으로 쓰지 않습니다 (source: keystone).
      </p>
    </div>
  );
}
