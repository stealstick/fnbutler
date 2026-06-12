import Link from "next/link";
import { notFound } from "next/navigation";
import { getSectorAgg, getSectorCompanies, getSectorMomentum } from "@/lib/repo";
import { won, num, pct, signClass } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SectorDetail({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const sector = getSectorAgg(code);
  if (!sector) notFound();
  const companies = getSectorCompanies(code, "target_return_rate");
  const momentum = getSectorMomentum(code);

  return (
    <>
      <div className="panel">
        <div className="chead">
          <div>
            <div className="code">
              <Link href="/sectors" className="muted">섹터</Link> /
            </div>
            <div className="name">{sector.sector_name}</div>
          </div>
        </div>
        <div className="kv">
          <Cell k="기업 수" v={`${num(sector.company_count)}개`} />
          <Cell k="컨센서스 보유" v={`${num(sector.covered_count)}개`} />
          <Cell k="시가총액 합" v={won(sector.market_cap_sum)} />
          <Cell k="평균 상승여력" v={sector.return_rate_avg != null ? pct(sector.return_rate_avg) : "-"} cls={signClass(sector.return_rate_avg)} />
          <Cell k="평균 PER" v={sector.per_avg != null ? num(sector.per_avg, 1) : "-"} />
          <Cell k="평균 PBR" v={sector.pbr_avg != null ? num(sector.pbr_avg, 2) : "-"} />
          <Cell k="목표가 상향(90일)" v={`${momentum.ups ?? 0}건`} cls="up" />
          <Cell k="목표가 하향(90일)" v={`${momentum.downs ?? 0}건`} cls="down" />
        </div>
      </div>

      <div className="panel">
        <h2>
          구성 기업 <span className="sub">상승여력 높은 순 · 컨센서스 보유 기업 우선</span>
        </h2>
        <div className="scrollx">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">종목</th>
                <th>현재가</th>
                <th>시가총액</th>
                <th>PER</th>
                <th>PBR</th>
                <th>평균 목표주가</th>
                <th>상승여력</th>
                <th>커버</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
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
                  <td className="mono">{c.cover_securities ? <span className="pill">{c.cover_securities}</span> : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Cell({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="cell">
      <div className="k">{k}</div>
      <div className={"v mono " + (cls ?? "")}>{v}</div>
    </div>
  );
}
