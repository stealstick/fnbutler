import { NextRequest, NextResponse } from "next/server";
import { getFinancials } from "@/lib/repo";
import { normalizeEstimateProvider } from "@/lib/estimate-provider";

/** 재무 (QoQ/YoY 포함). ?period=Q(분기, 기본) | A(연간). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ corpCode: string }> }) {
  const { corpCode } = await ctx.params;
  const period = req.nextUrl.searchParams.get("period") === "A" ? "A" : "Q";
  const provider = normalizeEstimateProvider(req.nextUrl.searchParams.get("provider"));
  return NextResponse.json({ corpCode, period, provider, rows: await getFinancials(corpCode, period, provider) });
}
