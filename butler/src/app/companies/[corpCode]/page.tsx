import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import {
  getCompany,
  getBrokerTargets,
  getBrokerTargetHistory,
  getFinancials,
  getValuationSeries,
  getChanges,
  getTargetMonthly,
} from "@/lib/repo";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { userStore } from "@/lib/userstore";
import { won, num, pct, price as stockPrice, signClass } from "@/lib/format";
import FinancialsTable from "./FinancialsTable";
import RefreshButton from "./RefreshButton";
import WatchStar from "@/components/WatchStar";
import TargetPricePanel from "./TargetPricePanel";

export const dynamic = "force-dynamic";

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ corpCode: string }>;
}) {
  const { corpCode } = await params;
  const company = await getCompany(corpCode);
  if (!company) notFound();

  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  const watched = user ? await userStore.isWatched(user.id, corpCode) : false;

  const [brokers, brokerHistory, targetMonthly, quarterly, annual, valuations, changes] = await Promise.all([
    getBrokerTargets(corpCode),
    getBrokerTargetHistory(corpCode),
    getTargetMonthly(corpCode),
    getFinancials(corpCode, "Q"),
    getFinancials(corpCode, "A"),
    getValuationSeries(corpCode),
    getChanges(corpCode, 40),
  ]);

  return (
    <>
      {/* ---------- 헤더 ---------- */}
      <div className="panel">
        <div className="chead">
          <div>
            <div className="name">{company.name}</div>
            <div className="code">
              <span className="pill">{company.market || "-"}</span>{" "}
              <span className="mono">{company.stock_code}</span> ·{" "}
              {company.sector_code ? (
                <Link href={`/sectors/${company.sector_code}`} style={{ color: "var(--accent)" }}>
                  {company.sector_name}
                </Link>
              ) : (
                "—"
              )}
              {company.sector ? ` · ${company.sector}` : ""}
            </div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className={"price mono " + signClass(company.fluctuation_rate)}>
              {stockPrice(company.price, company.currency)}
            </div>
            <div className={"mono " + signClass(company.fluctuation_rate)}>
              {pct(company.fluctuation_rate)}
            </div>
          </div>
        </div>

        <div className="kv">
          <Cell k="시가총액" v={won(company.market_cap)} />
          <Cell k="PER" v={company.per != null ? num(company.per, 2) : "-"} />
          <Cell k="PBR" v={company.pbr != null ? num(company.pbr, 2) : "-"} />
          <Cell k="선행 PER" v={company.fper != null ? num(company.fper, 2) : "-"} />
          <Cell k="EPS" v={num(company.eps)} />
          <Cell k="BPS" v={num(company.bps)} />
          <Cell k="DPS" v={num(company.dps)} />
          <Cell k="배당수익률" v={company.dividend_yield != null ? `${num(company.dividend_yield, 2)}%` : "-"} />
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
          <Link href="/companies" className="btn ghost">← 목록</Link>
          <WatchStar corpCode={corpCode} initialWatched={watched} loggedIn={!!user} />
          {company.source === "nasdaq" ? null : <RefreshButton corpCode={corpCode} />}
          <span className="note" style={{ marginLeft: "auto" }}>
            최종 업데이트 {company.updated_at?.slice(0, 16).replace("T", " ")} · source: keystone
          </span>
        </div>
      </div>

      {/* ---------- 실적 추이 (분기/연간 + QoQ/YoY) ---------- */}
      <FinancialsTable
        corpCode={corpCode}
        quarterly={quarterly}
        annual={annual}
        valuations={valuations}
        isFinancial={!!company.is_financial}
      />

      <TargetPricePanel
        brokers={brokers}
        history={brokerHistory}
        monthly={targetMonthly}
        currentPrice={company.price}
        averageTarget={company.target_price_avg}
        averageReturn={company.target_return_rate}
        coverCount={company.cover_securities}
        hasConsensus={!!company.has_consensus}
        detailIngested={!!company.detail_ingested_at}
      />

      {/* ---------- 변경 이력 ---------- */}
      <div className="panel">
        <h2>
          변경 이력 <span className="sub">목표주가 상향·하향, 신규 커버리지, 분기 실적 QoQ/YoY</span>
        </h2>
        {changes.length === 0 ? (
          <div className="empty">기록된 변경이 없습니다.</div>
        ) : (
          <div className="table-scroll changes-table">
            <table className="grid">
              <thead>
                <tr>
                  <th className="l">구분</th>
                  <th className="l">대상</th>
                  <th>이전</th>
                  <th>이후</th>
                  <th>변화</th>
                  <th className="l">메모</th>
                  <th>발생일</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td className="l">
                      <span className="pill">{labelEntity(c.entity_type)}</span>
                    </td>
                    <td className="l">{c.entity_key || c.field || "-"}</td>
                    <td className="mono muted">{c.old_value ?? "-"}</td>
                    <td className="mono">{c.new_value ?? "-"}</td>
                    <td className={"mono " + kindClass(c.change_kind)}>
                      {c.delta_pct != null
                        ? pct(c.delta_pct)
                        : c.change_kind === "new"
                          ? "신규"
                          : "-"}
                    </td>
                    <td className="l muted" style={{ whiteSpace: "normal", maxWidth: 360 }}>
                      {c.note || "-"}
                    </td>
                    <td className="mono muted">{(c.occurred_at ?? c.observed_at).slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className="cell">
      <div className="k">{k}</div>
      <div className="v mono">{v}</div>
    </div>
  );
}

function labelEntity(t: string) {
  return (
    {
      target_price: "목표주가",
      consensus_avg: "평균목표가",
      financial: "실적",
      valuation: "밸류",
      price: "주가",
      report: "리포트",
    } as Record<string, string>
  )[t] ?? t;
}

function kindClass(k: string | null) {
  if (k === "up" || k === "yoy") return "up";
  if (k === "down") return "down";
  return "flat";
}
