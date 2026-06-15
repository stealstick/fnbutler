"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { won, num, pct, signClass } from "@/lib/format";
import type { CompanyRow } from "@/lib/repo";

type Key =
  | "name"
  | "price"
  | "market_cap"
  | "per"
  | "pbr"
  | "target_price_avg"
  | "target_return_rate"
  | "cover_securities";

const COLS: Array<{ key: Key; label: string; align?: "l"; defaultDir: "asc" | "desc" }> = [
  { key: "name", label: "종목", align: "l", defaultDir: "asc" },
  { key: "price", label: "현재가", defaultDir: "desc" },
  { key: "market_cap", label: "시가총액", defaultDir: "desc" },
  { key: "per", label: "PER", defaultDir: "asc" },
  { key: "pbr", label: "PBR", defaultDir: "asc" },
  { key: "target_price_avg", label: "평균 목표주가", defaultDir: "desc" },
  { key: "target_return_rate", label: "상승여력", defaultDir: "desc" },
  { key: "cover_securities", label: "커버", defaultDir: "desc" },
];

export default function SectorCompaniesTable({ companies }: { companies: CompanyRow[] }) {
  const [sortKey, setSortKey] = useState<Key>("target_return_rate");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  function clickHeader(col: (typeof COLS)[number]) {
    if (col.key === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(col.key);
      setDir(col.defaultDir);
    }
  }

  const sorted = useMemo(() => {
    const rows = [...companies];
    rows.sort((a, b) => {
      if (sortKey === "name") {
        const r = a.name.localeCompare(b.name, "ko");
        return dir === "asc" ? r : -r;
      }
      const va = a[sortKey] as number | null;
      const vb = b[sortKey] as number | null;
      // null 은 항상 맨 아래
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir === "asc" ? va - vb : vb - va;
    });
    return rows;
  }, [companies, sortKey, dir]);

  return (
    <div className="scrollx">
      <table className="grid">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c.key}
                className={(c.align === "l" ? "l " : "") + "sortable" + (sortKey === c.key ? " active" : "")}
                onClick={() => clickHeader(c)}
                title={`${c.label} 기준 정렬`}
              >
                {c.label}
                <span className="sort-ind">{sortKey === c.key ? (dir === "asc" ? "▲" : "▼") : ""}</span>
              </th>
            ))}
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
