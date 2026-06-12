"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const r = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json();
    setLoading(false);
    if (!r.ok) {
      setErr(j.error ?? "오류");
      return;
    }
    router.push("/watchlist");
    router.refresh();
  }

  return (
    <div className="panel" style={{ maxWidth: 420, margin: "40px auto" }}>
      <h2>{mode === "login" ? "로그인" : "회원가입"}</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
        관심 기업을 즐겨찾기하고 목표주가 변경 시 텔레그램 알림을 받으세요.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        <input className="input" type="email" placeholder="이메일" value={email} required
          onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="비밀번호 (6자 이상)" value={password} required
          onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="down" style={{ fontSize: 13 }}>{err}</div>}
        <button className="btn" type="submit" disabled={loading}>
          {loading ? "처리 중…" : mode === "login" ? "로그인" : "가입하기"}
        </button>
      </form>
      <div className="muted" style={{ marginTop: 14, fontSize: 13 }}>
        {mode === "login" ? "계정이 없나요? " : "이미 계정이 있나요? "}
        <a style={{ cursor: "pointer", color: "var(--accent)" }}
          onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(null); }}>
          {mode === "login" ? "회원가입" : "로그인"}
        </a>
      </div>
    </div>
  );
}
