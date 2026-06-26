import Link from "next/link";
import { cookies } from "next/headers";
import { ensureConfiguredAdminUser, getSessionUser, isAdminUser, SESSION_COOKIE } from "@/lib/auth";
import { getSchedulerDashboard } from "@/lib/cloud-scheduler";
import ScheduleManager from "./ScheduleManager";

export const dynamic = "force-dynamic";

export default async function AdminSchedulesPage() {
  await ensureConfiguredAdminUser();

  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return <AdminGate title="관리자 로그인 필요" />;
  if (!isAdminUser(user)) return <AdminGate title="관리자 권한 필요" email={user.email} />;

  const data = await getSchedulerDashboard();

  return (
    <>
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <div className="toggle">
          <Link href="/admin" className="btn ghost" style={{ borderRadius: 0, boxShadow: "none" }}>
            조회 로그
          </Link>
          <Link href="/admin/schedules" className="btn" style={{ borderRadius: 0, boxShadow: "none" }}>
            운영 스케줄
          </Link>
        </div>
      </div>
      <ScheduleManager initialData={data} />
    </>
  );
}

function AdminGate({ title, email }: { title: string; email?: string }) {
  const hasConfiguredAdmin = Boolean(process.env.BUTLER_ADMIN_EMAIL && process.env.BUTLER_ADMIN_PASSWORD);

  return (
    <div className="panel" style={{ maxWidth: 520, margin: "40px auto" }}>
      <h2>{title}</h2>
      {email ? <p className="muted">{email} 계정에는 관리자 권한이 없습니다.</p> : null}
      {!hasConfiguredAdmin ? (
        <p className="muted">
          관리자 계정 생성을 위해 <code>BUTLER_ADMIN_EMAIL</code>과 <code>BUTLER_ADMIN_PASSWORD</code>를 설정하세요.
        </p>
      ) : (
        <p className="muted">설정된 관리자 계정으로 로그인하면 접근할 수 있습니다.</p>
      )}
      <Link href="/login" className="btn" style={{ display: "inline-flex", marginTop: 12 }}>
        로그인
      </Link>
    </div>
  );
}
