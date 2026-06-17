import Link from "next/link";
import type { ReactNode } from "react";
import { getCompaniesByCodes, getCompareGrowth, type CompanyRow, type CompareGrowthRow } from "@/lib/repo";
import { won, num, pct, signClass, metricLabel } from "@/lib/format";
import InfoTip from "@/components/InfoTip";
import CompareControls from "./CompareControls";

export const dynamic = "force-dynamic";

const METRICS = ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"] as const;
const MAX_CODES = 10;

/** 한 시점 셀: 값 + 직전 시점 대비 증감률(chg) + 추정 여부 + 기간 라벨. */
type Box = { value: number; chg: number | null; isEst: boolean; period: string } | null;
type MetricCells = {
  qPrev: Box; // 직전 분기
  qCur: Box; // 현재(최근 실적) 분기 — chg = 직전→현재 QoQ
  qNext: Box; // 다음 분기(추정) — chg = 현재→다음 QoQ
  annual: Record<number, Box>; // 회계연도별 (chg = 전년 대비 YoY)
};
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
      prev = q.find((r) => r.fiscal_year === py && r.quarter === pq); // 달력상 직전 분기
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

const dash = <span className="muted">-</span>;

function chgBadge(chg: number | null): ReactNode {
  if (chg == null) return null;
  const cls = signClass(chg);
  const arrow = chg > 0 ? "▲" : chg < 0 ? "▼" : "–";
  return (
    <span className={"prog-chg " + cls}>
      {arrow} {pct(chg)}
    </span>
  );
}

/** 시점 셀: 큰 값 + 기간 + (증감 배지). showChg=false 면 기준 시점(배지 없음). */
function progCell(b: Box, showChg = true): ReactNode {
  if (!b) return dash;
  return (
    <div className="prog">
      <div className="prog-top">
        <span className={"prog-val" + (b.isEst ? " est" : "")}>{won(b.value)}</span>
        <span className="prog-period">
          {b.period}
          {b.isEst ? " E" : ""}
        </span>
      </div>
      {showChg && chgBadge(b.chg)}
    </div>
  );
}

function epsGrowth(c: CompanyRow): number | null {
  if (c.eps == null || c.feps == null || c.eps === 0) return null;
  return ((c.feps - c.eps) / Math.abs(c.eps)) * 100;
}

type Row =
  | { group: string }
  | { label: string; tip?: string; left?: boolean; render: (c: CompanyRow, g: CG) => ReactNode };

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ codes?: string }>;
}) {
  const codes = parseCodes((await searchParams).codes);
  const companies = getCompaniesByCodes(codes);
  const growthRows = getCompareGrowth(companies.map((c) => c.corp_code));

  const growthByCorp: Record<string, CG> = {};
  for (const c of companies) {
    growthByCorp[c.corp_code] = buildGrowth(growthRows.filter((r) => r.corp_code === c.corp_code));
  }
  const validCodes = companies.map((c) => c.corp_code);
  const CY = new Date().getFullYear(); // 올해 기준연도

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

  // ---- 행 정의 (지표=행, 기업=열) ----
  const rows: Row[] = [
    { group: "시세 · 밸류에이션" },
    { label: "섹터", left: true, render: (c) => c.sector_name || c.market || "-" },
    { label: "시가총액", render: (c) => won(c.market_cap) },
    { label: "현재가", render: (c) => num(c.price) },
    {
      label: "등락률",
      render: (c) => <span className={signClass(c.fluctuation_rate)}>{pct(c.fluctuation_rate)}</span>,
    },
    { label: "PER", render: (c) => (c.per != null ? num(c.per, 1) : dash) },
    {
      label: "선행 PER",
      tip: "향후 12개월 추정 EPS 기준 PER(fPER). 낮을수록 이익 대비 저평가.",
      render: (c) => (c.fper != null ? num(c.fper, 1) : dash),
    },
    { label: "PBR", render: (c) => (c.pbr != null ? num(c.pbr, 2) : dash) },
    {
      label: "배당수익률",
      render: (c) => (c.dividend_yield != null ? `${num(c.dividend_yield, 2)}%` : dash),
    },
    { group: "컨센서스 · 목표주가" },
    { label: "평균 목표주가", render: (c) => (c.target_price_avg ? num(c.target_price_avg) : dash) },
    {
      label: "상승여력",
      render: (c) =>
        c.target_return_rate != null ? (
          <span className={signClass(c.target_return_rate)}>{pct(c.target_return_rate)}</span>
        ) : (
          dash
        ),
    },
    { label: "커버 증권사", render: (c) => (c.cover_securities ? `${c.cover_securities}곳` : dash) },
    { group: "이익 (EPS · 향후 추정)" },
    { label: "EPS", render: (c) => (c.eps != null ? num(c.eps) : dash) },
    {
      label: "선행 EPS (올해 E)",
      tip: "컨센서스 기준 향후 12개월 추정 주당순이익.",
      render: (c) => (c.feps != null ? <span className="est">{num(c.feps)}</span> : dash),
    },
    {
      label: "EPS 성장률 (E)",
      tip: "(선행 EPS − EPS) / |EPS|. 향후 1년 이익 성장 추정 — 전 기업 비교 가능.",
      render: (c) => {
        const g = epsGrowth(c);
        return g != null ? (
          <span className={"prog-chg " + signClass(g)}>
            {g > 0 ? "▲" : g < 0 ? "▼" : "–"} {pct(g)}
          </span>
        ) : (
          dash
        );
      },
    },
  ];

  // ---- 지표별 분기 progression(직전→현재→다음) + 연간 YoY 사다리(전년→올해→내년→내후년) ----
  for (const m of METRICS) {
    const label = metricLabel(m);
    // 분기: 데이터가 하나라도 있는 기업이 있을 때만 표시
    const hasQ = companies.some((c) => {
      const g = growthByCorp[c.corp_code][m];
      return g.qPrev || g.qCur || g.qNext;
    });
    if (hasQ) {
      rows.push({ group: `${label} · 분기 (직전 → 현재 → 다음)` });
      rows.push({ label: "직전분기", render: (_c, g) => progCell(g[m].qPrev, false) });
      rows.push({
        label: "현재분기",
        tip: "최근 실적 분기. 증감 배지 = 직전분기 대비 QoQ.",
        render: (_c, g) => progCell(g[m].qCur),
      });
      rows.push({
        label: "다음분기 (E)",
        tip: "다음 분기 컨센서스 추정. 증감 배지 = 현재분기 대비 QoQ. 추정은 구독 데이터라 일부 기업만.",
        render: (_c, g) => progCell(g[m].qNext),
      });
    }
    // 연간: 올해 기준 전년~2년뒤 중 데이터가 있는 기업이 있을 때만
    const annualYears = [CY - 1, CY, CY + 1, CY + 2];
    const hasA = companies.some((c) =>
      annualYears.some((y) => growthByCorp[c.corp_code][m].annual[y]),
    );
    if (hasA) {
      rows.push({ group: `${label} · 연간 (전년 → 올해 → 다음년도 → 2년뒤, YoY)` });
      const aLabels: Record<number, string> = {
        [CY - 1]: `전년 ${CY - 1}`,
        [CY]: `올해 ${CY} (E)`,
        [CY + 1]: `다음년도 ${CY + 1} (E)`,
        [CY + 2]: `2년뒤 ${CY + 2} (E)`,
      };
      for (const y of annualYears) {
        rows.push({
          label: aLabels[y],
          render: (_c, g) => progCell(g[m].annual[y], y !== CY - 1),
        });
      }
    }
  }

  return (
    <div className="panel">
      <h2>
        기업 비교{" "}
        <span className="sub">{companies.length}개 · 지표별 나란히 보기 · URL 복사 시 동일 결과</span>
        <span style={{ marginLeft: "auto" }}>
          <CompareControls codes={validCodes} />
        </span>
      </h2>

      <div className="scrollx">
        <table className="grid cmp-table">
          <thead>
            <tr>
              <th className="l cmp-corner">지표</th>
              {companies.map((c) => {
                const rest = validCodes.filter((x) => x !== c.corp_code);
                return (
                  <th key={c.corp_code} className="cmp-co">
                    <div className="cmp-co-head">
                      <Link href={`/companies/${c.corp_code}`} className="cmp-co-name">
                        {c.name}
                      </Link>
                      <Link
                        href={rest.length ? `/compare?codes=${rest.join(",")}` : "/compare"}
                        className="cmp-x"
                        title="비교에서 제거"
                      >
                        ✕
                      </Link>
                    </div>
                    <div className="cmp-co-sub mono">{c.stock_code}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) =>
              "group" in row ? (
                <tr key={`g${i}`} className="cmp-group">
                  <td className="l" colSpan={companies.length + 1}>
                    {row.group}
                  </td>
                </tr>
              ) : (
                <tr key={`r${i}`}>
                  <td className="l cmp-rowlabel">
                    {row.label}
                    {row.tip && <InfoTip text={row.tip} />}
                  </td>
                  {companies.map((c) => (
                    <td key={c.corp_code} className={row.left ? "l" : "mono"}>
                      {row.render(c, growthByCorp[c.corp_code])}
                    </td>
                  ))}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      <p className="note">
        분기 progression은 <strong>직전→현재(QoQ)</strong>, <strong>현재→다음 추정(QoQ)</strong>을, 연간은{" "}
        <strong>전년→올해→다음년도→2년뒤(YoY)</strong>를 보여줍니다. 추정치(선행 EPS·다음 분기/연간)는
        컨센서스 구독 데이터라 커버리지가 제한적이라, 데이터가 적재된 기업·기간에서만 채워집니다
        (source: butler).
      </p>
    </div>
  );
}
