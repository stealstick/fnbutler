"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { won, num, pct, price as stockPrice, signClass } from "@/lib/format";
import { useTableSort, SortTh } from "@/components/sortable";
import { epsGrowth, type GrowthBundle, type GrowthByMetric, type GrowthMetric } from "@/lib/compare-growth";
import type { CompanyRow } from "@/lib/repo";
import EstimateProviderToggle, { useEstimateProvider } from "@/components/EstimateProviderToggle";

const GROWTH_METRICS: Array<{ key: GrowthMetric; label: string }> = [
  { key: "REVENUE", label: "매출액" },
  { key: "OPERATING_PROFIT", label: "영업이익" },
  { key: "NET_INCOME", label: "당기순이익" },
];
const GROWTH_SORT_KEYS = new Set(["epsGrowth", "qoqPrevCur", "qoqCurNext", "yoyPrevThis", "yoyThisNext", "yoyNextNext2"]);

export default function SectorCompaniesTable({
  sectorCode,
  companies,
  growthByCompany,
}: {
  sectorCode: string;
  companies: CompanyRow[];
  growthByCompany: Record<string, GrowthByMetric>;
}) {
  const [metric, setMetric] = useState<GrowthMetric>("REVENUE");
  const [estimateProvider, setEstimateProvider] = useEstimateProvider();
  const [rows, setRows] = useState(companies);
  const [growth, setGrowth] = useState(growthByCompany);
  const codeList = rows.map((c) => c.corp_code).join(",");

  useEffect(() => {
    const controller = new AbortController();
    const sp = new URLSearchParams({ sort: "target_return_rate", provider: estimateProvider });
    fetch(`/api/sectors/${sectorCode}?${sp.toString()}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`sector ${r.status}`))))
      .then((d) => setRows(d.companies ?? companies))
      .catch((e) => {
        if (e.name !== "AbortError") setRows(companies);
      });
    return () => controller.abort();
  }, [companies, estimateProvider, sectorCode]);

  useEffect(() => {
    if (!codeList) {
      setGrowth({});
      return;
    }
    const controller = new AbortController();
    const sp = new URLSearchParams({ codes: codeList, provider: estimateProvider });
    fetch(`/api/companies/growth?${sp.toString()}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`growth ${r.status}`))))
      .then((d) => setGrowth(d.results ?? {}))
      .catch((e) => {
        if (e.name !== "AbortError") setGrowth({});
      });
    return () => controller.abort();
  }, [codeList, estimateProvider]);

  const getVal = useCallback(
    (c: CompanyRow, k: string) => {
      if (k === "name") return c.name;
      if (k === "epsGrowth") return epsGrowth(c);
      if (GROWTH_SORT_KEYS.has(k)) return growth[c.corp_code]?.[metric]?.[k as keyof GrowthBundle]?.p ?? null;
      return (c as unknown as Record<string, number | null>)[k] ?? null;
    },
    [growth, metric],
  );
  const { sorted, sortKey, dir, onSort } = useTableSort(rows, getVal, "target_return_rate");
  const th = (label: string, k: string, align?: "l", defaultDir?: "asc" | "desc", className?: string) => (
    <SortTh
      label={label}
      k={k}
      sortKey={sortKey}
      dir={dir}
      onSort={onSort}
      align={align}
      defaultDir={defaultDir}
      className={className}
    />
  );
  const growthCell = (c: CompanyRow, key: keyof GrowthBundle) => {
    const t = growth[c.corp_code]?.[metric]?.[key];
    return <GrowthPct p={t?.p ?? null} title={t?.t} />;
  };

  return (
    <>
      <div className="toolbar growth-toolbar">
        <span className="muted" style={{ fontSize: 12 }}>성장률 기준 지표</span>
        <span className="toggle">
          {GROWTH_METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? "on" : ""} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </span>
        <span className="muted growth-hint">전체기업 표와 같은 기준으로 표시</span>
        <EstimateProviderToggle provider={estimateProvider} onChange={setEstimateProvider} />
      </div>
      <div className="scrollx">
        <table className="grid companies-table">
          <thead>
            <tr>
              {th("종목", "name", "l", "asc", "sticky-col sticky-name sticky-name-start")}
              {th("EPS성장E", "epsGrowth")}
              {th("QoQ 직전→현재", "qoqPrevCur")}
              {th("QoQ 현재→다음E", "qoqCurNext")}
              {th("YoY 전년→올해E", "yoyPrevThis")}
              {th("YoY 올해→다음년E", "yoyThisNext")}
              {th("YoY 다음년→2년뒤E", "yoyNextNext2")}
              {th("현재가", "price")}
              {th("등락", "fluctuation_rate")}
              {th("시가총액", "market_cap")}
              {th("PER", "per", undefined, "asc")}
              {th("PER 올해E", "forward_per_y0", undefined, "asc")}
              {th("PER 다음년E", "forward_per_y1", undefined, "asc")}
              {th("PER 2년뒤E", "forward_per_y2", undefined, "asc")}
              {th("PBR", "pbr", undefined, "asc")}
              {th("평균 목표주가", "target_price_avg")}
              {th("상승여력", "target_return_rate")}
              {th("커버", "cover_securities")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.corp_code}>
                <td className="l sticky-col sticky-name sticky-name-start">
                  <Link href={`/companies/${c.corp_code}`}>
                    <strong>{c.name}</strong>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>{c.stock_code}</span>
                  </Link>
                </td>
                <td className="mono"><GrowthPct p={epsGrowth(c)} /></td>
                <td className="mono">{growthCell(c, "qoqPrevCur")}</td>
                <td className="mono">{growthCell(c, "qoqCurNext")}</td>
                <td className="mono">{growthCell(c, "yoyPrevThis")}</td>
                <td className="mono">{growthCell(c, "yoyThisNext")}</td>
                <td className="mono">{growthCell(c, "yoyNextNext2")}</td>
                <td className="mono">{stockPrice(c.price, c.currency)}</td>
                <td className={"mono " + signClass(c.fluctuation_rate)}>{pct(c.fluctuation_rate)}</td>
                <td className="mono">{won(c.market_cap)}</td>
                <td className="mono">{c.per != null ? num(c.per, 1) : "-"}</td>
                <td className="mono">{c.forward_per_y0 != null ? num(c.forward_per_y0, 1) : "-"}</td>
                <td className="mono">{c.forward_per_y1 != null ? num(c.forward_per_y1, 1) : "-"}</td>
                <td className="mono">{c.forward_per_y2 != null ? num(c.forward_per_y2, 1) : "-"}</td>
                <td className="mono">{c.pbr != null ? num(c.pbr, 2) : "-"}</td>
                <td className="mono">{c.target_price_avg ? stockPrice(c.target_price_avg, c.currency) : "-"}</td>
                <td className={"mono " + signClass(c.target_return_rate)}>
                  {c.target_return_rate != null ? pct(c.target_return_rate) : "-"}
                </td>
                <td className="mono">
                  {c.cover_securities ? <span className="pill">{c.cover_securities}</span> : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GrowthPct({ p, title }: { p: number | null; title?: string }) {
  if (p == null) return <span className="muted">-</span>;
  const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "–";
  return (
    <span className={"gnum " + signClass(p)} title={title}>
      {arrow} {pct(p)}
    </span>
  );
}
