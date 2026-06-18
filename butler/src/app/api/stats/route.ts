import { NextResponse } from "next/server";
import { getStats, getRecentChanges } from "@/lib/repo";

/** DB 적재 현황 + 최근 변경 피드. */
export async function GET() {
  const [stats, recentChanges] = await Promise.all([getStats(), getRecentChanges(30)]);
  return NextResponse.json({ stats, recentChanges });
}
