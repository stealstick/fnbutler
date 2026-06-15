import { NextRequest, NextResponse } from "next/server";
import { getDb, migrate } from "@/lib/db";
import { createUser, createSession, SESSION_COOKIE, sessionCookieMaxAge } from "@/lib/auth";

export async function POST(req: NextRequest) {
  migrate(getDb());
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  if (!email || !password || password.length < 6) {
    return NextResponse.json({ error: "이메일과 6자 이상 비밀번호 필요" }, { status: 400 });
  }
  try {
    const user = await createUser(email, password);
    const token = await createSession(user.id);
    const res = NextResponse.json({ user });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: sessionCookieMaxAge,
    });
    return res;
  } catch (e) {
    const msg = (e as Error).message.includes("UNIQUE") ? "이미 가입된 이메일" : "가입 실패";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
