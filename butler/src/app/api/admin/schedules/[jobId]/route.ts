import { NextRequest, NextResponse } from "next/server";
import { ensureConfiguredAdminUser, getSessionUser, isAdminUser, SESSION_COOKIE } from "@/lib/auth";
import { getSchedulerDashboard, isManagedScheduleId, mutateSchedulerJob, type SchedulerAction } from "@/lib/cloud-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIONS = new Set<SchedulerAction>(["pause", "resume", "run"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  await ensureConfiguredAdminUser();
  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "관리자 로그인 필요" }, { status: 401 });
  if (!isAdminUser(user)) return NextResponse.json({ error: "관리자 권한 필요" }, { status: 403 });

  const { jobId } = await ctx.params;
  if (!isManagedScheduleId(jobId)) return NextResponse.json({ error: "관리 대상 스케줄이 아닙니다." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { action?: SchedulerAction };
  const action = body.action;
  if (!action || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "action은 pause, resume, run 중 하나여야 합니다." }, { status: 400 });
  }

  try {
    const job = await mutateSchedulerJob(jobId, action);
    return NextResponse.json({ ok: true, job, dashboard: await getSchedulerDashboard() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
