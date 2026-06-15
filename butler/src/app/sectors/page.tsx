import { listSectorAggs } from "@/lib/repo";
import SectorListTable from "./SectorListTable";

export const dynamic = "force-dynamic";

export default function SectorsPage() {
  const sectors = listSectorAggs();

  return (
    <div className="panel">
      <h2>
        섹터 <span className="sub">헤더 클릭으로 정렬 · 광역 섹터별 평균 목표주가 상승여력·밸류에이션 비교</span>
      </h2>
      <SectorListTable sectors={sectors} />
      <p className="note">
        평균 상승여력 = 섹터 내 컨센서스 보유 기업들의 (평균목표가/현재가−1) 평균. KSIC 산업코드를
        광역 섹터로 매핑(src/lib/sectors.ts). source: butler
      </p>
    </div>
  );
}
