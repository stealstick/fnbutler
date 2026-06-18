"use client";

import { useEffect, useMemo, useState } from "react";
import { won } from "@/lib/format";

/* ── 타입 ───────────────────────────────────────────────────────────────── */
interface Ev {
  id: string;
  category: string;
  subcategory: string | null;
  country: string | null;
  event_date: string;
  event_time: string | null;
  tz: string | null;
  title: string;
  symbol: string | null;
  importance: number;
  actual: string | null;
  consensus: string | null;
  previous: string | null;
  market_cap: number | null;
  url: string | null;
  note: string | null;
  source: string;
}
interface Stats {
  total: number;
  macro: number;
  earningsIntl: number;
  earningsKr: number;
  minDate: string | null;
  maxDate: string | null;
}

/* ── 메타/색상 ──────────────────────────────────────────────────────────── */
const KIND_META: Record<string, { label: string; color: string }> = {
  central_bank: { label: "통화정책", color: "#a855f7" },
  inflation: { label: "물가", color: "#ef4444" },
  employment: { label: "고용", color: "#22c55e" },
  activity: { label: "경기·소비", color: "#3b82f6" },
  other: { label: "기타", color: "#8b93a7" },
  earnings_intl: { label: "해외실적", color: "#14b8a6" },
  earnings_kr: { label: "국내실적", color: "#f5a623" },
};
const CATS = [
  { k: "macro", label: "거시지표" },
  { k: "earnings_intl", label: "해외실적" },
  { k: "earnings_kr", label: "국내실적" },
];
const COUNTRIES = [
  { k: "US", label: "🇺🇸 미국" },
  { k: "CN", label: "🇨🇳 중국" },
  { k: "JP", label: "🇯🇵 일본" },
  { k: "KR", label: "🇰🇷 한국" },
];
const COUNTRY_LABEL: Record<string, string> = { US: "미국", CN: "중국", JP: "일본", KR: "한국", EZ: "유로존" };
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const kindOf = (e: Ev) => (e.category === "macro" ? e.subcategory || "other" : e.category);
/** 날짜 셀/리스트 내 표시 우선순위(작을수록 먼저). 통화정책 > 거시(중요도) > 실적. */
function dispRank(e: Ev) {
  if (e.category === "macro") return e.subcategory === "central_bank" ? 0 : 10 - e.importance;
  return 100;
}
const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** GMT 시각 → KST(+9). 날짜가 넘어가면 nextDay=true. */
function gmtToKst(dateStr: string, timeStr: string) {
  const utc = new Date(`${dateStr}T${timeStr}:00Z`);
  const kst = new Date(utc.getTime() + 9 * 3600_000);
  return {
    time: `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`,
    nextDay: kst.getUTCDate() !== utc.getUTCDate(),
  };
}
function fmtUsd(n: number) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString("en-US")}`;
}
function mcapLabel(e: Ev) {
  if (e.market_cap == null) return null;
  return e.category === "earnings_kr" ? won(e.market_cap) : fmtUsd(e.market_cap);
}
function nextDayYmd(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}
/** 개별 이벤트를 구글 캘린더에 추가하는 TEMPLATE URL. */
function gcalEventUrl(e: Ev) {
  const ico = e.category === "macro" ? "📊" : e.category === "earnings_kr" ? "🇰🇷" : "🌐";
  const ctry = e.country ? `[${COUNTRY_LABEL[e.country] ?? e.country}] ` : "";
  const sym = e.symbol ? ` (${e.symbol})` : "";
  const text = `${ico} ${ctry}${e.title}${sym}`;
  let dates: string;
  if (e.event_time && e.tz === "GMT") {
    const [h, mi] = e.event_time.split(":");
    const s = new Date(`${e.event_date}T${h}:${mi}:00Z`);
    const en = new Date(s.getTime() + 3600_000);
    const f = (D: Date) =>
      `${D.getUTCFullYear()}${pad(D.getUTCMonth() + 1)}${pad(D.getUTCDate())}T${pad(D.getUTCHours())}${pad(
        D.getUTCMinutes(),
      )}00Z`;
    dates = `${f(s)}/${f(en)}`;
  } else {
    dates = `${e.event_date.replace(/-/g, "")}/${nextDayYmd(e.event_date)}`;
  }
  const det = [
    e.consensus ? `예상 ${e.consensus}` : "",
    e.previous ? `이전 ${e.previous}` : "",
    e.actual ? `실제 ${e.actual}` : "",
    e.note || "",
  ]
    .filter(Boolean)
    .join(" · ");
  const q = new URLSearchParams({ action: "TEMPLATE", text, dates });
  if (det) q.set("details", det);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/* ── 컴포넌트 ───────────────────────────────────────────────────────────── */
export default function CalendarView({ events, stats }: { events: Ev[]; stats: Stats }) {
  const today = useState(() => isoOf(new Date()))[0];
  const [view, setView] = useState<"month" | "list">("month");
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [catSel, setCatSel] = useState<string[]>([]);
  const [ctrySel, setCtrySel] = useState<string[]>([]);
  const [coreOnly, setCoreOnly] = useState(true); // 핵심(중요도≥2)만
  const [selectedDate, setSelectedDate] = useState<string>(today);

  const [origin, setOrigin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [feedToken, setFeedToken] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState("");
  const [copyMsg, setCopyMsg] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const minImp = coreOnly ? 2 : 1;

  /* 초기: origin + 계정 저장 필터 / localStorage 복원 */
  useEffect(() => {
    setOrigin(window.location.origin);
    (async () => {
      try {
        const r = await fetch("/api/calendar/prefs");
        if (r.ok) {
          const d = await r.json();
          setAuthed(true);
          setFeedToken(d.feedToken ?? null);
          if (d.prefs) applyPrefs(d.prefs);
        } else {
          loadLocal();
        }
      } catch {
        loadLocal();
      } finally {
        setHydrated(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyPrefs(p: any) {
    if (Array.isArray(p.categories)) setCatSel(p.categories);
    if (Array.isArray(p.countries)) setCtrySel(p.countries);
    if (typeof p.minImportance === "number") setCoreOnly(p.minImportance >= 2);
  }
function loadLocal() {
    try {
      const raw = localStorage.getItem("keystone.cal.filters") ?? localStorage.getItem("butler.cal.filters");
      if (raw) applyPrefs(JSON.parse(raw));
    } catch {
      /* noop */
    }
  }
  /* 익명 사용자는 필터를 localStorage 에 보존 */
  useEffect(() => {
    if (!hydrated || authed) return;
    try {
      localStorage.setItem(
        "keystone.cal.filters",
        JSON.stringify({ categories: catSel, countries: ctrySel, minImportance: minImp }),
      );
    } catch {
      /* noop */
    }
  }, [catSel, ctrySel, minImp, authed, hydrated]);

  const toggle = (arr: string[], k: string, set: (v: string[]) => void) =>
    set(arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]);

  /* 필터 적용 */
  const filtered = useMemo(() => {
    const cat = new Set(catSel);
    const ctry = new Set(ctrySel);
    return events.filter((e) => {
      if (cat.size && !cat.has(e.category)) return false;
      if (e.country && ctry.size && !ctry.has(e.country)) return false;
      if (e.importance < minImp) return false;
      return true;
    });
  }, [events, catSel, ctrySel, minImp]);

  const byDate = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of filtered) {
      const a = m.get(e.event_date);
      if (a) a.push(e);
      else m.set(e.event_date, [e]);
    }
    // 날짜별 표시 우선순위: 통화정책 > 그 외 거시(중요도순) > 실적(시총순).
    // 실적이 많은 날에도 FOMC·BOJ·금통위 같은 핵심 거시가 먼저 보이게 한다.
    for (const arr of m.values()) arr.sort((a, b) => dispRank(a) - dispRank(b) || (b.market_cap ?? 0) - (a.market_cap ?? 0));
    return m;
  }, [filtered]);

  const cells = useMemo(() => {
    const first = new Date(anchor.y, anchor.m, 1);
    const start = new Date(anchor.y, anchor.m, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [anchor]);

  /* 구독/연동 URL */
  function feedQuery() {
    const p = new URLSearchParams();
    if (catSel.length) p.set("category", catSel.join(","));
    if (ctrySel.length) p.set("country", ctrySel.join(","));
    const s = p.toString();
    return s ? `?${s}` : "";
  }
  const personalUrl = feedToken && origin ? `${origin}/api/calendar/ics?u=${feedToken}` : "";
  const filterUrl = origin ? `${origin}/api/calendar/ics${feedQuery()}` : "";
  const subscribeUrl = personalUrl || filterUrl;
  const webcal = subscribeUrl.replace(/^https?:/, "webcal:");
  const googleSubUrl = subscribeUrl
    ? `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`
    : "#";
  const downloadUrl = subscribeUrl + (subscribeUrl.includes("?") ? "&" : "?") + "download=1";

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg("복사됨!");
      setTimeout(() => setCopyMsg(""), 1800);
    } catch {
      setCopyMsg("복사 실패");
      setTimeout(() => setCopyMsg(""), 1800);
    }
  }

  async function savePrefs() {
    const body = { categories: catSel, countries: ctrySel, minImportance: minImp };
    const r = await fetch("/api/calendar/prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const d = await r.json();
      setFeedToken(d.feedToken ?? null);
      setSavedMsg("필터가 계정에 저장됐어요. 개인 구독 URL이 갱신됩니다.");
    } else {
      setSavedMsg("저장하려면 로그인이 필요해요.");
    }
    setTimeout(() => setSavedMsg(""), 3500);
  }

  const moveMonth = (delta: number) =>
    setAnchor((a) => {
      const d = new Date(a.y, a.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const goToday = () => {
    const d = new Date();
    setAnchor({ y: d.getFullYear(), m: d.getMonth() });
    setSelectedDate(today);
  };

  const selectedEvents = byDate.get(selectedDate) ?? [];

  /* 리스트뷰: 오늘 이후(또는 윈도우 시작부터) 날짜별 그룹 */
  const listGroups = useMemo(() => {
    const dates = Array.from(byDate.keys())
      .filter((d) => d >= today)
      .sort();
    return dates.map((d) => ({ date: d, items: byDate.get(d)! }));
  }, [byDate, today]);

  return (
    <>
      {/* 헤더 */}
      <div className="panel">
        <h2>
          경제 · 실적 캘린더{" "}
          <span className="sub">
            FOMC·BOJ·한국은행, 미국 CPI/PPI/고용, 중국 경기·물가·소비, Nasdaq TOP500·국내 실적발표
          </span>
        </h2>
        <div className="stat-row" style={{ marginBottom: 6 }}>
          <S n={stats.macro} l="거시지표" />
          <S n={stats.earningsIntl} l="해외 실적" />
          <S n={stats.earningsKr} l="국내 실적" />
          <S n={stats.total} l="전체 이벤트" />
        </div>
        <div className="note">
          출처: Nasdaq 경제·실적 캘린더(공개 · 해외 실적 TOP500)
          {stats.earningsKr === 0 ? " · 국내 실적은 DART_API_KEY 설정 시 표시" : " · 국내 실적 DART"}
          {stats.minDate ? ` · 수집범위 ${stats.minDate} ~ ${stats.maxDate}` : ""}
        </div>
      </div>

      {/* 툴바 */}
      <div className="panel">
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <div className="toggle">
            <button className={view === "month" ? "on" : ""} onClick={() => setView("month")}>
              월간
            </button>
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>
              리스트
            </button>
          </div>
          <span style={{ width: 1, height: 22, background: "var(--border)" }} />
          {CATS.map((c) => (
            <button
              key={c.k}
              className={"tab" + (catSel.includes(c.k) ? " active" : "")}
              onClick={() => toggle(catSel, c.k, setCatSel)}
            >
              <i className="cal-swatch" style={{ background: KIND_META[c.k === "macro" ? "activity" : c.k].color }} />
              {c.label}
            </button>
          ))}
          <span style={{ width: 1, height: 22, background: "var(--border)" }} />
          {COUNTRIES.map((c) => (
            <button
              key={c.k}
              className={"tab" + (ctrySel.includes(c.k) ? " active" : "")}
              onClick={() => toggle(ctrySel, c.k, setCtrySel)}
            >
              {c.label}
            </button>
          ))}
          <button
            className={"tab" + (!coreOnly ? " active" : "")}
            onClick={() => setCoreOnly((v) => !v)}
            title="전체 지표(중요도 낮은 항목 포함) 표시"
          >
            {coreOnly ? "핵심만" : "전체 지표"}
          </button>
          {(catSel.length > 0 || ctrySel.length > 0) && (
            <button
              className="btn ghost"
              onClick={() => {
                setCatSel([]);
                setCtrySel([]);
              }}
            >
              초기화
            </button>
          )}
        </div>

        {/* 구글 캘린더 연동 */}
        <div className="cal-gbar">
          <span className="cal-gbar-title">📅 구글 캘린더 연동</span>
          <a
            className="btn"
            href={googleSubUrl}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!subscribeUrl}
          >
            구글 캘린더 구독
          </a>
          <button className="btn ghost" onClick={() => copy(subscribeUrl)} disabled={!subscribeUrl}>
            구독 URL 복사
          </button>
          <a className="btn ghost" href={downloadUrl || "#"} download>
            .ics 내려받기
          </a>
          {authed ? (
            <button className="btn ghost" onClick={savePrefs}>
              내 필터 저장
            </button>
          ) : (
            <a className="btn ghost" href="/login">
              로그인하고 필터 저장
            </a>
          )}
          {copyMsg && <span className="cal-flash">{copyMsg}</span>}
          {savedMsg && <span className="cal-flash">{savedMsg}</span>}
        </div>
        <div className="note" style={{ marginTop: 6 }}>
          {personalUrl
            ? "‘구독 URL 복사’는 계정에 저장한 필터가 적용된 개인 피드예요. 구글 캘린더 → 다른 캘린더 + → URL로 추가 에 붙여넣으면 6시간마다 자동 동기화됩니다."
            : "‘구독 URL 복사’ 후 구글 캘린더 → 다른 캘린더 + → URL로 추가 에 붙여넣으면 자동 동기화돼요. (현재 화면 필터가 그대로 반영됩니다)"}
        </div>
      </div>

      {/* 본문 */}
      {view === "month" ? (
        <div className="panel">
          <div className="cal-monthbar">
            <button className="btn ghost" onClick={() => moveMonth(-1)} aria-label="이전 달">
              ‹
            </button>
            <strong className="cal-monthlabel">
              {anchor.y}년 {anchor.m + 1}월
            </strong>
            <button className="btn ghost" onClick={() => moveMonth(1)} aria-label="다음 달">
              ›
            </button>
            <button className="btn ghost" onClick={goToday}>
              오늘
            </button>
          </div>
          <div className="cal-grid">
            {WEEKDAYS.map((w, i) => (
              <div key={w} className={"cal-wh" + (i === 0 ? " sun" : i === 6 ? " sat" : "")}>
                {w}
              </div>
            ))}
            {cells.map((d) => {
              const iso = isoOf(d);
              const inMonth = d.getMonth() === anchor.m;
              const isToday = iso === today;
              const isSel = iso === selectedDate;
              const dayEvents = byDate.get(iso) ?? [];
              const dow = d.getDay();
              return (
                <button
                  key={iso}
                  className={
                    "cal-cell" +
                    (inMonth ? "" : " out") +
                    (isToday ? " today" : "") +
                    (isSel ? " sel" : "")
                  }
                  onClick={() => setSelectedDate(iso)}
                >
                  <div className={"cal-daynum" + (dow === 0 ? " sun" : dow === 6 ? " sat" : "")}>
                    {d.getDate()}
                  </div>
                  <div className="cal-chips">
                    {dayEvents.slice(0, 3).map((e) => {
                      const meta = KIND_META[kindOf(e)];
                      return (
                        <span
                          key={e.id}
                          className="cal-chip"
                          style={{ color: meta.color, borderColor: meta.color + "66" }}
                          title={`${e.title}${e.symbol ? " (" + e.symbol + ")" : ""}`}
                        >
                          <i className="cal-dot" style={{ background: meta.color }} />
                          {e.category === "macro"
                            ? `${e.country ?? ""} ${shorten(e.title)}`
                            : e.symbol || shorten(e.title)}
                        </span>
                      );
                    })}
                    {dayEvents.length > 3 && <span className="cal-more">+{dayEvents.length - 3}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 선택 날짜 상세 */}
          <div className="cal-day-detail">
            <h3 className="cal-detail-h">
              {fmtDateK(selectedDate)} <span className="muted">· {selectedEvents.length}건</span>
            </h3>
            {selectedEvents.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}>
                이 날짜에는 (필터 조건의) 일정이 없어요.
              </div>
            ) : (
              <div className="cal-evlist">
                {selectedEvents.map((e) => (
                  <EventRow key={e.id} e={e} gcal={gcalEventUrl(e)} />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="panel">
          {listGroups.length === 0 ? (
            <div className="empty">예정된 일정이 없어요. 필터를 바꿔보세요.</div>
          ) : (
            listGroups.map((g) => (
              <div key={g.date} className="cal-listgroup">
                <h3 className="cal-detail-h">
                  {fmtDateK(g.date)} {g.date === today && <span className="cal-todaytag">오늘</span>}{" "}
                  <span className="muted">· {g.items.length}건</span>
                </h3>
                <div className="cal-evlist">
                  {g.items.map((e) => (
                    <EventRow key={e.id} e={e} gcal={gcalEventUrl(e)} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 범례 */}
      <div className="panel">
        <div className="cal-legend">
          {Object.entries(KIND_META).map(([k, v]) => (
            <span key={k} className="cal-leg">
              <i className="cal-dot" style={{ background: v.color }} />
              {v.label}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── 보조 컴포넌트 ──────────────────────────────────────────────────────── */
function EventRow({ e, gcal }: { e: Ev; gcal: string }) {
  const meta = KIND_META[kindOf(e)];
  const mcap = mcapLabel(e);
  const kst = e.event_time && e.tz === "GMT" ? gmtToKst(e.event_date, e.event_time) : null;
  return (
    <div className="cal-ev">
      <span className="cal-ev-bar" style={{ background: meta.color }} />
      <div className="cal-ev-time">
        {kst ? (
          <>
            <span className="cal-ev-kst">{kst.time}</span>
            <span className="cal-ev-tz">KST{kst.nextDay ? "+1" : ""}</span>
          </>
        ) : (
          <span className="cal-ev-allday">종일</span>
        )}
      </div>
      <div className="cal-ev-main">
        <div className="cal-ev-title">
          {e.country && <span className="cal-ev-ctry">[{COUNTRY_LABEL[e.country] ?? e.country}]</span>}
          {e.url ? (
            <a href={e.url} target="_blank" rel="noreferrer">
              {e.title}
            </a>
          ) : (
            e.title
          )}
          {e.symbol && <span className="cal-ev-sym">{e.symbol}</span>}
          <span className="cal-ev-kind" style={{ color: meta.color }}>
            {meta.label}
          </span>
          <Imp n={e.importance} />
        </div>
        <div className="cal-ev-sub">
          {e.consensus && (
            <span>
              예상 <b>{e.consensus}</b>
            </span>
          )}
          {e.previous && (
            <span>
              이전 <b>{e.previous}</b>
            </span>
          )}
          {e.actual && (
            <span className="up">
              실제 <b>{e.actual}</b>
            </span>
          )}
          {mcap && <span>시총 {mcap}</span>}
          {e.note && <span className="muted">{e.note}</span>}
        </div>
      </div>
      <a className="cal-ev-add" href={gcal} target="_blank" rel="noreferrer" title="구글 캘린더에 추가">
        + 구글
      </a>
    </div>
  );
}

function Imp({ n }: { n: number }) {
  return (
    <span className="cal-imp" title={`중요도 ${n}/3`}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={"cal-impdot" + (i <= n ? " on" : "")} />
      ))}
    </span>
  );
}

function S({ n, l }: { n: number; l: string }) {
  return (
    <div className="s">
      <div className="n mono">{n.toLocaleString("en-US")}</div>
      <div className="l">{l}</div>
    </div>
  );
}

/* ── 유틸 ───────────────────────────────────────────────────────────────── */
function shorten(s: string, n = 14) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function fmtDateK(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${y}.${pad(m)}.${pad(d)} (${wd})`;
}
