import { NextRequest, NextResponse } from "next/server";
import { getDb, migrate } from "@/lib/db";
import { ingestCompanies, ingestDetail } from "@/lib/ingest";

export const maxDuration = 300;

/**
 * 온디맨드 수집 트리거.
 *   POST /api/ingest  { "kind": "companies" }
 *   POST /api/ingest  { "kind": "detail", "corpCode": "00937324" }
 *
 * 기업뷰에서 "최신 새로고침" 버튼이 이 라우트를 호출 → 변경분 자동 로깅.
 */
export async function POST(req: NextRequest) {
  const db = getDb();
  await migrate(db);
  const body = (await req.json().catch(() => ({}))) as { kind?: string; corpCode?: string };

  if (body.kind === "detail" && body.corpCode) {
    const r = await ingestDetail(db, body.corpCode);
    return NextResponse.json({ ok: true, ...r });
  }
  if (body.kind === "companies") {
    const r = await ingestCompanies(db);
    return NextResponse.json({ ok: true, ...r });
  }
  return NextResponse.json({ ok: false, error: "kind 는 'companies' | 'detail'(+corpCode)" }, { status: 400 });
}
