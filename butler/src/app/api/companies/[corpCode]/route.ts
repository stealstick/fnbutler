import { NextResponse } from "next/server";
import {
  getCompany,
  getBrokerTargets,
  getFinancials,
  getValuationSeries,
  getTargetMonthly,
} from "@/lib/repo";

/** 기업뷰 단일 번들: 회사정보 + 증권사별 목표주가 + 재무(분기/연간) + 밸류 + 목표주가 추이. */
export async function GET(_req: Request, ctx: { params: Promise<{ corpCode: string }> }) {
  const { corpCode } = await ctx.params;
  const company = await getCompany(corpCode);
  if (!company) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [brokerTargets, quarterly, annual, valuations, targetMonthly] = await Promise.all([
    getBrokerTargets(corpCode),
    getFinancials(corpCode, "Q"),
    getFinancials(corpCode, "A"),
    getValuationSeries(corpCode),
    getTargetMonthly(corpCode),
  ]);

  return NextResponse.json({
    company,
    brokerTargets,
    financials: {
      quarterly,
      annual,
    },
    valuations,
    targetMonthly,
  });
}
