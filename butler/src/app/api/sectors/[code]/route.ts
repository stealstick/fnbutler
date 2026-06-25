import { NextRequest, NextResponse } from "next/server";
import { getSectorAgg, getSectorCompanies, getSectorMomentum } from "@/lib/repo";
import { normalizeDomesticEstimateProvider, normalizeGlobalEstimateProvider } from "@/lib/estimate-provider";

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const agg = await getSectorAgg(code);
  if (!agg) return NextResponse.json({ error: "섹터 없음" }, { status: 404 });
  const sort = req.nextUrl.searchParams.get("sort") ?? "market_cap";
  const domesticProvider = normalizeDomesticEstimateProvider(
    req.nextUrl.searchParams.get("domesticProvider") ?? req.nextUrl.searchParams.get("provider"),
  );
  const globalProvider = normalizeGlobalEstimateProvider(
    req.nextUrl.searchParams.get("globalProvider") ?? req.nextUrl.searchParams.get("provider"),
  );
  const [momentum, companies] = await Promise.all([
    getSectorMomentum(code),
    getSectorCompanies(code, sort, domesticProvider, globalProvider),
  ]);
  return NextResponse.json({
    sector: agg,
    momentum,
    domesticProvider,
    globalProvider,
    companies,
  });
}
