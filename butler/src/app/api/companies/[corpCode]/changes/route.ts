import { NextRequest, NextResponse } from "next/server";
import { getChanges } from "@/lib/repo";

/** 기업별 변경 이력 (목표주가 상향/하향, QoQ/YoY 등). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ corpCode: string }> }) {
  const { corpCode } = await ctx.params;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  return NextResponse.json({ corpCode, changes: await getChanges(corpCode, limit) });
}
