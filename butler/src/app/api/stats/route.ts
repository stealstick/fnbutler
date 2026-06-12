import { NextResponse } from "next/server";
import { getStats, getRecentChanges } from "@/lib/repo";

/** DB 적재 현황 + 최근 변경 피드. */
export function GET() {
  return NextResponse.json({ stats: getStats(), recentChanges: getRecentChanges(30) });
}
