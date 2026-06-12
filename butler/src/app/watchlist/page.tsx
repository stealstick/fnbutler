"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { won, num, pct, signClass } from "@/lib/format";
import type { CompanyRow } from "@/lib/repo";

export default function WatchlistPage() {
  const [rows, setRows] = useState<CompanyRow[] | null>(null);
  const [auth, setAuth] = useState<boolean | null>(null);

  async function load() {
    const r = await fetch("/api/watchlist");
    if (r.status === 401) {
      setAuth(false);
      return;
    }
    setAuth(true);
    const j = await r.json();
    setRows(j.results);
  }
  useEffect(() => {
    load();
  }, []);

  async function remove(corpCode: string) {
    await fetch(`/api/watchlist?corpCode=${corpCode}`, { method: "DELETE" });
    load();
  }

  if (auth === false)
    return (
      <div className="panel" style={{ maxWidth: 460, margin: "40px auto" }}>
        <h2>관심목록</h2>
        <p className="muted">
          로그인이 필요합니다.{" "}
          <Link href="/login" style={{ color: "var(--accent)" }}>로그인</Link>
        </p>
      </div>
    );

  return (
    <div className="panel">
      <h2>
        관심목록 <span className="sub">목표주가 변경 시 텔레그램 알림 대상 · <Link href="/settings" style={{ color: "var(--accent)" }}>알림 설정</Link></span>
      </h2>
      {!rows ? (
        <div className="empty">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          아직 관심 기업이 없습니다. <Link href="/companies" style={{ color: "var(--accent)" }}>기업</Link>에서 ☆ 관심추가를 눌러보세요.
        </div>
      ) : (
        <div className="scrollx">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">종목</th>
                <th>현재가</th>
                <th>등락</th>
                <th>평균 목표주가</th>
                <th>상승여력</th>
                <th>커버</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.corp_code}>
                  <td className="l">
                    <Link href={`/companies/${c.corp_code}`}>
                      <strong>{c.name}</strong>{" "}
                      <span className="muted mono" style={{ fontSize: 12 }}>{c.stock_code}</span>
                    </Link>
                  </td>
                  <td className="mono">{num(c.price)}</td>
                  <td className={"mono " + signClass(c.fluctuation_rate)}>{pct(c.fluctuation_rate)}</td>
                  <td className="mono">{c.target_price_avg ? num(c.target_price_avg) : "-"}</td>
                  <td className={"mono " + signClass(c.target_return_rate)}>
                    {c.target_return_rate != null ? pct(c.target_return_rate) : "-"}
                  </td>
                  <td className="mono">{c.cover_securities ? <span className="pill">{c.cover_securities}</span> : "-"}</td>
                  <td>
                    <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => remove(c.corp_code)}>
                      제거
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
