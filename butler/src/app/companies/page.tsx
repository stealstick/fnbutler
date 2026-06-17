"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { won, num, pct, signClass } from "@/lib/format";
import type { CompanyRow, SectorAgg } from "@/lib/repo";

const MAX_COMPARE = 10;

interface ApiResp {
  total: number;
  count: number;
  results: CompanyRow[];
}

type Dir = "asc" | "desc";

export default function CompaniesPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");
  const [sector, setSector] = useState("");
  const [onlyConsensus, setOnlyConsensus] = useState(false);
  const [sort, setSort] = useState("market_cap");
  const [dir, setDir] = useState<Dir>("desc");
  const [data, setData] = useState<ApiResp | null>(null);
  const [sectors, setSectors] = useState<SectorAgg[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  // 비교 선택 — 페이지/필터가 바뀌어도 유지(코드+이름을 들고 다님)
  const [sel, setSel] = useState<{ code: string; name: string }[]>([]);
  const limit = 50;

  const selCodes = new Set(sel.map((s) => s.code));
  const toggleSel = (c: CompanyRow) =>
    setSel((prev) =>
      prev.some((s) => s.code === c.corp_code)
        ? prev.filter((s) => s.code !== c.corp_code)
        : prev.length >= MAX_COMPARE
          ? prev
          : [...prev, { code: c.corp_code, name: c.name }],
    );

  // 섹터 탭 목록(기업수 배지) — 1회 로드
  useEffect(() => {
    fetch("/api/sectors")
      .then((r) => r.json())
      .then((d) => setSectors(d.results ?? []))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const sp = new URLSearchParams({
      q,
      market,
      sort,
      dir,
      limit: String(limit),
      offset: String(page * limit),
    });
    if (sector) sp.set("sector", sector);
    if (onlyConsensus) sp.set("consensus", "1");
    const r = await fetch(`/api/companies?${sp}`);
    setData(await r.json());
    setLoading(false);
  }, [q, market, sector, sort, dir, onlyConsensus, page]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => setPage(0), [q, market, sector, sort, dir, onlyConsensus]);

  function clickSort(key: string, defaultDir: Dir = "desc") {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(defaultDir);
    }
  }
  const Th = ({ label, k, align, dd = "desc" }: { label: string; k: string; align?: "l"; dd?: Dir }) => (
    <th
      className={(align === "l" ? "l " : "") + "sortable" + (sort === k ? " active" : "")}
      onClick={() => clickSort(k, dd)}
      title={`${label} 기준 정렬`}
    >
      {label}
      <span className="sort-ind">{sort === k ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </th>
  );

  const total = data?.total ?? 0;
  const pages = Math.ceil(total / limit);

  return (
    <div className="panel">
      <h2>
        전체 기업 <span className="sub">검색·필터 + 헤더 클릭 정렬 ({num(total)}개)</span>
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
        <select
          className="input"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setDir(e.target.value === "name" ? "asc" : "desc");
          }}
        >
          <option value="market_cap">시가총액순</option>
          <option value="target_return_rate">상승여력순</option>
          <option value="cover_securities">커버 증권사순</option>
          <option value="per">PER순</option>
          <option value="pbr">PBR순</option>
          <option value="name">가나다순</option>
        </select>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={onlyConsensus} onChange={(e) => setOnlyConsensus(e.target.checked)} />
          컨센서스 보유만
        </label>
        <span className="muted" style={{ marginLeft: "auto" }}>{loading ? "불러오는 중…" : `${num(total)}개`}</span>
      </div>

      <div className="tabs" role="tablist" aria-label="섹터 필터">
        <button
          className={"tab" + (sector === "" ? " active" : "")}
          onClick={() => setSector("")}
          role="tab"
          aria-selected={sector === ""}
        >
          전체
        </button>
        {sectors.map((s) => (
          <button
            key={s.sector_code}
            className={"tab" + (sector === s.sector_code ? " active" : "")}
            onClick={() => setSector(s.sector_code)}
            role="tab"
            aria-selected={sector === s.sector_code}
          >
            {s.sector_name}
            <span className="tab-count">{num(s.company_count)}</span>
          </button>
        ))}
      </div>

      <div className="scrollx">
        <table className="grid">
          <thead>
            <tr>
              <th title="비교 선택" style={{ width: 34, textAlign: "center" }}>비교</th>
              <Th label="종목" k="name" align="l" dd="asc" />
              <th className="l">섹터</th>
              <Th label="현재가" k="price" />
              <Th label="등락" k="fluctuation_rate" />
              <Th label="시가총액" k="market_cap" />
              <Th label="PER" k="per" dd="asc" />
              <Th label="PBR" k="pbr" dd="asc" />
              <Th label="평균 목표주가" k="target_price_avg" />
              <Th label="상승여력" k="target_return_rate" />
              <Th label="커버" k="cover_securities" />
            </tr>
          </thead>
          <tbody>
            {data?.results.map((c) => (
              <tr key={c.corp_code} className={selCodes.has(c.corp_code) ? "selected" : undefined}>
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    className="cmp-check"
                    checked={selCodes.has(c.corp_code)}
                    disabled={!selCodes.has(c.corp_code) && sel.length >= MAX_COMPARE}
                    onChange={() => toggleSel(c)}
                    aria-label={`${c.name} 비교 선택`}
                  />
                </td>
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
              <tr><td colSpan={11} className="empty">검색 결과가 없습니다.</td></tr>
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

      {sel.length > 0 && (
        <div className="cmp-actionbar">
          <strong style={{ whiteSpace: "nowrap" }}>
            비교 {sel.length}
            {sel.length >= MAX_COMPARE ? ` (최대 ${MAX_COMPARE})` : ""}
          </strong>
          <div className="chips">
            {sel.map((s) => (
              <span key={s.code} className="cmp-chip">
                {s.name}
                <button
                  onClick={() => setSel((prev) => prev.filter((x) => x.code !== s.code))}
                  aria-label={`${s.name} 제거`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <button className="btn ghost" onClick={() => setSel([])}>전체 해제</button>
          <button
            className="btn"
            disabled={sel.length < 2}
            onClick={() => router.push(`/compare?codes=${sel.map((s) => s.code).join(",")}`)}
            title={sel.length < 2 ? "2개 이상 선택하세요" : "선택한 기업 비교"}
          >
            기업 비교하기 →
          </button>
        </div>
      )}
    </div>
  );
}
