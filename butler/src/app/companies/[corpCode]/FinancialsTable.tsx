"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { num, pct, signClass, metricLabel, parseDateLabel } from "@/lib/format";
import type { GrowthRow } from "@/lib/repo";
import EstimateProviderToggle, { useEstimateProvider } from "@/components/EstimateProviderToggle";
import {
  DEFAULT_ESTIMATE_PROVIDER,
  DEFAULT_GLOBAL_ESTIMATE_PROVIDER,
  DOMESTIC_ESTIMATE_PROVIDERS,
  GLOBAL_ESTIMATE_PROVIDERS,
  type EstimateProvider,
} from "@/lib/estimate-provider";

type Val = { metric: string; date_label: string; value: number };

const METRIC_ORDER = ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"];

export default function FinancialsTable({
  corpCode,
  quarterly,
  annual,
  valuations,
  isFinancial,
  isNasdaq,
}: {
  corpCode: string;
  quarterly: GrowthRow[];
  annual: GrowthRow[];
  valuations: Val[];
  isFinancial: boolean;
  isNasdaq: boolean;
}) {
  const [mode, setMode] = useState<"Q" | "A">("Q");
  const [estimateProvider, setEstimateProvider] = useEstimateProvider();
  const providers: readonly EstimateProvider[] = isNasdaq ? GLOBAL_ESTIMATE_PROVIDERS : DOMESTIC_ESTIMATE_PROVIDERS;
  const activeEstimateProvider = providers.includes(estimateProvider)
    ? estimateProvider
    : isNasdaq
      ? DEFAULT_GLOBAL_ESTIMATE_PROVIDER
      : DEFAULT_ESTIMATE_PROVIDER;
  const [qRows, setQRows] = useState(quarterly);
  const [aRows, setARows] = useState(annual);
  const rows = mode === "Q" ? qRows : aRows;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const fetchRows = (period: "Q" | "A") => {
      const sp = new URLSearchParams({ period, provider: activeEstimateProvider });
      return fetch(`/api/companies/${corpCode}/financials?${sp.toString()}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`financials ${r.status}`))))
        .then((d) => d.rows ?? []);
    };
    Promise.all([fetchRows("Q"), fetchRows("A")])
      .then(([q, a]) => {
        setQRows(q);
        setARows(a);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setQRows(quarterly);
          setARows(annual);
        }
      });
    return () => controller.abort();
  }, [activeEstimateProvider, annual, corpCode, quarterly]);

  const table = useMemo(() => buildTable(rows, valuations, mode), [rows, valuations, mode]);
  const periodSignature = table.periods.map((p) => p.key).join("|");

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let cancelled = false;
    const scrollToLatest = () => {
      if (cancelled) return;
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    };
    const frame = requestAnimationFrame(scrollToLatest);
    const timers = [window.setTimeout(scrollToLatest, 80), window.setTimeout(scrollToLatest, 320)];
    document.fonts?.ready.then(scrollToLatest).catch(() => undefined);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [activeEstimateProvider, periodSignature]);

  if (qRows.length === 0 && aRows.length === 0) {
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
        실적 추이 <span className="sub">단위: 억원 · 분기=QoQ · 연도=YoY · 기울임=컨센서스 추정</span>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <EstimateProviderToggle provider={activeEstimateProvider} onChange={setEstimateProvider} providers={providers} />
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
      <div ref={scrollRef} className="table-scroll financial-table">
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
                  const change = mode === "Q" ? cell.qoq : cell.yoy;
                  const changeLabel = mode === "Q" ? "QoQ" : "YoY";
                  return (
                    <td key={p.key} className={"mono" + (cell.isEstimate ? " est" : "")}>
                      {num(Math.round(cell.value / 1e8))}
                      {change != null && (
                        <span className={"y " + signClass(change)} title={`${changeLabel} ${pct(change)}`}>
                          {pct(change)}
                        </span>
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
      <p className="note">
        기간은 중간 결산기를 건너뛰지 않고 표시합니다. 분기별 퍼센트는 직전 분기 대비, 연도별 퍼센트는 전년 대비입니다.
        원천 데이터에 해당 분기/연도 값이 없으면 “-”로 남습니다.
      </p>
    </div>
  );
}

function buildTable(rows: GrowthRow[], valuations: Val[], mode: "Q" | "A") {
  // period key + label
  const periodKey = (y: number, q: number) => (mode === "Q" ? `${y}Q${q}` : `${y}`);
  const periodLabel = (y: number, q: number) =>
    mode === "Q" ? `${String(y).slice(2)}.${q}Q` : `${y}`;

  const periodMap = new Map<string, { key: string; label: string; y: number; q: number; isEstimate: boolean }>();
  const cells: Record<
    string,
    Record<string, { value: number; qoq: number | null; yoy: number | null; isEstimate: boolean }>
  > = {};

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
        qoq: r.qoq_pct,
        yoy: r.yoy_pct,
        isEstimate: r.is_estimate === 1,
      };
    }
  }
  fillMissingPeriods(periodMap, mode, periodKey, periodLabel);

  // 컬럼이 전부 추정이면 헤더에 E 표시
  for (const [, p] of periodMap) {
    const hasAny = METRIC_ORDER.some((m) => cells[m]?.[p.key]);
    const anyActual = METRIC_ORDER.some((m) => cells[m]?.[p.key] && !cells[m][p.key].isEstimate);
    p.isEstimate = hasAny && !anyActual;
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

  // 최근 기간을 최대 개수만큼 고른 뒤, 좌→우가 과거→현재/미래가 되도록 오름차순 표시.
  const periods = [...periodMap.values()]
    .sort((a, b) => b.y - a.y || b.q - a.q)
    .slice(0, mode === "Q" ? 16 : 12)
    .sort((a, b) => a.y - b.y || a.q - b.q);

  return { periods, cells, val };
}

function fillMissingPeriods(
  periodMap: Map<string, { key: string; label: string; y: number; q: number; isEstimate: boolean }>,
  mode: "Q" | "A",
  periodKey: (y: number, q: number) => string,
  periodLabel: (y: number, q: number) => string,
) {
  const periods = [...periodMap.values()];
  if (periods.length < 2) return;

  const minOrd = Math.min(...periods.map((p) => (mode === "Q" ? p.y * 4 + (p.q - 1) : p.y)));
  const maxOrd = Math.max(...periods.map((p) => (mode === "Q" ? p.y * 4 + (p.q - 1) : p.y)));

  for (let ord = minOrd; ord <= maxOrd; ord++) {
    const y = mode === "Q" ? Math.floor(ord / 4) : ord;
    const q = mode === "Q" ? (ord % 4) + 1 : 0;
    const key = periodKey(y, q);
    if (periodMap.has(key)) continue;
    periodMap.set(key, { key, label: periodLabel(y, q), y, q, isEstimate: false });
  }
}
