import { NextRequest, NextResponse } from "next/server";
import { getFinancials } from "@/lib/repo";

/** 재무 (QoQ/YoY 포함). ?period=Q(분기, 기본) | A(연간). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ corpCode: string }> }) {
  const { corpCode } = await ctx.params;
  const period = req.nextUrl.searchParams.get("period") === "A" ? "A" : "Q";
  return NextResponse.json({ corpCode, period, rows: getFinancials(corpCode, period) });
}
