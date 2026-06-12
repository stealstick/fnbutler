import { NextRequest, NextResponse } from "next/server";
import { getBrokerTargets, getBrokerHistory, getTargetMonthly } from "@/lib/repo";

/**
 * 증권사별 목표주가.
 *   ?mode=latest  (기본) 증권사별 최신 목표가 비교
 *   ?mode=history          전체 리포트 이력 (목표가 변경 추적)
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ corpCode: string }> }) {
  const { corpCode } = await ctx.params;
  const mode = req.nextUrl.searchParams.get("mode") ?? "latest";
  return NextResponse.json({
    corpCode,
    mode,
    brokers: mode === "history" ? getBrokerHistory(corpCode) : getBrokerTargets(corpCode),
    targetMonthly: getTargetMonthly(corpCode),
  });
}
