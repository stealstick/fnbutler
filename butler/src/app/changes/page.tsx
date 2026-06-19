import Link from "next/link";
import { getRecentChanges, getStats, type ChangeRow } from "@/lib/repo";
import { pct, num } from "@/lib/format";

export const dynamic = "force-dynamic";

const FILTERS = [
  { k: "", label: "전체" },
  { k: "target_price", label: "목표주가" },
  { k: "consensus_avg", label: "평균목표가" },
  { k: "financial", label: "실적 QoQ/YoY" },
];
const KIND_FILTERS = [
  { k: "", label: "전체 방향" },
  { k: "up", label: "상향" },
  { k: "down", label: "하향" },
  { k: "new", label: "신규" },
];

export default async function ChangesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; kind?: string }>;
}) {
  const { type, kind } = await searchParams;
  const activeType = FILTERS.some((f) => f.k === (type || "")) ? type || "" : "";
  const activeKind = KIND_FILTERS.some((f) => f.k === (kind || "")) ? kind || "" : "";
  const changes = (await getRecentChanges(
    150,
    activeType || undefined,
    activeKind || undefined,
  )) as Array<ChangeRow & { corp_name?: string }>;
  const stats = await getStats();

  return (
    <>
      <div className="panel">
        <h2>
          변경 이력 <span className="sub">Keystone 재수집 시 자동 감지된 변경 (source: keystone)</span>
        </h2>
        <div className="stat-row" style={{ marginBottom: 16 }}>
          <S n={stats.companies} l="수집 기업" />
          <S n={stats.withConsensus} l="컨센서스 보유" />
          <S n={stats.reports} l="리포트" />
          <S n={stats.changes} l="변경 로그" />
          <S n={stats.brokers} l="증권사" />
        </div>
        <div className="toolbar">
          {FILTERS.map((f) => (
            <Link
              key={f.k}
              href={changeHref(f.k, activeKind)}
              className="btn ghost"
              style={activeType === f.k ? { borderColor: "var(--accent)", color: "var(--text)" } : {}}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="toolbar">
          {KIND_FILTERS.map((f) => (
            <Link
              key={f.k}
              href={changeHref(activeType, f.k)}
              className="btn ghost"
              style={activeKind === f.k ? { borderColor: "var(--accent)", color: "var(--text)" } : {}}
            >
              {f.label}
            </Link>
          ))}
        </div>

        <div className="scrollx">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">기업</th>
                <th className="l">구분</th>
                <th className="l">대상</th>
                <th>이전</th>
                <th>이후</th>
                <th>변화</th>
                <th className="l">메모</th>
                <th>시각</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id}>
                  <td className="l">
                    <Link href={`/companies/${c.corp_code}`}>
                      <strong>{c.corp_name ?? c.corp_code}</strong>
                    </Link>
                  </td>
                  <td className="l">
                    <span className="pill">{labelEntity(c.entity_type)}</span>
                  </td>
                  <td className="l">{c.entity_key || c.field || "-"}</td>
                  <td className="mono muted">{displayValue(c, c.old_value)}</td>
                  <td className="mono">{displayValue(c, c.new_value)}</td>
                  <td className={"mono " + kindClass(c.change_kind)}>
                    {c.delta_pct != null ? pct(c.delta_pct) : c.change_kind === "new" ? "신규" : "-"}
                  </td>
                  <td className="l muted" style={{ whiteSpace: "normal", maxWidth: 360 }}>
                    {c.note || "-"}
                  </td>
                  <td className="mono muted">{c.observed_at.slice(0, 10)}</td>
                </tr>
              ))}
              {changes.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    변경 로그가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function changeHref(type: string, kind: string) {
  const p = new URLSearchParams();
  if (type) p.set("type", type);
  if (kind) p.set("kind", kind);
  const q = p.toString();
  return q ? `/changes?${q}` : "/changes";
}

function S({ n, l }: { n: number; l: string }) {
  return (
    <div className="s">
      <div className="n mono">{num(n)}</div>
      <div className="l">{l}</div>
    </div>
  );
}
function labelEntity(t: string) {
  return (
    { target_price: "목표주가", consensus_avg: "평균목표가", financial: "실적", report: "리포트" } as Record<
      string,
      string
    >
  )[t] ?? t;
}
function kindClass(k: string | null) {
  if (k === "up" || k === "yoy") return "up";
  if (k === "down") return "down";
  return "flat";
}
function displayValue(c: ChangeRow, v: string | null) {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (
    Number.isFinite(n) &&
    (c.entity_type === "target_price" || c.entity_type === "consensus_avg" || c.field === "target_price_avg")
  ) {
    return num(n);
  }
  return v;
}
