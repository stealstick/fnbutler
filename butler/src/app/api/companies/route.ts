import { NextRequest, NextResponse } from "next/server";
import { listCompanies, type ListOpts } from "@/lib/repo";
import { epsGrowth } from "@/lib/compare-growth";
import { normalizeEstimateProvider } from "@/lib/estimate-provider";

/** 기업 목록 (검색/필터/정렬/페이지네이션) — 로컬 DB. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const opts: ListOpts = {
    q: sp.get("q") ?? undefined,
    market: sp.get("market") ?? undefined,
    sector: sp.get("sector") ?? undefined,
    industry: sp.get("industry") ?? undefined,
    onlyConsensus: sp.get("consensus") === "1",
    sort: (sp.get("sort") as ListOpts["sort"]) ?? "market_cap",
    dir: sp.get("dir") === "asc" ? "asc" : "desc",
    limit: sp.get("limit") ? Number(sp.get("limit")) : 50,
    offset: sp.get("offset") ? Number(sp.get("offset")) : 0,
    estimateProvider: normalizeEstimateProvider(sp.get("provider")),
  };
  const { total, rows } = await listCompanies(opts);
  const results = rows.map((r) => ({
    ...r,
    epsGrowth: epsGrowth(r),
  }));
  return NextResponse.json({ total, count: rows.length, results });
}
