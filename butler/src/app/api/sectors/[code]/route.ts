import { NextRequest, NextResponse } from "next/server";
import { getSectorAgg, getSectorCompanies, getSectorMomentum } from "@/lib/repo";

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const agg = getSectorAgg(code);
  if (!agg) return NextResponse.json({ error: "섹터 없음" }, { status: 404 });
  const sort = req.nextUrl.searchParams.get("sort") ?? "market_cap";
  return NextResponse.json({
    sector: agg,
    momentum: getSectorMomentum(code),
    companies: getSectorCompanies(code, sort),
  });
}
