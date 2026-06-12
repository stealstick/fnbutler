import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { telegramConfigured } from "@/lib/telegram";

export function GET(req: NextRequest) {
  const user = getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ user, telegramConfigured: telegramConfigured() });
}
