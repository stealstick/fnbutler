import Link from "next/link";
import type { ReactNode } from "react";
import { getCompaniesByCodes, getCompareGrowth, type CompanyRow, type CompareGrowthRow } from "@/lib/repo";
import { won, num, pct, signClass, metricLabel } from "@/lib/format";
import InfoTip from "@/components/InfoTip";
import CompareControls from "./CompareControls";

export const dynamic = "force-dynamic";

const METRICS = ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"] as const;
const MAX_CODES = 10;

type Cell = { label: string; value: number; qoq: number | null; yoy: number | null; isEst: boolean };
type MetricGrowth = { latest?: Cell; fwd?: Cell; annualEst?: Cell };
type CG = Record<string, MetricGrowth>;

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

function toCell(r: CompareGrowthRow): Cell {
  const label =
    r.period_type === "Q"
      ? `${String(r.fiscal_year).slice(2)}.${r.quarter}Q${r.is_estimate ? "(E)" : ""}`
      : `${r.fiscal_year}${r.is_estimate ? "(E)" : ""}`;
  return { label, value: r.value, qoq: r.qoq_pct, yoy: r.yoy_pct, isEst: r.is_estimate === 1 };
}

const periodOrd = (r: CompareGrowthRow) => r.fiscal_year * 4 + (r.quarter - 1);

function buildGrowth(rows: CompareGrowthRow[]): CG {
  const cg: CG = {};
  for (const m of METRICS) {
    const q = rows.filter((r) => r.metric === m && r.period_type === "Q"); // 연·분기 오름차순(쿼리 정렬)
    const a = rows.filter((r) => r.metric === m && r.period_type === "A");
    const actualsQ = q.filter((r) => r.is_estimate === 0);
    const estsQ = q.filter((r) => r.is_estimate === 1);
    const latestActual = actualsQ.length ? actualsQ[actualsQ.length - 1] : undefined;
    // 추정: 최근 실적 분기 이후의 가장 가까운 추정 분기(없으면 가장 이른 추정)
    const afterActual = latestActual
      ? estsQ.filter((r) => periodOrd(r) > periodOrd(latestActual))
      : estsQ;
    const fwdRow = (afterActual.length ? afterActual : estsQ)[0];
    const annualEsts = a.filter((r) => r.is_estimate === 1);
    cg[m] = {
      latest: latestActual ? toCell(latestActual) : undefined,
      fwd: fwdRow ? toCell(fwdRow) : undefined,
      annualEst: annualEsts.length ? toCell(annualEsts[annualEsts.length - 1]) : undefined,
    };
  }
  return cg;
}

const dash = <span className="muted">-</span>;

function growthCell(cell?: Cell): ReactNode {
  if (!cell) return dash;
  return (
    <>
      <span className={cell.isEst ? "est" : undefined}>{won(cell.value)}</span>
      <span className="y">
        {cell.label}
        {cell.qoq != null && (
          <> · QoQ <span className={signClass(cell.qoq)}>{pct(cell.qoq)}</span></>
        )}
        {cell.yoy != null && (
          <> · YoY <span className={signClass(cell.yoy)}>{pct(cell.yoy)}</span></>
        )}
      </span>
    </>
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
  const anyAnnualEst = companies.some((c) =>
    METRICS.some((m) => growthByCorp[c.corp_code][m]?.annualEst),
  );

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
      tip: "(선행 EPS − EPS) / |EPS|. 향후 1년 이익 성장 추정치 — 전 기업 비교 가능.",
      render: (c) => {
        const g = epsGrowth(c);
        return g != null ? <span className={signClass(g)}>{pct(g)}</span> : dash;
      },
    },
  ];

  for (const m of METRICS) {
    rows.push({ group: `${metricLabel(m)} (분기 QoQ·YoY)` });
    rows.push({ label: "최근 분기", render: (_c, g) => growthCell(g[m]?.latest) });
    rows.push({
      label: "추정 (다음 분기~)",
      tip: "실적→추정 경계를 넘어 계산한 증감률. 추정 분기는 구독 데이터라 일부 기업만 채워집니다.",
      render: (_c, g) => growthCell(g[m]?.fwd),
    });
    if (anyAnnualEst) {
      rows.push({ label: "연간 추정 (E)", render: (_c, g) => growthCell(g[m]?.annualEst) });
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
        추정치(선행 EPS·선행 PER, 분기/연간 추정 실적)는 컨센서스 구독 데이터라 커버리지가 제한적입니다.
        매출·영업이익·당기순이익의 분기 QoQ/YoY는 재무 시계열이 적재된 기업에서만 표시됩니다 (source: butler).
      </p>
    </div>
  );
}
