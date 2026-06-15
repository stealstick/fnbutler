import { NextRequest, NextResponse } from "next/server";
import { getDb, migrate } from "@/lib/db";
import { authenticate, createSession, SESSION_COOKIE, sessionCookieMaxAge } from "@/lib/auth";

export async function POST(req: NextRequest) {
  migrate(getDb());
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  const user = email && password ? await authenticate(email, password) : null;
  if (!user) return NextResponse.json({ error: "이메일 또는 비밀번호 오류" }, { status: 401 });
  const token = await createSession(user.id);
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: sessionCookieMaxAge,
  });
  return res;
}
