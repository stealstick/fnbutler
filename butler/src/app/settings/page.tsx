"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function SettingsPage() {
  const [user, setUser] = useState<{ email: string; telegram_chat_id: string | null; alerts_enabled: number } | null | undefined>(undefined);
  const [tgConfigured, setTgConfigured] = useState(false);
  const [chatId, setChatId] = useState("");
  const [alerts, setAlerts] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((j) => {
      setUser(j.user);
      setTgConfigured(j.telegramConfigured);
      if (j.user) {
        setChatId(j.user.telegram_chat_id ?? "");
        setAlerts(j.user.alerts_enabled === 1);
      }
    });
  }, []);

  async function save() {
    setMsg(null);
    const r = await fetch("/api/auth/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegramChatId: chatId, alertsEnabled: alerts }),
    });
    setMsg(r.ok ? "저장됨" : "저장 실패");
  }

  if (user === undefined) return <div className="empty">불러오는 중…</div>;
  if (user === null)
    return (
      <div className="panel" style={{ maxWidth: 460, margin: "40px auto" }}>
        <h2>설정</h2>
        <p className="muted">로그인이 필요합니다. <Link href="/login" style={{ color: "var(--accent)" }}>로그인</Link></p>
      </div>
    );

  return (
    <div className="panel" style={{ maxWidth: 560, margin: "20px auto" }}>
      <h2>알림 설정 <span className="sub">목표주가 변경 텔레그램 알림</span></h2>
      <p className="muted" style={{ fontSize: 13 }}>
        텔레그램 봇과 1:1 대화를 시작한 뒤 chat_id 를 입력하세요. 관심목록에 담은 기업의 목표주가가
        바뀌면 매일 폴링에서 알림을 보냅니다.
        {!tgConfigured && (
          <><br /><span className="down">⚠️ 서버에 BUTLER_TELEGRAM_BOT_TOKEN 이 설정되지 않아 실제 발송은 비활성 상태입니다.</span></>
        )}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
        <label className="muted" style={{ fontSize: 12 }}>텔레그램 chat_id</label>
        <input className="input" placeholder="예: 123456789" value={chatId} onChange={(e) => setChatId(e.target.value)} />
        <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={alerts} onChange={(e) => setAlerts(e.target.checked)} />
          목표주가 변경 알림 받기
        </label>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn" onClick={save}>저장</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
      <p className="note">
        chat_id 확인: 봇에게 아무 메시지나 보낸 뒤
        <code> https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates </code> 의 result[].message.chat.id.
      </p>
    </div>
  );
}
