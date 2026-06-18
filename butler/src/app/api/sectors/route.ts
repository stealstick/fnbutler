import { NextResponse } from "next/server";
import { listSectorAggs } from "@/lib/repo";

/** 섹터 집계 목록 (기업수·평균 상승여력·평균 PER/PBR·시총합). */
export async function GET() {
  return NextResponse.json({ results: await listSectorAggs() });
}
