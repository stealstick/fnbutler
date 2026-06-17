"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { won, num, pct, signClass } from "@/lib/format";

/** 한 전환점(QoQ/YoY): p = 증감률 %, t = 툴팁(무엇→무엇). */
export type Trans = { p: number | null; t: string };
export type Bundle = {
  qoqPrevCur: Trans; // 직전 → 현재 (QoQ)
  qoqCurNext: Trans; // 현재 → 다음 (QoQ, 추정)
  yoyPrevThis: Trans; // 전년 → 올해 (YoY)
  yoyThisNext: Trans; // 올해 → 다음년도 (YoY, 추정)
  yoyNextNext2: Trans; // 다음년도 → 2년뒤 (YoY, 추정)
};
export type RowData = {
  corp_code: string;
  name: string;
  stock_code: string;
  sector_name: string | null;
  market: string | null;
  market_cap: number | null;
  price: number | null;
  per: number | null;
  fper: number | null;
  pbr: number | null;
  target_return_rate: number | null;
  epsGrowth: number | null;
  growth: Record<string, Bundle>;
};

type Dir = "asc" | "desc";
type Metric = "REVENUE" | "OPERATING_PROFIT" | "NET_INCOME";
const METRICS: Array<{ key: Metric; label: string }> = [
  { key: "REVENUE", label: "매출액" },
  { key: "OPERATING_PROFIT", label: "영업이익" },
  { key: "NET_INCOME", label: "당기순이익" },
];

const GROWTH_KEYS = [
  "qoqPrevCur",
  "qoqCurNext",
  "yoyPrevThis",
  "yoyThisNext",
  "yoyNextNext2",
] as const;
type GrowthKey = (typeof GROWTH_KEYS)[number];

type Col = {
  key: string;
  label: string;
  tip?: string;
  align?: "l";
  defDir: Dir;
  // 정렬값 (string=이름, number|null=수치)
  val: (r: RowData, m: Metric) => number | string | null;
  cell: (r: RowData, m: Metric, onRemove: (code: string) => void, rest: (code: string) => string) => ReactNode;
};

function gnum(p: number | null, title?: string): ReactNode {
  if (p == null) return <span className="muted">-</span>;
  const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "–";
  return (
    <span className={"gnum " + signClass(p)} title={title}>
      {arrow} {pct(p)}
    </span>
  );
}

const FIXED: Col[] = [
  {
    key: "name",
    label: "종목",
    align: "l",
    defDir: "asc",
    val: (r) => r.name,
    cell: (r, _m, onRemove) => (
      <span className="cg-namecell">
        <Link href={`/companies/${r.corp_code}`} className="cg-name">
          {r.name}
        </Link>
        <span className="muted mono cg-code">{r.stock_code}</span>
        <button className="cg-x" title="비교에서 제거" onClick={() => onRemove(r.corp_code)}>
          ✕
        </button>
      </span>
    ),
  },
  { key: "market_cap", label: "시총", defDir: "desc", val: (r) => r.market_cap, cell: (r) => won(r.market_cap) },
  { key: "price", label: "현재가", defDir: "desc", val: (r) => r.price, cell: (r) => num(r.price) },
  { key: "per", label: "PER", defDir: "asc", val: (r) => r.per, cell: (r) => (r.per != null ? num(r.per, 1) : <span className="muted">-</span>) },
  {
    key: "fper",
    label: "선행PER",
    tip: "향후 12개월 추정 EPS 기준 PER",
    defDir: "asc",
    val: (r) => r.fper,
    cell: (r) => (r.fper != null ? num(r.fper, 1) : <span className="muted">-</span>),
  },
  {
    key: "target_return_rate",
    label: "상승여력",
    defDir: "desc",
    val: (r) => r.target_return_rate,
    cell: (r) =>
      r.target_return_rate != null ? (
        <span className={signClass(r.target_return_rate)}>{pct(r.target_return_rate)}</span>
      ) : (
        <span className="muted">-</span>
      ),
  },
  {
    key: "epsGrowth",
    label: "EPS성장E",
    tip: "(선행 EPS − EPS) / |EPS|. 향후 1년 이익 성장 추정",
    defDir: "desc",
    val: (r) => r.epsGrowth,
    cell: (r) => gnum(r.epsGrowth),
  },
];

const GROWTH_COLS: Array<{ key: GrowthKey; label: string; tip: string }> = [
  { key: "qoqPrevCur", label: "직전→현재", tip: "직전분기 대비 현재분기 (QoQ, 실적)" },
  { key: "qoqCurNext", label: "현재→다음E", tip: "현재분기 대비 다음분기 추정 (QoQ)" },
  { key: "yoyPrevThis", label: "전년→올해E", tip: "전년 대비 올해 (YoY)" },
  { key: "yoyThisNext", label: "올해→다음년E", tip: "올해 대비 다음년도 추정 (YoY)" },
  { key: "yoyNextNext2", label: "다음년→2년뒤E", tip: "다음년도 대비 2년뒤 추정 (YoY)" },
];

export default function CompareGrid({ data }: { data: RowData[] }) {
  const router = useRouter();
  const [metric, setMetric] = useState<Metric>("REVENUE");
  const [sortKey, setSortKey] = useState("market_cap");
  const [dir, setDir] = useState<Dir>("desc");

  const codes = data.map((r) => r.corp_code);
  const rest = (code: string) => codes.filter((x) => x !== code).join(",");
  const onRemove = (code: string) => {
    const r = rest(code);
    router.push(r ? `/compare?codes=${r}` : "/compare");
  };

  const cols: Col[] = [
    ...FIXED,
    ...GROWTH_COLS.map<Col>((g) => ({
      key: g.key,
      label: g.label,
      tip: g.tip,
      defDir: "desc",
      val: (r, m) => r.growth[m]?.[g.key]?.p ?? null,
      cell: (r, m) => {
        const t = r.growth[m]?.[g.key];
        return gnum(t?.p ?? null, t?.t);
      },
    })),
  ];

  function clickSort(key: string, defDir: Dir) {
    if (sortKey === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDir(defDir);
    }
  }

  const col = cols.find((c) => c.key === sortKey) ?? cols[0];
  const sorted = [...data].sort((a, b) => {
    const va = col.val(a, metric);
    const vb = col.val(b, metric);
    if (typeof va === "string" || typeof vb === "string") {
      const r = String(va ?? "").localeCompare(String(vb ?? ""));
      return dir === "asc" ? r : -r;
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // nulls last
    if (vb == null) return -1;
    return dir === "asc" ? va - vb : vb - va;
  });

  return (
    <>
      <div className="toolbar" style={{ marginTop: 4, marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>성장률 기준 지표</span>
        <span className="toggle">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? "on" : ""} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </span>
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          헤더 클릭 = 해당 열 정렬 · 셀 = 증감률(%)
        </span>
      </div>

      <div className="scrollx">
        <table className="grid cg-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c.key}
                  className={(c.align === "l" ? "l " : "") + "sortable" + (sortKey === c.key ? " active" : "") + (c.key === "name" ? " cg-corner" : "")}
                  onClick={() => clickSort(c.key, c.defDir)}
                  title={c.tip ? `${c.label} — ${c.tip} (클릭 정렬)` : `${c.label} 기준 정렬`}
                >
                  {c.label}
                  <span className="sort-ind">{sortKey === c.key ? (dir === "asc" ? "▲" : "▼") : ""}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.corp_code}>
                {cols.map((c) => (
                  <td key={c.key} className={(c.align === "l" ? "l " : "mono ") + (c.key === "name" ? "cg-namecol" : "")}>
                    {c.cell(r, metric, onRemove, rest)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
