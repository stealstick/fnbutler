import Link from "next/link";
import { notFound } from "next/navigation";
import { getSectorAgg, getSectorCompanies, getSectorMomentum } from "@/lib/repo";
import { won, num, pct, signClass } from "@/lib/format";
import InfoTip from "@/components/InfoTip";
import SectorCompaniesTable from "./SectorCompaniesTable";

const UPSIDE_TIP =
  "상승여력 = 증권사 컨센서스 평균 목표주가 ÷ 현재가 − 1. 애널리스트 목표주가까지의 기대 상승률(괴리율).";

export const dynamic = "force-dynamic";

export default async function SectorDetail({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const sector = await getSectorAgg(code);
  if (!sector) notFound();
  const [companies, momentum] = await Promise.all([
    getSectorCompanies(code, "target_return_rate"),
    getSectorMomentum(code),
  ]);

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
          <Cell k="평균 상승여력" tip={UPSIDE_TIP} v={sector.return_rate_avg != null ? pct(sector.return_rate_avg) : "-"} cls={signClass(sector.return_rate_avg)} />
          <Cell k="평균 PER" v={sector.per_avg != null ? num(sector.per_avg, 1) : "-"} />
          <Cell k="평균 PBR" v={sector.pbr_avg != null ? num(sector.pbr_avg, 2) : "-"} />
          <Cell k="목표가 상향(90일)" v={`${momentum.ups ?? 0}건`} cls="up" />
          <Cell k="목표가 하향(90일)" v={`${momentum.downs ?? 0}건`} cls="down" />
        </div>
      </div>

      <div className="panel">
        <h2>
          구성 기업 <span className="sub">헤더(시가총액·PER·상승여력 등)를 클릭하면 그 기준으로 정렬</span>
        </h2>
        <SectorCompaniesTable companies={companies} />
      </div>
    </>
  );
}

function Cell({ k, v, cls, tip }: { k: string; v: string; cls?: string; tip?: string }) {
  return (
    <div className="cell">
      <div className="k">
        {k}
        {tip ? <InfoTip text={tip} /> : null}
      </div>
      <div className={"v mono " + (cls ?? "")}>{v}</div>
    </div>
  );
}
