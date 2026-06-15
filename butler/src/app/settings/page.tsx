"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Me = { email: string; telegram_chat_id: string | null; alerts_enabled: number };

export default function SettingsPage() {
  const [user, setUser] = useState<Me | null | undefined>(undefined);
  const [tgConfigured, setTgConfigured] = useState(false);
  const [alerts, setAlerts] = useState(true);
  const [chatId, setChatId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadMe(): Promise<Me | null> {
    const j = await fetch("/api/auth/me").then((r) => r.json());
    setUser(j.user);
    setTgConfigured(j.telegramConfigured);
    if (j.user) {
      setAlerts(j.user.alerts_enabled === 1);
      setChatId(j.user.telegram_chat_id ?? "");
    }
    return j.user ?? null;
  }

  useEffect(() => {
    loadMe();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function connect() {
    setMsg(null);
    const r = await fetch("/api/auth/telegram/link", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) {
      setMsg(j.error || "연결 링크 생성 실패");
      return;
    }
    window.open(j.url, "_blank");
    setLinking(true);
    setMsg("텔레그램에서 ‘시작’(Start)을 누르면 자동으로 연결됩니다…");
    let tries = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      tries++;
      const u = await loadMe();
      if (u?.telegram_chat_id) {
        if (pollRef.current) clearInterval(pollRef.current);
        setLinking(false);
        setMsg("✅ 텔레그램 연결 완료!");
      } else if (tries > 60) {
        if (pollRef.current) clearInterval(pollRef.current);
        setLinking(false);
        setMsg("아직 연결이 확인되지 않았어요. 텔레그램에서 ‘시작’을 눌렀는지 확인해주세요.");
      }
    }, 2000);
  }

  async function disconnect() {
    setMsg(null);
    const r = await fetch("/api/auth/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegramChatId: "" }),
    });
    setMsg(r.ok ? "연결 해제됨" : "실패");
    await loadMe();
  }

  async function saveAlerts(next: boolean) {
    setAlerts(next);
    await fetch("/api/auth/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alertsEnabled: next }),
    });
  }

  async function saveManual() {
    setMsg(null);
    const r = await fetch("/api/auth/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegramChatId: chatId }),
    });
    setMsg(r.ok ? "저장됨" : "저장 실패");
    await loadMe();
  }

  if (user === undefined) return <div className="empty">불러오는 중…</div>;
  if (user === null)
    return (
      <div className="panel" style={{ maxWidth: 460, margin: "40px auto" }}>
        <h2>설정</h2>
        <p className="muted">
          로그인이 필요합니다.{" "}
          <Link href="/login" style={{ color: "var(--accent)" }}>
            로그인
          </Link>
        </p>
      </div>
    );

  const connected = !!user.telegram_chat_id;

  return (
    <div className="panel" style={{ maxWidth: 560, margin: "20px auto" }}>
      <h2>
        알림 설정 <span className="sub">목표주가 변경 텔레그램 알림</span>
      </h2>
      <p className="muted" style={{ fontSize: 13 }}>
        관심목록에 담은 기업의 증권사별 목표주가가 바뀌면 텔레그램으로 알려드립니다.
        {!tgConfigured && (
          <>
            <br />
            <span className="down">⚠️ 서버에 봇 토큰(BUTLER_TELEGRAM_BOT_TOKEN)이 없어 실제 발송은 비활성 상태입니다.</span>
          </>
        )}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="muted" style={{ fontSize: 12, width: 64 }}>텔레그램</span>
          {connected ? (
            <>
              <span className="up">✅ 연결됨</span>
              <code style={{ fontSize: 12 }}>chat_id {user.telegram_chat_id}</code>
              <button className="btn" onClick={disconnect} style={{ marginLeft: "auto" }}>
                연결 해제
              </button>
            </>
          ) : (
            <>
              <span className="muted">미연결</span>
              <button
                className="btn"
                onClick={connect}
                disabled={linking || !tgConfigured}
                style={{ marginLeft: "auto" }}
              >
                {linking ? "연결 대기 중…" : "텔레그램 연결"}
              </button>
            </>
          )}
        </div>

        <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={alerts} onChange={(e) => saveAlerts(e.target.checked)} />
          목표주가 변경 알림 받기
        </label>

        {msg && <span className="muted">{msg}</span>}
      </div>

      <details style={{ marginTop: 18 }}>
        <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
          수동으로 chat_id 입력 (자동 연결이 안 될 때)
        </summary>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            className="input"
            placeholder="예: 123456789"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
          <button className="btn" onClick={saveManual}>
            저장
          </button>
        </div>
        <p className="note">봇에게 아무 메시지나 보내면 chat_id 를 회신합니다.</p>
      </details>
    </div>
  );
}
