import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { userStore } from "@/lib/userstore";

/** 텔레그램 chat_id / 알림 on-off 설정. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    telegramChatId?: string;
    alertsEnabled?: boolean;
  };
  await userStore.updateUserTelegram(user.id, {
    telegramChatId: body.telegramChatId !== undefined ? body.telegramChatId.trim() : undefined,
    alertsEnabled: body.alertsEnabled,
  });
  return NextResponse.json({ ok: true });
}
