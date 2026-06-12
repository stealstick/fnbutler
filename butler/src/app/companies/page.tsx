"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { won, num, pct, signClass } from "@/lib/format";
import type { CompanyRow } from "@/lib/repo";

interface ApiResp {
  total: number;
  count: number;
  results: CompanyRow[];
}

export default function CompaniesPage() {
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");
  const [onlyConsensus, setOnlyConsensus] = useState(false);
  const [sort, setSort] = useState("market_cap");
  const [data, setData] = useState<ApiResp | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    const sp = new URLSearchParams({
      q,
      market,
      sort,
      limit: String(limit),
      offset: String(page * limit),
    });
    if (onlyConsensus) sp.set("consensus", "1");
    const r = await fetch(`/api/companies?${sp}`);
    setData(await r.json());
    setLoading(false);
  }, [q, market, sort, onlyConsensus, page]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => setPage(0), [q, market, sort, onlyConsensus]);

  const total = data?.total ?? 0;
  const pages = Math.ceil(total / limit);

  return (
    <div className="panel">
      <h2>
        전체 기업 <span className="sub">전종목에서 검색·필터·정렬 ({num(total)}개)</span>
      </h2>
      <div className="toolbar">
        <input
          className="input search"
          placeholder="기업명 · 종목코드 · 기업코드 (예: 삼성전자, 005930)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">전체 시장</option>
          <option value="KOSPI">KOSPI</option>
          <option value="KOSDAQ">KOSDAQ</option>
        </select>
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="market_cap">시가총액순</option>
          <option value="target_return_rate">상승여력순</option>
          <option value="cover_securities">커버 증권사순</option>
          <option value="name">가나다순</option>
        </select>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={onlyConsensus} onChange={(e) => setOnlyConsensus(e.target.checked)} />
          컨센서스 보유만
        </label>
        <span className="muted" style={{ marginLeft: "auto" }}>{loading ? "불러오는 중…" : `${num(total)}개`}</span>
      </div>

      <div className="scrollx">
        <table className="grid">
          <thead>
            <tr>
              <th className="l">종목</th>
              <th className="l">섹터</th>
              <th>현재가</th>
              <th>등락</th>
              <th>시가총액</th>
              <th>PER</th>
              <th>PBR</th>
              <th>평균 목표주가</th>
              <th>상승여력</th>
              <th>커버</th>
            </tr>
          </thead>
          <tbody>
            {data?.results.map((c) => (
              <tr key={c.corp_code}>
                <td className="l">
                  <Link href={`/companies/${c.corp_code}`}>
                    <strong>{c.name}</strong>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>{c.stock_code}</span>
                  </Link>
                </td>
                <td className="l muted" style={{ fontSize: 12 }}>{c.sector_name || c.market || "-"}</td>
                <td className="mono">{num(c.price)}</td>
                <td className={"mono " + signClass(c.fluctuation_rate)}>{pct(c.fluctuation_rate)}</td>
                <td className="mono">{won(c.market_cap)}</td>
                <td className="mono">{c.per != null ? num(c.per, 1) : "-"}</td>
                <td className="mono">{c.pbr != null ? num(c.pbr, 2) : "-"}</td>
                <td className="mono">{c.target_price_avg ? num(c.target_price_avg) : "-"}</td>
                <td className={"mono " + signClass(c.target_return_rate)}>
                  {c.target_return_rate != null ? pct(c.target_return_rate) : "-"}
                </td>
                <td className="mono">{c.cover_securities ? <span className="pill">{c.cover_securities}</span> : "-"}</td>
              </tr>
            ))}
            {data && data.results.length === 0 && (
              <tr><td colSpan={10} className="empty">검색 결과가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="toolbar" style={{ marginTop: 14, justifyContent: "center" }}>
          <button className="btn ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← 이전</button>
          <span className="muted">{page + 1} / {pages}</span>
          <button className="btn ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>다음 →</button>
        </div>
      )}
    </div>
  );
}
