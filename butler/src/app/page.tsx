import Link from "next/link";
import { listSectorAggs, getRecentChanges, getStats } from "@/lib/repo";
import { butler } from "@/lib/butler";
import { won, num, pct, signClass } from "@/lib/format";
import InfoTip from "@/components/InfoTip";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function getMarkets() {
  try {
    return await butler.markets();
  } catch {
    return null;
  }
}

export default async function Dashboard() {
  const [markets, sectors, stats] = await Promise.all([
    getMarkets(),
    Promise.resolve(listSectorAggs()),
    Promise.resolve(getStats()),
  ]);
  const targetChanges = getRecentChanges(200, "target_price");
  // 기업당 가장 최근 변경 1건만 (한 기업이 리스트를 독식하지 않게)
  const dedupe = (kind: "up" | "down") => {
    const seen = new Set<string>();
    const out: typeof targetChanges = [];
    for (const c of targetChanges) {
      if (c.change_kind !== kind || seen.has(c.corp_code)) continue;
      seen.add(c.corp_code);
      out.push(c);
      if (out.length >= 8) break;
    }
    return out;
  };
  const ups = dedupe("up");
  const downs = dedupe("down");

  const covered = sectors
    .filter((s) => s.return_rate_avg != null && s.covered_count >= 2)
    .sort((a, b) => (b.return_rate_avg ?? 0) - (a.return_rate_avg ?? 0));

  return (
    <>
      {/* 마켓 바 */}
      <div className="panel">
        <h2>
          데스크 개요 <span className="sub">애널리스트 데스크 · 목표주가 컨센서스 (source: butler)</span>
        </h2>
        <div className="marketbar">
          {markets &&
            ["kospi", "kosdaq"].map((k) =>
              markets[k] ? (
                <div className="mkt" key={k}>
                  <span className="mlbl">{k.toUpperCase()}</span>
                  <span className="mval mono">{num(markets[k].price, 2)}</span>
                  <span className={"mono " + signClass(Number(markets[k].fluctuationRate))}>
                    {pct(Number(markets[k].fluctuationRate), 2)}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    PER {markets[k].per} · PBR {markets[k].pbr}
                  </span>
                </div>
              ) : null,
            )}
          <div className="stat-row" style={{ marginLeft: "auto" }}>
            <Stat n={stats.companies} l="기업" />
            <Stat n={stats.withConsensus} l="컨센서스" />
            <Stat n={stats.reports} l="리포트" />
            <Stat n={stats.changes} l="변경로그" />
          </div>
        </div>
      </div>

      {/* 섹터 상승여력 리본 */}
      <div className="panel">
        <h2>
          섹터별 평균 상승여력
          <InfoTip text="상승여력 = 증권사 컨센서스 평균 목표주가 ÷ 현재가 − 1. 섹터 내 컨센서스 보유 기업 평균. 애널리스트 목표주가까지의 기대 상승률(괴리율)." />{" "}
          <span className="sub">컨센서스 평균 목표가 / 현재가 (커버 2개사 이상)</span>
          <Link href="/sectors" className="btn ghost" style={{ marginLeft: "auto", fontSize: 12 }}>
            섹터 전체 →
          </Link>
        </h2>
        <div className="sector-grid">
          {covered.slice(0, 12).map((s) => (
            <Link key={s.sector_code} href={`/sectors/${s.sector_code}`} className="sector-card">
              <div className="sname">{s.sector_name}</div>
              <div className={"sret mono " + signClass(s.return_rate_avg)}>
                {pct(s.return_rate_avg)}
              </div>
              <div className="smeta muted">
                {s.covered_count}/{s.company_count}개 · PER {s.per_avg ?? "-"}
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* 최근 목표주가 상향/하향 */}
      <div className="two-col">
        <div className="panel">
          <h2>🔺 최근 목표주가 상향</h2>
          <MoverList rows={ups} kind="up" />
        </div>
        <div className="panel">
          <h2>🔻 최근 목표주가 하향</h2>
          <MoverList rows={downs} kind="down" />
        </div>
      </div>

      <p className="footer">
        butler.view · 전체 <Link href="/companies">기업</Link> · <Link href="/sectors">섹터</Link> ·{" "}
        <Link href="/changes">변경이력</Link>
      </p>
    </>
  );
}

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <div className="s">
      <div className="n mono">{n.toLocaleString()}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function MoverList({
  rows,
  kind,
}: {
  rows: Array<Awaited<ReturnType<typeof getRecentChanges>>[number] & { corp_name?: string }>;
  kind: "up" | "down";
}) {
  if (rows.length === 0) return <div className="empty">최근 {kind === "up" ? "상향" : "하향"} 없음</div>;
  return (
    <table className="grid">
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <td className="l">
              <Link href={`/companies/${c.corp_code}`}>
                <strong>{c.corp_name ?? c.corp_code}</strong>
              </Link>
              <span className="muted" style={{ fontSize: 11 }}> · {c.entity_key}</span>
            </td>
            <td className="mono muted" style={{ fontSize: 12 }}>
              {c.old_value ? num(Number(c.old_value)) : "-"} →{" "}
              <span className={kind}>{c.new_value ? num(Number(c.new_value)) : "-"}</span>
            </td>
            <td className={"mono " + kind}>{c.delta_pct != null ? pct(c.delta_pct) : ""}</td>
            <td className="mono muted" style={{ fontSize: 11 }}>{(c.occurred_at ?? c.observed_at).slice(5, 10)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
