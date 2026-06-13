import Link from "next/link";
import { listSectorAggs } from "@/lib/repo";
import { won, num, pct, signClass } from "@/lib/format";
import InfoTip from "@/components/InfoTip";

const UPSIDE_TIP =
  "상승여력 = 섹터 내 컨센서스 보유 기업들의 (평균 목표주가 ÷ 현재가 − 1) 평균. 애널리스트 목표주가까지의 기대 상승률(괴리율).";

export const dynamic = "force-dynamic";

export default function SectorsPage() {
  const sectors = listSectorAggs();
  const maxAbsRet = Math.max(1, ...sectors.map((s) => Math.abs(s.return_rate_avg ?? 0)));

  return (
    <div className="panel">
      <h2>
        섹터 <span className="sub">광역 섹터별 평균 목표주가 상승여력·밸류에이션 비교</span>
      </h2>
      <div className="scrollx">
        <table className="grid">
          <thead>
            <tr>
              <th className="l">섹터</th>
              <th>기업수</th>
              <th>컨센서스</th>
              <th>시가총액 합</th>
              <th>평균 PER</th>
              <th>평균 PBR</th>
              <th>평균 상승여력<InfoTip text={UPSIDE_TIP} /></th>
              <th className="l">상승여력 분포</th>
            </tr>
          </thead>
          <tbody>
            {sectors.map((s) => {
              const ret = s.return_rate_avg ?? 0;
              const w = (Math.abs(ret) / maxAbsRet) * 100;
              return (
                <tr key={s.sector_code}>
                  <td className="l">
                    <Link href={`/sectors/${s.sector_code}`}>
                      <strong>{s.sector_name}</strong>
                    </Link>
                  </td>
                  <td className="mono">{num(s.company_count)}</td>
                  <td className="mono muted">{num(s.covered_count)}</td>
                  <td className="mono">{won(s.market_cap_sum)}</td>
                  <td className="mono">{s.per_avg ?? "-"}</td>
                  <td className="mono">{s.pbr_avg ?? "-"}</td>
                  <td className={"mono " + signClass(s.return_rate_avg)}>
                    {s.return_rate_avg != null ? pct(s.return_rate_avg) : "-"}
                  </td>
                  <td className="l">
                    <div className="divbar">
                      <span
                        className={"divbar-fill " + signClass(s.return_rate_avg)}
                        style={{ width: `${w}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">
        평균 상승여력 = 섹터 내 컨센서스 보유 기업들의 (평균목표가/현재가−1) 평균. KSIC 산업코드를
        광역 섹터로 매핑(src/lib/sectors.ts). source: butler
      </p>
    </div>
  );
}
