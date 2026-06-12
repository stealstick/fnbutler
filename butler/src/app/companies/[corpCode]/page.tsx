import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import {
  getCompany,
  getBrokerTargets,
  getFinancials,
  getValuationSeries,
  getChanges,
  isWatched,
} from "@/lib/repo";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { won, num, pct, signClass, ratingChangeBadge } from "@/lib/format";
import FinancialsTable from "./FinancialsTable";
import RefreshButton from "./RefreshButton";
import WatchStar from "@/components/WatchStar";

export const dynamic = "force-dynamic";

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ corpCode: string }>;
}) {
  const { corpCode } = await params;
  const company = getCompany(corpCode);
  if (!company) notFound();

  const user = getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  const watched = user ? isWatched(user.id, corpCode) : false;

  const brokers = getBrokerTargets(corpCode);
  const quarterly = getFinancials(corpCode, "Q");
  const annual = getFinancials(corpCode, "A");
  const valuations = getValuationSeries(corpCode);
  const changes = getChanges(corpCode, 40);

  const maxTarget = Math.max(1, ...brokers.map((b) => b.target_price ?? 0));

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
              {num(company.price)}
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
          <RefreshButton corpCode={corpCode} />
          <span className="note" style={{ marginLeft: "auto" }}>
            최종 업데이트 {company.updated_at?.slice(0, 16).replace("T", " ")} · source: butler
          </span>
        </div>
      </div>

      {/* ---------- 목표주가 / 증권사별 비교 ---------- */}
      <div className="panel">
        <h2>
          증권사별 목표주가
          <span className="sub">각 증권사가 제시한 목표주가를 한눈에 비교 (최신 리포트 기준)</span>
        </h2>

        {company.target_price_avg ? (
          <div className="tp-hero" style={{ marginBottom: 16 }}>
            <div>
              <div className="lbl">평균 목표주가</div>
              <div className="big mono">{num(company.target_price_avg)}</div>
            </div>
            <div>
              <div className="lbl">현재가</div>
              <div className="big mono">{num(company.price)}</div>
            </div>
            <div>
              <div className="lbl">평균 상승여력</div>
              <div className={"big mono " + signClass(company.target_return_rate)}>
                {pct(company.target_return_rate)}
              </div>
            </div>
            <div>
              <div className="lbl">커버 증권사</div>
              <div className="big mono">{company.cover_securities ?? brokers.length}곳</div>
            </div>
          </div>
        ) : null}

        {brokers.length === 0 ? (
          <div className="empty">
            아직 수집된 컨센서스 리포트가 없습니다. “최신 새로고침”을 눌러 butler 에서 가져오세요.
          </div>
        ) : (
          <div className="scrollx">
            <table className="grid">
              <thead>
                <tr>
                  <th className="l">증권사</th>
                  <th className="l">애널리스트</th>
                  <th>리포트일</th>
                  <th className="l">투자의견</th>
                  <th>목표주가</th>
                  <th className="l">목표가 (상대)</th>
                  <th>변경</th>
                  <th>상승여력</th>
                </tr>
              </thead>
              <tbody>
                {brokers.map((b) => {
                  const badge = ratingChangeBadge(b.target_price_change);
                  const isBuy = (b.rating ?? "").match(/BUY|매수|Buy/);
                  return (
                    <tr key={b.report_id}>
                      <td className="l">
                        {b.research_url ? (
                          <a href={b.research_url} target="_blank" rel="noreferrer">
                            <strong>{b.broker}</strong>
                          </a>
                        ) : (
                          <strong>{b.broker}</strong>
                        )}
                        {b.ai_summary && (
                          <details className="ai">
                            <summary>AI 요약</summary>
                            <div className="body">{b.ai_summary}</div>
                          </details>
                        )}
                      </td>
                      <td className="l muted">{b.analyst || "-"}</td>
                      <td className="mono muted">{b.report_date}</td>
                      <td className="l">
                        <span className={"pill " + (isBuy ? "buy" : "")}>{b.rating || "-"}</span>
                      </td>
                      <td className="mono">
                        <strong>{num(b.target_price)}</strong>
                      </td>
                      <td className="l">
                        <div className="bar">
                          <span style={{ width: `${((b.target_price ?? 0) / maxTarget) * 100}%` }} />
                        </div>
                      </td>
                      <td>
                        <span className={"pill " + badge.kind}>{badge.label}</span>
                      </td>
                      <td className={"mono " + signClass(b.return_rate)}>{pct(b.return_rate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          목표주가·투자의견은 증권사 리포트 발간 시점 기준이며 butler 가 수집·정규화합니다. AI 요약은
          butler 생성 요약입니다.
        </p>
      </div>

      {/* ---------- 실적 추이 (분기/연간 + QoQ/YoY) ---------- */}
      <FinancialsTable
        quarterly={quarterly}
        annual={annual}
        valuations={valuations}
        isFinancial={!!company.is_financial}
      />

      {/* ---------- 변경 이력 ---------- */}
      <div className="panel">
        <h2>
          변경 이력 <span className="sub">목표주가 상향·하향, 신규 커버리지, 분기 실적 QoQ/YoY</span>
        </h2>
        {changes.length === 0 ? (
          <div className="empty">기록된 변경이 없습니다.</div>
        ) : (
          <div className="scrollx">
            <table className="grid">
              <thead>
                <tr>
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
                    <td className="mono muted">{c.observed_at.slice(0, 10)}</td>
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
