import Link from "next/link";
import { getCompaniesByCodes, getCompareGrowth } from "@/lib/repo";
import { epsGrowth, buildGrowthByCompany } from "@/lib/compare-growth";
import CompareControls from "./CompareControls";
import CompareGrid, { type RowData } from "./CompareGrid";

export const dynamic = "force-dynamic";

const MAX_CODES = 10;

function parseCodes(raw?: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.slice(0, MAX_CODES);
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ codes?: string }>;
}) {
  const codes = parseCodes((await searchParams).codes);
  const companies = await getCompaniesByCodes(codes);
  const growthRows = await getCompareGrowth(companies.map((c) => c.corp_code));
  const growthByCompany = buildGrowthByCompany(growthRows);

  if (companies.length === 0) {
    return (
      <div className="panel">
        <h2>기업 비교</h2>
        <div className="empty">
          비교할 기업이 없습니다.{" "}
          <Link href="/companies" style={{ color: "var(--accent)" }}>
            전체 기업
          </Link>{" "}
          목록에서 체크박스로 기업을 골라 “기업 비교하기”를 눌러주세요.
        </div>
      </div>
    );
  }

  const data: RowData[] = companies.map((c) => {
    return {
      corp_code: c.corp_code,
      name: c.name,
      stock_code: c.stock_code,
      sector_name: c.sector_name,
      market: c.market,
      market_cap: c.market_cap,
      price: c.price,
      currency: c.currency,
      per: c.per,
      fper: c.fper,
      pbr: c.pbr,
      target_return_rate: c.target_return_rate,
      epsGrowth: epsGrowth(c),
      growth: growthByCompany[c.corp_code],
    };
  });

  return (
    <div className="panel">
      <h2>
        기업 비교{" "}
        <span className="sub">{companies.length}개 · 기업=행 / 증감=열 · 헤더 클릭 정렬 · URL 복사 시 동일</span>
        <span style={{ marginLeft: "auto" }}>
          <CompareControls codes={companies.map((c) => c.corp_code)} />
        </span>
      </h2>

      <CompareGrid data={data} />

      <p className="note">
        QoQ(직전→현재 / 현재→다음)·YoY(전년→올해→다음년도→2년뒤) 증감률입니다. 셀에 마우스를 올리면 비교한
        시점·금액이 보입니다. 추정치(현재→다음, 연간 E)는 컨센서스 구독 데이터라 데이터가 적재된 기업·기간에서만
        채워집니다. 평균 목표주가는 주가 컨센서스이므로 분기 실적 추정치 대체값으로 쓰지 않습니다 (source: keystone).
      </p>
    </div>
  );
}
