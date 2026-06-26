import { NextRequest, NextResponse } from "next/server";
import { ensureConfiguredAdminUser, getSessionUser, isAdminUser, SESSION_COOKIE } from "@/lib/auth";
import { getSchedulerDashboard } from "@/lib/cloud-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureConfiguredAdminUser();
  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "관리자 로그인 필요" }, { status: 401 });
  if (!isAdminUser(user)) return NextResponse.json({ error: "관리자 권한 필요" }, { status: 403 });

  return NextResponse.json(await getSchedulerDashboard());
}
