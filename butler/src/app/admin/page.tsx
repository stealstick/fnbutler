import Link from "next/link";
import { cookies } from "next/headers";
import { ensureConfiguredAdminUser, getSessionUser, isAdminUser, SESSION_COOKIE } from "@/lib/auth";
import { getAdminCompanyViewData } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await ensureConfiguredAdminUser();

  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return <AdminGate title="관리자 로그인 필요" />;
  if (!isAdminUser(user)) return <AdminGate title="관리자 권한 필요" email={user.email} />;

  const data = await getAdminCompanyViewData(200);

  return (
    <>
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <div className="toggle">
          <Link href="/admin" className="btn" style={{ borderRadius: 0, boxShadow: "none" }}>
            조회 로그
          </Link>
          <Link href="/admin/schedules" className="btn ghost" style={{ borderRadius: 0, boxShadow: "none" }}>
            운영 스케줄
          </Link>
        </div>
      </div>

      <div className="panel">
        <h2>
          관리자 <span className="sub">회사 조회 히스토리 · 브라우저 UUID 기준 사용자 관심도</span>
          <Link href="/admin/schedules" className="btn ghost panel-title-action">
            운영 스케줄
          </Link>
        </h2>
        <div className="stat-row">
          <Stat n={data.totals.views} l="전체 조회" />
          <Stat n={data.totals.browsers} l="브라우저 UUID" />
          <Stat n={data.totals.loggedUsers} l="로그인 유저" />
          <Stat n={data.totals.companies} l="조회 기업" />
        </div>
      </div>

      <div className="two-col">
        <div className="panel">
          <h2>
            많이 본 기업 <span className="sub">조회수 순</span>
          </h2>
          {data.topCompanies.length === 0 ? (
            <div className="empty">아직 조회 기록이 없습니다.</div>
          ) : (
            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th className="l">기업</th>
                    <th>조회</th>
                    <th>브라우저</th>
                    <th>로그인</th>
                    <th>최근</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topCompanies.map((row) => (
                    <tr key={row.corp_code}>
                      <td className="l">
                        <Link href={`/companies/${row.corp_code}`}>
                          <strong>{row.name}</strong>{" "}
                          <span className="muted mono" style={{ fontSize: 12 }}>
                            {row.stock_code}
                          </span>
                        </Link>
                        {row.market ? (
                          <span className="pill" style={{ marginLeft: 6 }}>
                            {row.market}
                          </span>
                        ) : null}
                      </td>
                      <td className="mono">{row.views}</td>
                      <td className="mono">{row.browsers}</td>
                      <td className="mono">{row.logged_users}</td>
                      <td className="mono muted">{dt(row.last_viewed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>
            유저별 관심 기업 <span className="sub">브라우저 UUID 기준</span>
          </h2>
          {data.visitors.length === 0 ? (
            <div className="empty">아직 브라우저별 기록이 없습니다.</div>
          ) : (
            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th className="l">유저</th>
                    <th>조회</th>
                    <th>기업</th>
                    <th className="l">관심 기업 후보</th>
                    <th>최근</th>
                  </tr>
                </thead>
                <tbody>
                  {data.visitors.map((row) => (
                    <tr key={row.browser_uuid}>
                      <td className="l">
                        <div>{row.emails || "비로그인"}</div>
                        <div className="muted mono" style={{ fontSize: 11 }}>
                          {shortUuid(row.browser_uuid)}
                        </div>
                      </td>
                      <td className="mono">{row.views}</td>
                      <td className="mono">{row.companies}</td>
                      <td className="l" style={{ whiteSpace: "normal", minWidth: 260 }}>
                        {row.top_companies || "-"}
                      </td>
                      <td className="mono muted">{dt(row.last_viewed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>
          로우 데이터 <span className="sub">최근 200건</span>
        </h2>
        {data.recent.length === 0 ? (
          <div className="empty">아직 이벤트가 없습니다.</div>
        ) : (
          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>시간</th>
                  <th className="l">브라우저 UUID</th>
                  <th className="l">계정</th>
                  <th className="l">기업</th>
                  <th className="l">경로</th>
                  <th className="l">Referrer</th>
                  <th className="l">User-agent</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((row) => (
                  <tr key={row.id}>
                    <td className="mono muted">{dt(row.viewed_at)}</td>
                    <td className="l mono" style={{ fontSize: 11 }}>
                      {row.browser_uuid}
                    </td>
                    <td className="l">{row.email || "비로그인"}</td>
                    <td className="l">
                      <Link href={`/companies/${row.corp_code}`}>
                        <strong>{row.name}</strong>{" "}
                        <span className="muted mono" style={{ fontSize: 12 }}>
                          {row.stock_code}
                        </span>
                      </Link>
                    </td>
                    <td className="l mono muted" style={{ whiteSpace: "normal", minWidth: 180 }}>
                      {row.path || "-"}
                    </td>
                    <td className="l muted" style={{ whiteSpace: "normal", minWidth: 180 }}>
                      {row.referrer || "-"}
                    </td>
                    <td className="l muted" style={{ whiteSpace: "normal", minWidth: 260 }}>
                      {row.user_agent || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <div className="s">
      <div className="n mono">{n.toLocaleString("ko-KR")}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function shortUuid(uuid: string): string {
  return `${uuid.slice(0, 8)}...${uuid.slice(-4)}`;
}

function dt(value: string | null | undefined): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
