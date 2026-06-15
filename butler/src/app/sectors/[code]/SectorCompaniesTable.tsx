"use client";

import Link from "next/link";
import { won, num, pct, signClass } from "@/lib/format";
import { useTableSort, SortTh } from "@/components/sortable";
import type { CompanyRow } from "@/lib/repo";

const getVal = (c: CompanyRow, k: string) =>
  k === "name" ? c.name : ((c as unknown as Record<string, number | null>)[k] ?? null);

export default function SectorCompaniesTable({ companies }: { companies: CompanyRow[] }) {
  const { sorted, sortKey, dir, onSort } = useTableSort(companies, getVal, "target_return_rate");
  const th = (label: string, k: string, align?: "l", defaultDir?: "asc" | "desc") => (
    <SortTh label={label} k={k} sortKey={sortKey} dir={dir} onSort={onSort} align={align} defaultDir={defaultDir} />
  );

  return (
    <div className="scrollx">
      <table className="grid">
        <thead>
          <tr>
            {th("종목", "name", "l", "asc")}
            {th("현재가", "price")}
            {th("시가총액", "market_cap")}
            {th("PER", "per", undefined, "asc")}
            {th("PBR", "pbr", undefined, "asc")}
            {th("평균 목표주가", "target_price_avg")}
            {th("상승여력", "target_return_rate")}
            {th("커버", "cover_securities")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.corp_code}>
              <td className="l">
                <Link href={`/companies/${c.corp_code}`}>
                  <strong>{c.name}</strong>{" "}
                  <span className="muted mono" style={{ fontSize: 12 }}>{c.stock_code}</span>
                </Link>
              </td>
              <td className="mono">{num(c.price)}</td>
              <td className="mono">{won(c.market_cap)}</td>
              <td className="mono">{c.per != null ? num(c.per, 1) : "-"}</td>
              <td className="mono">{c.pbr != null ? num(c.pbr, 2) : "-"}</td>
              <td className="mono">{c.target_price_avg ? num(c.target_price_avg) : "-"}</td>
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
  );
}
