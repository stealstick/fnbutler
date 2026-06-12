import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { addWatch, removeWatch, getWatchlist } from "@/lib/repo";

function user(req: NextRequest) {
  return getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
}

export function GET(req: NextRequest) {
  const u = user(req);
  if (!u) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });
  return NextResponse.json({ results: getWatchlist(u.id) });
}

export async function POST(req: NextRequest) {
  const u = user(req);
  if (!u) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });
  const { corpCode } = (await req.json().catch(() => ({}))) as { corpCode?: string };
  if (!corpCode) return NextResponse.json({ error: "corpCode 필요" }, { status: 400 });
  addWatch(u.id, corpCode);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const u = user(req);
  if (!u) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });
  const corpCode = req.nextUrl.searchParams.get("corpCode");
  if (!corpCode) return NextResponse.json({ error: "corpCode 필요" }, { status: 400 });
  removeWatch(u.id, corpCode);
  return NextResponse.json({ ok: true });
}
