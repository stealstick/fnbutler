"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { won, num, pct, price as stockPrice, signClass } from "@/lib/format";
import type { GrowthBundle, GrowthByMetric, GrowthMetric } from "@/lib/compare-growth";
import type { CompanyRow, SectorAgg } from "@/lib/repo";
import EstimateProviderToggle, { useEstimateProvider } from "@/components/EstimateProviderToggle";

const MAX_COMPARE = 10;
const GROWTH_METRICS: Array<{ key: GrowthMetric; label: string }> = [
  { key: "REVENUE", label: "매출액" },
  { key: "OPERATING_PROFIT", label: "영업이익" },
  { key: "NET_INCOME", label: "당기순이익" },
];
const GROWTH_SORT_KEYS = new Set(["epsGrowth", "qoqPrevCur", "qoqCurNext", "yoyPrevThis", "yoyThisNext", "yoyNextNext2"]);
type GrowthSortKey = "epsGrowth" | keyof GrowthBundle;

type CompanyListRow = CompanyRow & {
  epsGrowth: number | null;
};

interface ApiResp {
  total: number;
  count: number;
  results: CompanyListRow[];
}

type Dir = "asc" | "desc";

function isGrowthSortKey(key: string): key is GrowthSortKey {
  return GROWTH_SORT_KEYS.has(key);
}

function compareNullableNumber(a: number | null, b: number | null, dir: Dir) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === "asc" ? a - b : b - a;
}

export default function CompaniesPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");
  const [sector, setSector] = useState("");
  const [industry, setIndustry] = useState("");
  const [onlyConsensus, setOnlyConsensus] = useState(false);
  const [sort, setSort] = useState("market_cap");
  const [dir, setDir] = useState<Dir>("desc");
  const [data, setData] = useState<ApiResp | null>(null);
  const [sectors, setSectors] = useState<SectorAgg[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState<GrowthMetric>("REVENUE");
  const [estimateProvider, setEstimateProvider] = useEstimateProvider();
  const [growthByCode, setGrowthByCode] = useState<Record<string, GrowthByMetric>>({});
  // 비교 선택 — 페이지/필터가 바뀌어도 유지(코드+이름을 들고 다님)
  const [sel, setSel] = useState<{ code: string; name: string }[]>([]);
  const limit = 50;
  const growthSort = isGrowthSortKey(sort);
  const apiSort = growthSort ? "market_cap" : sort;
  const apiDir = growthSort ? "desc" : dir;

  const selCodes = new Set(sel.map((s) => s.code));
  const toggleSel = (c: CompanyListRow) =>
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
      sort: apiSort,
      dir: apiDir,
      limit: String(limit),
      offset: String(page * limit),
      provider: estimateProvider,
    });
    if (sector) sp.set("sector", sector);
    if (industry) sp.set("industry", industry);
    if (onlyConsensus) sp.set("consensus", "1");
    const r = await fetch(`/api/companies?${sp}`);
    setData(await r.json());
    setLoading(false);
  }, [q, market, sector, industry, apiSort, apiDir, onlyConsensus, page, estimateProvider]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => setPage(0), [q, market, sector, industry, sort, dir, onlyConsensus]);

  const pageCodes = data?.results.map((c) => c.corp_code).join(",") ?? "";
  useEffect(() => {
    if (!pageCodes) {
      setGrowthByCode({});
      return;
    }

    const controller = new AbortController();
    setGrowthByCode({});
    const sp = new URLSearchParams({ codes: pageCodes, provider: estimateProvider });
    fetch(`/api/companies/growth?${sp.toString()}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`growth ${r.status}`))))
      .then((d) => setGrowthByCode(d.results ?? {}))
      .catch((e) => {
        if (e.name !== "AbortError") setGrowthByCode({});
      });

    return () => controller.abort();
  }, [pageCodes, estimateProvider]);

  function clickSort(key: string, defaultDir: Dir = "desc") {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(defaultDir);
    }
  }
  const Th = ({
    label,
    k,
    align,
    dd = "desc",
    className = "",
  }: {
    label: string;
    k: string;
    align?: "l";
    dd?: Dir;
    className?: string;
  }) => (
    <th
      className={`${align === "l" ? "l " : ""}sortable${sort === k ? " active" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => clickSort(k, dd)}
      title={`${label} 기준 정렬`}
    >
      {label}
      <span className="sort-ind">{sort === k ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </th>
  );

  const total = data?.total ?? 0;
  const pages = Math.ceil(total / limit);
  const selectedSector = sectors.find((s) => s.sector_code === sector);
  const childSectors = selectedSector?.children ?? [];
  const growthCell = (c: CompanyListRow, key: keyof GrowthBundle) => {
    const t = growthByCode[c.corp_code]?.[metric]?.[key];
    return <GrowthPct p={t?.p ?? null} title={t?.t} />;
  };
  const growthSortValue = useCallback(
    (c: CompanyListRow, key: GrowthSortKey) =>
      key === "epsGrowth" ? c.epsGrowth : (growthByCode[c.corp_code]?.[metric]?.[key]?.p ?? null),
    [growthByCode, metric],
  );
  const results = useMemo(() => {
    const rows = data?.results ?? [];
    if (!isGrowthSortKey(sort)) return rows;
    return [...rows].sort((a, b) => compareNullableNumber(growthSortValue(a, sort), growthSortValue(b, sort), dir));
  }, [data?.results, dir, growthSortValue, sort]);

  return (
    <div className="panel">
      <h2>
        전체 기업 <span className="sub">검색·필터 + 헤더 클릭 정렬 ({num(total)}개)</span>
      </h2>
      <div className="toolbar">
        <input
          className="input search"
          placeholder="기업명 · 종목코드 · 티커 (예: 삼성전자, 005930, AAPL)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">전체 시장</option>
          <option value="KOSPI">KOSPI</option>
          <option value="KOSDAQ">KOSDAQ</option>
          <option value="NASDAQ">NASDAQ</option>
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
          <option value="forward_per_y0">PER 올해E순</option>
          <option value="forward_per_y1">PER 다음년E순</option>
          <option value="forward_per_y2">PER 2년뒤E순</option>
          <option value="pbr">PBR순</option>
          <option value="name">가나다순</option>
          <option value="epsGrowth">EPS성장E순</option>
          <option value="qoqPrevCur">QoQ 직전→현재순</option>
          <option value="qoqCurNext">QoQ 현재→다음E순</option>
          <option value="yoyPrevThis">YoY 전년→올해E순</option>
          <option value="yoyThisNext">YoY 올해→다음년E순</option>
          <option value="yoyNextNext2">YoY 다음년→2년뒤E순</option>
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
          onClick={() => {
            setSector("");
            setIndustry("");
          }}
          role="tab"
          aria-selected={sector === ""}
        >
          전체
        </button>
        {sectors.map((s) => (
          <button
            key={s.sector_code}
            className={"tab" + (sector === s.sector_code ? " active" : "")}
            onClick={() => {
              setSector(s.sector_code);
              setIndustry("");
            }}
            role="tab"
            aria-selected={sector === s.sector_code}
          >
            {s.sector_name}
            <span className="tab-count">{num(s.company_count)}</span>
          </button>
        ))}
      </div>

      {sector && childSectors.length > 0 && (
        <div className="subtabs" aria-label={`${selectedSector?.sector_name ?? "섹터"} 하위 업종 필터`}>
          <button
            className={"subtab" + (industry === "" ? " active" : "")}
            onClick={() => setIndustry("")}
          >
            전체
            <span className="tab-count">{num(selectedSector?.company_count ?? 0)}</span>
          </button>
          {childSectors.map((s) => (
            <button
              key={s.industry}
              className={"subtab" + (industry === s.industry ? " active" : "")}
              onClick={() => setIndustry(s.industry)}
              title={s.industry}
            >
              {s.label}
              <span className="tab-count">{num(s.company_count)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="toolbar growth-toolbar">
        <span className="muted" style={{ fontSize: 12 }}>성장률 기준 지표</span>
        <span className="toggle">
          {GROWTH_METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? "on" : ""} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </span>
        <span className="muted growth-hint">
          종목 옆에서 QoQ·YoY 성장률을 바로 확인
        </span>
        <EstimateProviderToggle provider={estimateProvider} onChange={setEstimateProvider} />
      </div>

      <div className="scrollx">
        <table className="grid companies-table">
          <thead>
            <tr>
              <th className="sticky-col sticky-compare" title="비교 선택">비교</th>
              <Th label="종목" k="name" align="l" dd="asc" className="sticky-col sticky-name" />
              <Th label="EPS성장E" k="epsGrowth" />
              <Th label="QoQ 직전→현재" k="qoqPrevCur" />
              <Th label="QoQ 현재→다음E" k="qoqCurNext" />
              <Th label="YoY 전년→올해E" k="yoyPrevThis" />
              <Th label="YoY 올해→다음년E" k="yoyThisNext" />
              <Th label="YoY 다음년→2년뒤E" k="yoyNextNext2" />
              <th className="l">섹터</th>
              <Th label="현재가" k="price" />
              <Th label="등락" k="fluctuation_rate" />
              <Th label="시가총액" k="market_cap" />
              <Th label="PER" k="per" dd="asc" />
              <Th label="PER 올해E" k="forward_per_y0" dd="asc" />
              <Th label="PER 다음년E" k="forward_per_y1" dd="asc" />
              <Th label="PER 2년뒤E" k="forward_per_y2" dd="asc" />
              <Th label="PBR" k="pbr" dd="asc" />
              <Th label="평균 목표주가" k="target_price_avg" />
              <Th label="상승여력" k="target_return_rate" />
              <Th label="커버" k="cover_securities" />
            </tr>
          </thead>
          <tbody>
            {results.map((c) => (
              <tr key={c.corp_code} className={selCodes.has(c.corp_code) ? "selected" : undefined}>
                <td className="sticky-col sticky-compare">
                  <input
                    type="checkbox"
                    className="cmp-check"
                    checked={selCodes.has(c.corp_code)}
                    disabled={!selCodes.has(c.corp_code) && sel.length >= MAX_COMPARE}
                    onChange={() => toggleSel(c)}
                    aria-label={`${c.name} 비교 선택`}
                  />
                </td>
                <td className="l sticky-col sticky-name">
                  <Link href={`/companies/${c.corp_code}`}>
                    <strong>{c.name}</strong>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>{c.stock_code}</span>
                  </Link>
                </td>
                <td className="mono">
                  <GrowthPct p={c.epsGrowth} />
                </td>
                <td className="mono">{growthCell(c, "qoqPrevCur")}</td>
                <td className="mono">{growthCell(c, "qoqCurNext")}</td>
                <td className="mono">{growthCell(c, "yoyPrevThis")}</td>
                <td className="mono">{growthCell(c, "yoyThisNext")}</td>
                <td className="mono">{growthCell(c, "yoyNextNext2")}</td>
                <td className="l muted" style={{ fontSize: 12 }}>{c.sector_name || c.market || "-"}</td>
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
                <td className="mono">{c.cover_securities ? <span className="pill">{c.cover_securities}</span> : "-"}</td>
              </tr>
            ))}
            {data && results.length === 0 && (
              <tr><td colSpan={20} className="empty">검색 결과가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="note">
        성장률 컬럼은 선택한 지표 기준입니다. QoQ는 분기 대비, YoY는 연간 대비입니다. PER 추정치는 현재가 ÷ 연간 EPS
        컨센서스로 계산하며, 추정 EPS가 없는 연도는 - 로 표시합니다. 추정치 기준은 브라우저에 저장되고, 선택한
        제공자에 값이 없으면 다른 제공자로 자동 보완합니다.
      </p>

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

function GrowthPct({ p, title }: { p: number | null; title?: string }) {
  if (p == null) return <span className="muted">-</span>;
  const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "–";
  return (
    <span className={"gnum " + signClass(p)} title={title}>
      {arrow} {pct(p)}
    </span>
  );
}
