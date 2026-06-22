import { NextRequest, NextResponse } from "next/server";
import { all, ensureMigrated } from "@/lib/db";

type EstimateConsensusRow = {
  corp_code: string;
  metric: string;
  fiscal_year: number;
  quarter: number;
  period_type: "Q" | "A";
  avg_value: number | null;
  low_value: number | null;
  high_value: number | null;
  year_ago_value: number | null;
  growth_pct: number | null;
  analyst_count: number | null;
  date_label: string | null;
  end_date: string | null;
  source: string;
  updated_at: string;
};

/** Yahoo식 컨센서스 범위. ?period=Q(분기, 기본) | A(연간), ?source=yahoo:earningsTrend */
export async function GET(req: NextRequest, ctx: { params: Promise<{ corpCode: string }> }) {
  await ensureMigrated();
  const { corpCode } = await ctx.params;
  const period = req.nextUrl.searchParams.get("period") === "A" ? "A" : "Q";
  const source = req.nextUrl.searchParams.get("source");
  const params: unknown[] = [corpCode, period];
  const where = ["corp_code = $1", "period_type = $2"];
  if (source) {
    params.push(source);
    where.push(`source = $${params.length}`);
  }

  const rows = await all<EstimateConsensusRow>(
    `SELECT corp_code, metric, fiscal_year, quarter, period_type,
            avg_value, low_value, high_value, year_ago_value, growth_pct,
            analyst_count, date_label, end_date, source, updated_at
       FROM estimate_consensus
      WHERE ${where.join(" AND ")}
      ORDER BY metric, fiscal_year, quarter, source`,
    params,
  );

  return NextResponse.json({ corpCode, period, source: source ?? null, rows });
}
