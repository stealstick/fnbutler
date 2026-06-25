import { NextRequest, NextResponse } from "next/server";
import { parseCompareCodes } from "@/lib/compare-codes";
import { buildGrowthByCompany } from "@/lib/compare-growth";
import { getCompareGrowth } from "@/lib/repo";
import { normalizeEstimateProvider } from "@/lib/estimate-provider";

export async function GET(req: NextRequest) {
  const codes = parseCompareCodes(req.nextUrl.searchParams.get("codes"));
  if (codes.length === 0) {
    return NextResponse.json({ count: 0, results: {} });
  }

  const provider = normalizeEstimateProvider(req.nextUrl.searchParams.get("provider"));
  const rows = await getCompareGrowth(codes, provider);
  return NextResponse.json({
    count: codes.length,
    provider,
    results: buildGrowthByCompany(rows),
  });
}
