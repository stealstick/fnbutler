import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";

/** 텔레그램 chat_id / 알림 on-off 설정. */
export async function POST(req: NextRequest) {
  const user = getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    telegramChatId?: string;
    alertsEnabled?: boolean;
  };
  const db = getDb();
  if (body.telegramChatId !== undefined) {
    db.prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(
      body.telegramChatId.trim() || null,
      user.id,
    );
  }
  if (body.alertsEnabled !== undefined) {
    db.prepare("UPDATE users SET alerts_enabled = ? WHERE id = ?").run(
      body.alertsEnabled ? 1 : 0,
      user.id,
    );
  }
  return NextResponse.json({ ok: true });
}
