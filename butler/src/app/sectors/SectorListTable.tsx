"use client";

import Link from "next/link";
import { won, num, pct, signClass } from "@/lib/format";
import { useTableSort, SortTh } from "@/components/sortable";
import type { SectorAgg } from "@/lib/repo";

const getVal = (s: SectorAgg, k: string) =>
  k === "sector_name" ? s.sector_name : ((s as unknown as Record<string, number | null>)[k] ?? null);

export default function SectorListTable({ sectors }: { sectors: SectorAgg[] }) {
  const { sorted, sortKey, dir, onSort } = useTableSort(sectors, getVal, "market_cap_sum");
  const maxAbsRet = Math.max(1, ...sectors.map((s) => Math.abs(s.return_rate_avg ?? 0)));
  const th = (label: string, k: string, align?: "l", defaultDir?: "asc" | "desc") => (
    <SortTh label={label} k={k} sortKey={sortKey} dir={dir} onSort={onSort} align={align} defaultDir={defaultDir} />
  );

  return (
    <div className="scrollx">
      <table className="grid">
        <thead>
          <tr>
            {th("섹터", "sector_name", "l", "asc")}
            {th("기업수", "company_count")}
            {th("컨센서스", "covered_count")}
            {th("시가총액 합", "market_cap_sum")}
            {th("평균 PER", "per_avg", undefined, "asc")}
            {th("평균 PBR", "pbr_avg", undefined, "asc")}
            {th("평균 상승여력", "return_rate_avg")}
            <th className="l">상승여력 분포</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const ret = s.return_rate_avg ?? 0;
            const w = (Math.abs(ret) / maxAbsRet) * 100;
            return (
              <tr key={s.sector_code}>
                <td className="l">
                  <Link href={`/sectors/${s.sector_code}`}><strong>{s.sector_name}</strong></Link>
                </td>
                <td className="mono">{num(s.company_count)}</td>
                <td className="mono muted">{num(s.covered_count)}</td>
                <td className="mono">{won(s.market_cap_sum)}</td>
                <td className="mono">{s.per_avg ?? "-"}</td>
                <td className="mono">{s.pbr_avg ?? "-"}</td>
                <td className={"mono " + signClass(s.return_rate_avg)}>
                  {s.return_rate_avg != null ? pct(s.return_rate_avg) : "-"}
                </td>
                <td className="l">
                  <div className="divbar">
                    <span className={"divbar-fill " + signClass(s.return_rate_avg)} style={{ width: `${w}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
