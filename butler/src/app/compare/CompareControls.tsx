"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Hit {
  corp_code: string;
  name: string;
  stock_code: string;
  sector_name: string | null;
}

/** 비교 페이지 상단 컨트롤: 기업 검색 추가 + 공유(링크 복사). codes 순서를 보존한다. */
export default function CompareControls({ codes }: { codes: string[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/companies?q=${encodeURIComponent(q)}&limit=8`);
      const d = await r.json();
      setHits(d.results ?? []);
      setOpen(true);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function add(code: string) {
    if (codes.includes(code)) return;
    setQ("");
    setHits([]);
    setOpen(false);
    router.push(`/compare?codes=${[...codes, code].join(",")}`);
  }

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "기업 비교 — butler.view", url });
        return;
      }
    } catch {
      /* 사용자가 공유 취소 → 클립보드 폴백 */
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("이 링크를 복사하세요", url);
    }
  }

  return (
    <div className="toolbar" style={{ marginBottom: 0 }}>
      <div ref={boxRef} style={{ position: "relative" }}>
        <input
          className="input search"
          placeholder="기업 추가 (기업명·종목코드)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits.length && setOpen(true)}
        />
        {open && hits.length > 0 && (
          <div className="cmp-suggest">
            {hits.map((h) => {
              const already = codes.includes(h.corp_code);
              return (
                <button
                  key={h.corp_code}
                  className="cmp-suggest-item"
                  disabled={already}
                  onClick={() => add(h.corp_code)}
                >
                  <strong>{h.name}</strong>
                  <span className="muted mono" style={{ fontSize: 12 }}>{h.stock_code}</span>
                  <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
                    {already ? "추가됨" : h.sector_name || ""}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <button className="btn" onClick={share}>
        {copied ? "✓ 링크 복사됨" : "🔗 공유"}
      </button>
    </div>
  );
}
