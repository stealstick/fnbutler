"use client";

import { useMemo, useState } from "react";
import { num, pct, signClass, metricLabel, parseDateLabel } from "@/lib/format";
import type { GrowthRow } from "@/lib/repo";

type Val = { metric: string; date_label: string; value: number };

const METRIC_ORDER = ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"];

export default function FinancialsTable({
  quarterly,
  annual,
  valuations,
  isFinancial,
}: {
  quarterly: GrowthRow[];
  annual: GrowthRow[];
  valuations: Val[];
  isFinancial: boolean;
}) {
  const [mode, setMode] = useState<"Q" | "A">("Q");
  const rows = mode === "Q" ? quarterly : annual;

  const table = useMemo(() => buildTable(rows, valuations, mode), [rows, valuations, mode]);

  if (quarterly.length === 0 && annual.length === 0) {
    return (
      <div className="panel">
        <h2>실적 추이</h2>
        <div className="empty">
          재무 데이터가 아직 없습니다. 상단 “최신 새로고침”으로 수집하거나, 로그인 HAR을
          임포트하면 최신 분기까지 채워집니다.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>
        실적 추이 <span className="sub">단위: 억원 · 괄호 안은 YoY · 기울임=컨센서스 추정</span>
        <span style={{ marginLeft: "auto" }}>
          <span className="toggle">
            <button className={mode === "Q" ? "on" : ""} onClick={() => setMode("Q")}>
              분기별
            </button>
            <button className={mode === "A" ? "on" : ""} onClick={() => setMode("A")}>
              연도별
            </button>
          </span>
        </span>
      </h2>
      <div className="scrollx">
        <table className="grid">
          <thead>
            <tr>
              <th className="l">지표</th>
              {table.periods.map((p) => (
                <th key={p.key}>
                  {p.label}
                  {p.isEstimate ? <span className="est"> E</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRIC_ORDER.map((m) => (
              <tr key={m}>
                <td className="l">{metricLabel(m, isFinancial)}</td>
                {table.periods.map((p) => {
                  const cell = table.cells[m]?.[p.key];
                  if (!cell) return <td key={p.key} className="muted">-</td>;
                  return (
                    <td key={p.key} className={"mono" + (cell.isEstimate ? " est" : "")}>
                      {num(Math.round(cell.value / 1e8))}
                      {cell.yoy != null && (
                        <span className={"y " + signClass(cell.yoy)}>{pct(cell.yoy)}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {(["PER", "PBR"] as const).map((m) => (
              <tr key={m}>
                <td className="l">{m}</td>
                {table.periods.map((p) => {
                  const v = table.val[m]?.[p.key];
                  return (
                    <td key={p.key} className="mono">
                      {v != null ? num(v, m === "PER" ? 1 : 2) : <span className="muted">-</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function buildTable(rows: GrowthRow[], valuations: Val[], mode: "Q" | "A") {
  // period key + label
  const periodKey = (y: number, q: number) => (mode === "Q" ? `${y}Q${q}` : `${y}`);
  const periodLabel = (y: number, q: number) =>
    mode === "Q" ? `${String(y).slice(2)}.${q}Q` : `${y}`;

  const periodMap = new Map<string, { key: string; label: string; y: number; q: number; isEstimate: boolean }>();
  const cells: Record<string, Record<string, { value: number; yoy: number | null; isEstimate: boolean }>> = {};

  for (const r of rows) {
    const key = periodKey(r.fiscal_year, r.quarter);
    if (!periodMap.has(key))
      periodMap.set(key, {
        key,
        label: periodLabel(r.fiscal_year, r.quarter),
        y: r.fiscal_year,
        q: r.quarter,
        isEstimate: false,
      });
    // actual 이 하나라도 있으면 실적으로 간주, 전부 추정이면 추정 컬럼
    if (r.is_estimate === 0) periodMap.get(key)!.isEstimate = false;
    cells[r.metric] ??= {};
    const existing = cells[r.metric][key];
    // 실적(is_estimate=0) 우선, 없으면 추정으로 채움
    if (!existing || (existing.isEstimate && r.is_estimate === 0)) {
      cells[r.metric][key] = {
        value: r.value,
        yoy: r.yoy_pct,
        isEstimate: r.is_estimate === 1,
      };
    }
  }
  // 컬럼이 전부 추정이면 헤더에 E 표시
  for (const [, p] of periodMap) {
    const anyActual = METRIC_ORDER.some((m) => cells[m]?.[p.key] && !cells[m][p.key].isEstimate);
    p.isEstimate = !anyActual;
  }

  // 밸류에이션 정렬: date_label → period
  const val: Record<string, Record<string, number>> = { PER: {}, PBR: {} };
  for (const v of valuations) {
    const pq = parseDateLabel(v.date_label);
    if (!pq) continue;
    if (mode === "A" && pq.quarter !== 4) continue; // 연간은 연말(4분기) 밸류
    const key = periodKey(pq.year, mode === "A" ? 4 : pq.quarter);
    val[v.metric] ??= {};
    val[v.metric][key] = v.value;
  }

  // 최근순(내림차순), 최대 16개 컬럼
  const periods = [...periodMap.values()]
    .sort((a, b) => b.y - a.y || b.q - a.q)
    .slice(0, mode === "Q" ? 16 : 12);

  return { periods, cells, val };
}
