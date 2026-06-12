import { NextRequest, NextResponse } from "next/server";
import { listCompanies, type ListOpts } from "@/lib/repo";

/** 기업 목록 (검색/필터/정렬/페이지네이션) — 로컬 DB. */
export function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const opts: ListOpts = {
    q: sp.get("q") ?? undefined,
    market: sp.get("market") ?? undefined,
    onlyConsensus: sp.get("consensus") === "1",
    sort: (sp.get("sort") as ListOpts["sort"]) ?? "market_cap",
    limit: sp.get("limit") ? Number(sp.get("limit")) : 50,
    offset: sp.get("offset") ? Number(sp.get("offset")) : 0,
  };
  const { total, rows } = listCompanies(opts);
  return NextResponse.json({ total, count: rows.length, results: rows });
}
