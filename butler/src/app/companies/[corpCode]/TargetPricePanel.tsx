"use client";

import { useMemo, useState } from "react";
import { num, pct, ratingChangeBadge, signClass } from "@/lib/format";
import InfoTip from "@/components/InfoTip";

const UPSIDE_TIP =
  "상승여력 = 증권사 컨센서스 평균 목표주가 ÷ 현재가 − 1. 애널리스트들이 제시한 목표주가까지의 기대 상승률(괴리율)입니다. 개별 행은 해당 증권사 목표주가 기준.";

type BrokerTarget = {
  broker: string;
  research_url: string | null;
  analyst: string | null;
  report_date: string;
  target_price: number | null;
  target_price_change: string | null;
  rating: string | null;
  rating_change: string | null;
  return_rate: number | null;
  price_close: number | null;
  ai_summary: string | null;
  report_id: string;
};

type BrokerTargetHistory = BrokerTarget & {
  previous_target_price: number | null;
  target_delta: number | null;
  target_delta_pct: number | null;
};

type MonthlyTarget = {
  month: string;
  full_date: string | null;
  tp_max: number | null;
  tp_avg: number | null;
  tp_min: number | null;
  price: number | null;
  cover_securities: number | null;
};

export default function TargetPricePanel({
  brokers,
  history,
  monthly,
  currentPrice,
  averageTarget,
  averageReturn,
  coverCount,
}: {
  brokers: BrokerTarget[];
  history: BrokerTargetHistory[];
  monthly: MonthlyTarget[];
  currentPrice: number | null;
  averageTarget: number | null;
  averageReturn: number | null;
  coverCount: number | null;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const latestChangeByBroker = useMemo(() => {
    const m = new Map<string, BrokerTargetHistory>();
    for (const row of history) if (!m.has(row.broker)) m.set(row.broker, row);
    return m;
  }, [history]);
  const filteredBrokers = useMemo(
    () =>
      brokers.filter((b) => {
        if (!q) return true;
        return `${b.broker} ${b.analyst ?? ""} ${b.rating ?? ""}`.toLowerCase().includes(q);
      }),
    [brokers, q],
  );
  const filteredHistory = useMemo(
    () =>
      history.filter((h) => {
        if (!q) return true;
        return `${h.broker} ${h.analyst ?? ""} ${h.rating ?? ""}`.toLowerCase().includes(q);
      }),
    [history, q],
  );

  const maxTarget = Math.max(1, ...brokers.map((b) => b.target_price ?? 0));

  return (
    <div className="panel">
      <h2>
        증권사별 목표주가
        <span className="sub">목표가 분포와 증권사별 최신 리포트 비교</span>
      </h2>

      {averageTarget ? (
        <div className="tp-hero" style={{ marginBottom: 16 }}>
          <div>
            <div className="lbl">평균 목표주가</div>
            <div className="big mono">{num(averageTarget)}</div>
          </div>
          <div>
            <div className="lbl">현재가</div>
            <div className="big mono">{num(currentPrice)}</div>
          </div>
          <div>
            <div className="lbl">평균 상승여력<InfoTip text={UPSIDE_TIP} /></div>
            <div className={"big mono " + signClass(averageReturn)}>{pct(averageReturn)}</div>
          </div>
          <div>
            <div className="lbl">커버 증권사</div>
            <div className="big mono">{coverCount ?? brokers.length}곳</div>
          </div>
        </div>
      ) : null}

      {monthly.length ? (
        <TargetChart rows={monthly} currentPrice={currentPrice} averageTarget={averageTarget} />
      ) : null}

      <div className="toolbar" style={{ marginTop: 16 }}>
        <input
          className="input search"
          placeholder="증권사 · 애널리스트 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <span className="muted">
          최신 {filteredBrokers.length}/{brokers.length}곳 · 히스토리 {filteredHistory.length}건
        </span>
      </div>

      {brokers.length === 0 ? (
        <div className="empty">
          아직 수집된 컨센서스 리포트가 없습니다. “최신 새로고침”을 눌러 butler 에서 가져오세요.
        </div>
      ) : (
        <div className="table-scroll target-table">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">증권사</th>
                <th className="l">애널리스트</th>
                <th>리포트일</th>
                <th className="l">투자의견</th>
                <th>목표주가</th>
                <th>직전 대비</th>
                <th className="l">목표가 (상대)</th>
                <th>변경</th>
                <th>상승여력<InfoTip text={UPSIDE_TIP} /></th>
              </tr>
            </thead>
            <tbody>
              {filteredBrokers.map((b) => {
                const badge = ratingChangeBadge(b.target_price_change);
                const isBuy = (b.rating ?? "").match(/BUY|매수|Buy/);
                const latestChange = latestChangeByBroker.get(b.broker);
                return (
                  <tr key={b.report_id}>
                    <td className="l">
                      {b.research_url ? (
                        <a href={b.research_url} target="_blank" rel="noreferrer">
                          <strong>{b.broker}</strong>
                        </a>
                      ) : (
                        <strong>{b.broker}</strong>
                      )}
                      {b.ai_summary && (
                        <details className="ai">
                          <summary>AI 요약</summary>
                          <div className="body">{b.ai_summary}</div>
                        </details>
                      )}
                    </td>
                    <td className="l muted">{b.analyst || "-"}</td>
                    <td className="mono muted">{b.report_date}</td>
                    <td className="l">
                      <span className={"pill " + (isBuy ? "buy" : "")}>{b.rating || "-"}</span>
                    </td>
                    <td className="mono">
                      <strong>{num(b.target_price)}</strong>
                    </td>
                    <td className={"mono " + signClass(latestChange?.target_delta_pct)}>
                      {latestChange?.target_delta_pct != null ? pct(latestChange.target_delta_pct) : "-"}
                    </td>
                    <td className="l">
                      <div className="bar">
                        <span style={{ width: `${((b.target_price ?? 0) / maxTarget) * 100}%` }} />
                      </div>
                    </td>
                    <td>
                      <span className={"pill " + badge.kind}>{badge.label}</span>
                    </td>
                    <td className={"mono " + signClass(b.return_rate)}>{pct(b.return_rate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {history.length ? (
        <>
          <h2 style={{ marginTop: 18 }}>
            목표주가 히스토리 <span className="sub">리포트 발간일 기준, 직전 리포트 대비 변화율</span>
          </h2>
          <div className="table-scroll history-table">
            <table className="grid">
              <thead>
                <tr>
                  <th>리포트일</th>
                  <th className="l">증권사</th>
                  <th className="l">애널리스트</th>
                  <th>직전</th>
                  <th>목표주가</th>
                  <th>변화</th>
                  <th>상승여력<InfoTip text={UPSIDE_TIP} /></th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((h) => (
                  <tr key={h.report_id}>
                    <td className="mono muted">{h.report_date}</td>
                    <td className="l">{h.broker}</td>
                    <td className="l muted">{h.analyst || "-"}</td>
                    <td className="mono muted">{num(h.previous_target_price)}</td>
                    <td className="mono">{num(h.target_price)}</td>
                    <td className={"mono " + signClass(h.target_delta_pct)}>
                      {h.target_delta_pct != null ? pct(h.target_delta_pct) : "신규"}
                    </td>
                    <td className={"mono " + signClass(h.return_rate)}>{pct(h.return_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <p className="note">
        변경 이력의 수집일과 달리 이 영역은 증권사 리포트 발간일을 기준으로 표시합니다.
        증권사별 과거 리포트가 아직 적게 수집된 경우 직전 대비 변화율은 비어 있을 수 있습니다.
      </p>
    </div>
  );
}

function TargetChart({
  rows,
  currentPrice,
  averageTarget,
}: {
  rows: MonthlyTarget[];
  currentPrice: number | null;
  averageTarget: number | null;
}) {
  const chartRows = rows.filter((r) => r.price != null || r.tp_avg != null || r.tp_max != null || r.tp_min != null);
  if (chartRows.length === 0) return null;
  const values = chartRows.flatMap((r) => [r.price, r.tp_avg, r.tp_max, r.tp_min]).filter((v): v is number => v != null);
  if (values.length === 0) return null;
  const min = Math.min(...values) * 0.92;
  const max = Math.max(...values) * 1.04;
  const width = 920;
  const height = 210;
  const pad = { top: 16, right: 18, bottom: 34, left: 56 };
  const x = (i: number) =>
    pad.left + (chartRows.length === 1 ? 0 : (i * (width - pad.left - pad.right)) / (chartRows.length - 1));
  const y = (v: number) => pad.top + ((max - v) * (height - pad.top - pad.bottom)) / Math.max(1, max - min);
  const line = (key: keyof MonthlyTarget) =>
    chartRows
      .map((r, i) => (typeof r[key] === "number" ? `${x(i)},${y(r[key] as number)}` : ""))
      .filter(Boolean)
      .join(" ");
  const last = chartRows[chartRows.length - 1];

  return (
    <div className="target-chart">
      <div className="chart-head">
        <div>
          <div className="chart-title">월별 목표주가 추이</div>
          <div className="muted">평균 목표가, 고저 범위, 월말 주가</div>
        </div>
        <div className="chart-legend">
          <span><i className="avg" />평균 목표</span>
          <span><i className="price" />주가</span>
          <span><i className="range" />고저 범위</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="월별 목표주가 차트">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yy = pad.top + t * (height - pad.top - pad.bottom);
          const val = max - t * (max - min);
          return (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={yy} y2={yy} className="grid-line" />
              <text x={pad.left - 10} y={yy + 4} textAnchor="end" className="axis-text">
                {num(Math.round(val))}
              </text>
            </g>
          );
        })}
        {chartRows.map((r, i) =>
          r.tp_min != null && r.tp_max != null ? (
            <line key={r.month} x1={x(i)} x2={x(i)} y1={y(r.tp_min)} y2={y(r.tp_max)} className="range-line" />
          ) : null,
        )}
        <polyline points={line("tp_avg")} className="avg-line" />
        <polyline points={line("price")} className="price-line" />
        {currentPrice != null ? (
          <line x1={pad.left} x2={width - pad.right} y1={y(currentPrice)} y2={y(currentPrice)} className="current-line" />
        ) : null}
        {chartRows.map((r, i) => (
          <g key={`${r.month}-dot`}>
            {r.tp_avg != null ? <circle cx={x(i)} cy={y(r.tp_avg)} r="3.5" className="avg-dot" /> : null}
            {r.price != null ? <circle cx={x(i)} cy={y(r.price)} r="3" className="price-dot" /> : null}
            <text x={x(i)} y={height - 10} textAnchor="middle" className="axis-text">
              {r.month}
            </text>
          </g>
        ))}
      </svg>
      <div className="chart-summary">
        최신 {last.full_date ?? last.month} · 평균 목표 {num(last.tp_avg ?? averageTarget)} · 현재/월말 주가{" "}
        {num(currentPrice ?? last.price)}
      </div>
    </div>
  );
}
