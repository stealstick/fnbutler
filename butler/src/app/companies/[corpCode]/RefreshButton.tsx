"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Keystone에서 최신 데이터를 재수집(변경분 자동 로깅) 후 페이지 새로고침. */
export default function RefreshButton({ corpCode }: { corpCode: string }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function refresh() {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "detail", corpCode }),
      });
      const j = await r.json();
      if (j.ok) {
        setMsg(`리포트 +${j.reports} · 변경 +${j.changes}`);
        router.refresh();
      } else {
        setMsg("실패: " + (j.error ?? r.status));
      }
    } catch (e) {
      setMsg("오류: " + (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
      <button className="btn" onClick={refresh} disabled={loading}>
        {loading ? "수집 중…" : "↻ 최신 새로고침"}
      </button>
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </span>
  );
}
