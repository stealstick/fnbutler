import { NextRequest, NextResponse } from "next/server";
import { buildGrowthByCompany } from "@/lib/compare-growth";
import { getCompareGrowth } from "@/lib/repo";
import { normalizeEstimateProvider } from "@/lib/estimate-provider";

const MAX_CODES = 80;

function parseCodes(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const code of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
    if (codes.length >= MAX_CODES) break;
  }
  return codes;
}

export async function GET(req: NextRequest) {
  const codes = parseCodes(req.nextUrl.searchParams.get("codes"));
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
