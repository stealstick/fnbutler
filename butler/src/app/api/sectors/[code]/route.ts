import { NextRequest, NextResponse } from "next/server";
import { getSectorAgg, getSectorCompanies, getSectorMomentum } from "@/lib/repo";
import { normalizeEstimateProvider } from "@/lib/estimate-provider";

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const agg = await getSectorAgg(code);
  if (!agg) return NextResponse.json({ error: "섹터 없음" }, { status: 404 });
  const sort = req.nextUrl.searchParams.get("sort") ?? "market_cap";
  const provider = normalizeEstimateProvider(req.nextUrl.searchParams.get("provider"));
  const [momentum, companies] = await Promise.all([getSectorMomentum(code), getSectorCompanies(code, sort, provider)]);
  return NextResponse.json({
    sector: agg,
    momentum,
    provider,
    companies,
  });
}
