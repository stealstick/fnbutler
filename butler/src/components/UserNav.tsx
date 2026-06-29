"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Me {
  user: { email: string; is_admin?: number } | null;
}

export default function UserNav() {
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ user: null }));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe({ user: null });
    router.push("/");
    router.refresh();
  }

  if (!me) return null;
  if (!me.user)
    return (
      <Link href="/login" className="navlogin">
        로그인
      </Link>
    );
  return (
    <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
      {me.user.is_admin === 1 ? <Link href="/admin">관리자</Link> : null}
      {me.user.is_admin === 1 ? <Link href="/admin/schedules">스케줄</Link> : null}
      <Link href="/watchlist">관심목록</Link>
      <Link href="/settings" className="muted" style={{ fontSize: 12 }}>
        {me.user.email}
      </Link>
      <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={logout}>
        로그아웃
      </button>
    </span>
  );
}
