import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { userStore } from "@/lib/userstore";
import { getBotUsername, telegramConfigured } from "@/lib/telegram";

export const runtime = "nodejs";

/** 텔레그램 자동 연결용 딥링크 발급. 로그인 세션 → 일회성 토큰 → t.me 딥링크 URL. */
const LINK_TTL_MIN = 15;

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "로그인 필요" }, { status: 401 });
  if (!telegramConfigured()) return NextResponse.json({ error: "서버에 봇 토큰이 설정되지 않았습니다" }, { status: 503 });

  const username = await getBotUsername();
  if (!username) return NextResponse.json({ error: "봇 정보를 가져올 수 없습니다" }, { status: 503 });

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_TTL_MIN * 60_000).toISOString();
  await userStore.createLinkToken(token, user.id, expiresAt);

  return NextResponse.json({
    url: `https://t.me/${username}?start=${token}`,
    botUsername: username,
    expiresInSec: LINK_TTL_MIN * 60,
  });
}
