import { NextRequest, NextResponse } from "next/server";
import { parseCompareCodes } from "@/lib/compare-codes";
import { buildGrowthByCompany } from "@/lib/compare-growth";
import { getCompareGrowth } from "@/lib/repo";
import { normalizeDomesticEstimateProvider, normalizeGlobalEstimateProvider } from "@/lib/estimate-provider";

export async function GET(req: NextRequest) {
  const codes = parseCompareCodes(req.nextUrl.searchParams.get("codes"));
  if (codes.length === 0) {
    return NextResponse.json({ count: 0, results: {} });
  }

  const domesticProvider = normalizeDomesticEstimateProvider(
    req.nextUrl.searchParams.get("domesticProvider") ?? req.nextUrl.searchParams.get("provider"),
  );
  const globalProvider = normalizeGlobalEstimateProvider(
    req.nextUrl.searchParams.get("globalProvider") ?? req.nextUrl.searchParams.get("provider"),
  );
  const rows = await getCompareGrowth(codes, domesticProvider, globalProvider);
  return NextResponse.json({
    count: codes.length,
    domesticProvider,
    globalProvider,
    results: buildGrowthByCompany(rows),
  });
}
