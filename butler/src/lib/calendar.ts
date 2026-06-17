/**
 * 경제/실적 캘린더 수집 + ICS 빌더.
 *
 * 데이터 출처 (모두 공개·무인증):
 *  - 거시 일정(FOMC·BOJ·한국은행 금리결정, 미국 CPI/PPI/고용/소매, 중국 경기·물가·소비):
 *      Nasdaq 경제 캘린더  GET api.nasdaq.com/api/calendar/economicevents?date=YYYY-MM-DD
 *      → 국가(country)·지표명(eventName)으로 필터/분류. country ∈ {US,CN,JP,KR}.
 *  - 해외 실적발표(시총 상위):
 *      Nasdaq 실적 캘린더  GET api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
 *      → 윈도우 전체에서 marketCap 상위 N개(기본 100)만 적재 = "해외 TOP100".
 *  - 국내 실적발표(시총 TOP100): 선택적. DART Open API(키 필요)로 잠정실적 공시를 수집.
 *      한국은 실적발표 "예정일"을 공개하는 무료 API가 없어, 키가 있을 때만 실제 공시일을 적재한다.
 *
 * 멱등: 매 수집마다 윈도우(±N일) 안의 해당 source 행을 지우고 다시 넣는다(재일정/취소 반영).
 *       윈도우 밖 과거 이벤트는 이력으로 보존된다.
 */
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";

export type CalCategory = "macro" | "earnings_intl" | "earnings_kr";

export interface CalEvent {
  id: string;
  category: CalCategory;
  subcategory: string | null;
  country: string | null;
  event_date: string; // YYYY-MM-DD
  event_time: string | null; // HH:MM (tz 기준) | null = 종일
  tz: string | null;
  title: string;
  symbol: string | null;
  importance: number; // 1..3
  actual: string | null;
  consensus: string | null;
  previous: string | null;
  market_cap: number | null;
  url: string | null;
  note: string | null;
  source: string;
}

// ---------------------------------------------------------------------------
// 공통 fetch (Nasdaq 은 브라우저 헤더가 없으면 403/봇차단)
// ---------------------------------------------------------------------------
const NASDAQ_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,ko;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  referer: "https://www.nasdaq.com/",
  origin: "https://www.nasdaq.com",
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJson<T = any>(
  url: string,
  headers: Record<string, string>,
  retries = 3,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// 분류 / 정규화 유틸
// ---------------------------------------------------------------------------
const COUNTRY_SLUG: Record<string, string> = {
  "United States": "US",
  China: "CN",
  Japan: "JP",
  "South Korea": "KR",
  "Euro Zone": "EZ",
};
export const COUNTRY_LABEL: Record<string, string> = {
  US: "미국",
  CN: "중국",
  JP: "일본",
  KR: "한국",
  EZ: "유로존",
};
/** 기본 수집 국가 — 미국/중국/일본(BOJ)/한국(한은). */
export const DEFAULT_COUNTRIES = ["US", "CN", "JP", "KR"];

export const SUBCAT_LABEL: Record<string, string> = {
  central_bank: "통화정책",
  inflation: "물가",
  employment: "고용",
  activity: "경기·소비",
  other: "기타",
};

/** 지표명 → (소분류, 중요도). 중요도<2 는 노이즈로 보고 수집 제외. */
function classifyMacro(name: string): { sub: string; importance: number } {
  const n = name.toLowerCase();
  // 금리 발표/통화정책 회의 (FOMC·BOJ·한은·ECB 등)
  if (/interest rate projection/.test(n)) return { sub: "central_bank", importance: 1 }; // 세부 점도표는 제외
  if (
    /interest rate decision|rate decision|fomc|monetary policy|press conference|rate statement|policy meeting|economic projections|rate announcement/.test(
      n,
    )
  )
    return { sub: "central_bank", importance: 3 };
  // 물가
  if (/\bcpi\b|\bppi\b|inflation|\bpce\b|price index|deflator/.test(n))
    return { sub: "inflation", importance: 3 };
  // 고용
  if (/unemploy|nonfarm|non-farm|payroll|jobless|employment|initial claims|continuing claims|jobs\b/.test(n))
    return { sub: "employment", importance: 3 };
  // 경기·소비 (GDP/생산/소매/PMI/ISM/무역/심리/소비 등)
  if (
    /\bgdp\b|industrial production|retail sales|durable goods|\bpmi\b|\bism\b|manufacturing|trade balance|consumer confidence|consumer sentiment|business|housing|factory|fixed asset|new loans|money supply|current account|capacity|leading index|caixin/.test(
      n,
    )
  )
    return { sub: "activity", importance: 2 };
  return { sub: "other", importance: 1 };
}

/** HTML 엔티티/공백 정리. 빈 값은 null. */
function txt(v: unknown): string | null {
  if (v == null) return null;
  let s = String(v)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return s === "" || s === "-" ? null : s;
}

/** 'HH:MM' 형태만 시각으로 인정 (All Day/Tentative/공백 → null=종일). */
function parseTime(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = Math.min(23, Number(m[1]));
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** '$109,987,887,734' → 109987887734 */
function parseMcap(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mcTier(mcUsd: number): number {
  if (mcUsd >= 200e9) return 3;
  if (mcUsd >= 50e9) return 2;
  return 1;
}

/** 'time-pre-market' → '장전' 등. */
function earningsTimeLabel(t: unknown): string | null {
  const s = String(t ?? "");
  if (s.includes("pre-market")) return "장전";
  if (s.includes("after-hours")) return "장마감 후";
  return null;
}

function makeId(parts: Array<string | null | undefined>): string {
  return createHash("sha1").update(parts.map((p) => p ?? "").join("|")).digest("hex").slice(0, 20);
}

/**
 * 한국은행 통화정책방향 결정회의(기준금리 결정) 일정 — 큐레이션.
 *
 * Nasdaq 경제 캘린더는 FOMC·BoJ 는 주지만 한국은행(BOK) 금리결정은 제공하지 않는다.
 * 금통위는 연 8회·1년 전에 공식 공시되는 작고 안정적인 일정이라, 취약한 스크래핑 대신
 * 공식 공시(아래 출처)를 연 1회 갱신하는 큐레이션 시드로 둔다.
 *   출처: 한국은행 통화정책방향 결정회의 일정
 *         https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755
 *  ⚠️ 매년 10~11월 발표되는 차년도 일정으로 이 배열을 갱신할 것.
 */
const BOK_RATE_DECISIONS: string[] = [
  // 2026 (한국은행 2025-10-30 발표)
  "2026-01-15",
  "2026-02-26",
  "2026-04-10",
  "2026-05-28",
  "2026-07-16",
  "2026-08-27",
  "2026-10-22",
  "2026-11-26",
];

const BOK_URL = "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755";

function curatedKrCentralBank(minDate: string, maxDate: string): CalEvent[] {
  return BOK_RATE_DECISIONS.filter((d) => d >= minDate && d <= maxDate).map((d) => ({
    id: makeId(["macro", "KR", d, "BoK Interest Rate Decision"]),
    category: "macro",
    subcategory: "central_bank",
    country: "KR",
    event_date: d,
    event_time: null,
    tz: null,
    title: "한국은행 기준금리 결정 (금통위)",
    symbol: null,
    importance: 3,
    actual: null,
    consensus: null,
    previous: null,
    market_cap: null,
    url: BOK_URL,
    note: "통화정책방향 결정회의",
    source: "bok",
  }));
}

/** today(local) 기준 [-daysBack, +daysAhead] 의 평일 날짜 목록. */
function dateRange(daysBack: number, daysAhead: number): string[] {
  const out: string[] = [];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  for (let i = -daysBack; i <= daysAhead; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // 주말 제외(지표/실적은 평일)
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 업스트림 호출
// ---------------------------------------------------------------------------
/**
 * null = fetch 실패(HTTP !ok / 429·5xx 소진). 빈 배열 [] = 정상 응답이나 이벤트 없음(휴일 등,
 * Nasdaq 은 이때 data:null 반환). 호출자는 null 일 때 해당 날짜의 파괴적 재적재를 건너뛴다.
 */
async function nasdaqEconomic(date: string): Promise<any[] | null> {
  let j: any;
  try {
    j = await fetchJson(`https://api.nasdaq.com/api/calendar/economicevents?date=${date}`, NASDAQ_HEADERS);
  } catch {
    return null;
  }
  if (j === null) return null;
  return (j?.data?.rows as any[]) ?? [];
}

async function nasdaqEarnings(date: string): Promise<any[] | null> {
  let j: any;
  try {
    j = await fetchJson(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, NASDAQ_HEADERS);
  } catch {
    return null;
  }
  if (j === null) return null;
  return (j?.data?.rows as any[]) ?? [];
}

// ---------------------------------------------------------------------------
// 적재
// ---------------------------------------------------------------------------
const UPSERT_SQL = `
INSERT OR REPLACE INTO calendar_events
 (id, category, subcategory, country, event_date, event_time, tz, title, symbol,
  importance, actual, consensus, previous, market_cap, url, note, source, updated_at)
VALUES
 (@id, @category, @subcategory, @country, @event_date, @event_time, @tz, @title, @symbol,
  @importance, @actual, @consensus, @previous, @market_cap, @url, @note, @source, @updated_at)
`;

export interface IngestOpts {
  daysBack?: number;
  daysAhead?: number;
  countries?: string[];
  topEarnings?: number;
  dartKey?: string;
  onLog?: (msg: string) => void;
}

export interface IngestResult {
  dates: number;
  macro: number;
  earningsIntl: number;
  earningsKr: number;
}

export async function ingestCalendar(db: Database, opts: IngestOpts = {}): Promise<IngestResult> {
  const {
    daysBack = 10,
    daysAhead = 45,
    countries = DEFAULT_COUNTRIES,
    topEarnings = 100,
    dartKey,
    onLog = () => {},
  } = opts;
  const dates = dateRange(daysBack, daysAhead);
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const now = new Date().toISOString();
  const events: CalEvent[] = [];
  // 출처 건강도 — fetch 실패(null)가 하나라도 있으면 파괴적 윈도우 삭제를 건너뛰고
  // 받은 것만 비파괴 UPSERT 한다(부분 실패 시 기존 데이터 보존).
  let nasdaqFailures = 0;

  // 1) 거시 일정 -----------------------------------------------------------
  for (const d of dates) {
    const rows = await nasdaqEconomic(d);
    if (rows === null) {
      nasdaqFailures++;
      onLog(`  ⚠️ econ ${d}: fetch 실패`);
      await sleep(120);
      continue;
    }
    for (const r of rows) {
      const slug = COUNTRY_SLUG[String(r.country ?? "").trim()];
      if (!slug || !countries.includes(slug)) continue;
      const name = txt(r.eventName);
      if (!name) continue;
      const { sub, importance } = classifyMacro(name);
      // 유의미한 지표는 모두 저장(화면/계정에서 필터). 세부 점도표(개별 projection dots)만 제외.
      if (sub === "central_bank" && importance === 1) continue;
      events.push({
        id: makeId(["macro", slug, d, name]),
        category: "macro",
        subcategory: sub,
        country: slug,
        event_date: d,
        event_time: parseTime(r.gmt),
        tz: "GMT",
        title: name,
        symbol: null,
        importance,
        actual: txt(r.actual),
        consensus: txt(r.consensus),
        previous: txt(r.previous),
        market_cap: null,
        url: null,
        note: null,
        source: "nasdaq",
      });
    }
    await sleep(120);
  }
  // 한국은행 금리결정(큐레이션) — Nasdaq 미제공분 보강
  if (countries.includes("KR")) {
    const bok = curatedKrCentralBank(minDate, maxDate);
    events.push(...bok);
    if (bok.length) onLog(`  한국은행 금리결정(큐레이션) ${bok.length}건`);
  }
  onLog(`  거시 일정 ${events.length}건`);

  // 2) 해외 실적 (윈도우 전체에서 시총 상위 topEarnings) ---------------------
  const earn: Array<{ date: string; row: any; mc: number }> = [];
  for (const d of dates) {
    const rows = await nasdaqEarnings(d);
    if (rows === null) {
      nasdaqFailures++;
      onLog(`  ⚠️ earnings ${d}: fetch 실패`);
      await sleep(120);
      continue;
    }
    for (const r of rows) {
      const mc = parseMcap(r.marketCap);
      if (!mc) continue;
      earn.push({ date: d, row: r, mc });
    }
    await sleep(120);
  }
  earn.sort((a, b) => b.mc - a.mc);
  const top = earn.slice(0, topEarnings);
  for (const e of top) {
    const sym = txt(e.row.symbol);
    const name = txt(e.row.name) ?? sym ?? "(unknown)";
    const tlabel = earningsTimeLabel(e.row.time);
    const fq = txt(e.row.fiscalQuarterEnding);
    const noteParts = [tlabel, fq ? `${fq} 분기` : null].filter(Boolean);
    events.push({
      id: makeId(["earnings_intl", e.date, sym, name]),
      category: "earnings_intl",
      subcategory: null,
      country: null,
      event_date: e.date,
      event_time: null,
      tz: null,
      title: name,
      symbol: sym,
      importance: mcTier(e.mc),
      actual: null,
      consensus: txt(e.row.epsForecast),
      previous: txt(e.row.lastYearEPS),
      market_cap: e.mc,
      url: sym ? `https://www.nasdaq.com/market-activity/stocks/${sym.toLowerCase()}` : null,
      note: noteParts.join(" · ") || null,
      source: "nasdaq",
    });
  }
  onLog(`  해외 실적 상위 ${top.length}건`);

  // 3) 국내 실적 (선택: DART 키 있을 때만 실제 잠정실적 공시 수집) -------------
  let krEvents: CalEvent[] = [];
  let dartOk = false;
  if (dartKey) {
    try {
      krEvents = await collectDartEarnings(db, dartKey, minDate, maxDate, onLog);
      events.push(...krEvents);
      dartOk = true;
      onLog(`  국내 실적(DART) ${krEvents.length}건`);
    } catch (e) {
      onLog(`  ⚠️ DART 수집 실패: ${(e as Error).message}`);
    }
  } else {
    onLog("  국내 실적: DART_API_KEY 미설정 → 건너뜀");
  }

  // 4) 멱등 적재 — 윈도우 내 행 삭제 후 일괄 삽입.
  //    ⚠️ 데이터 손실 방지: fetch 실패가 있으면(부분 차단/네트워크) 파괴적 삭제를 건너뛰고
  //    받은 것만 비파괴 UPSERT 한다(기존 데이터 보존). 완전 성공 시에만 재일정/취소분을 prune.
  const nasdaqHealthy = nasdaqFailures === 0;
  if (!nasdaqHealthy)
    onLog(`  ⚠️ Nasdaq fetch 실패 ${nasdaqFailures}건 — 파괴적 삭제 생략(기존 데이터 보존, 받은 분만 갱신)`);

  const nasdaqEvents = events.filter((e) => e.source === "nasdaq");
  const bokEvents = events.filter((e) => e.source === "bok");
  const dartEvents = events.filter((e) => e.source === "dart");
  const del = (sources: string) =>
    db
      .prepare(`DELETE FROM calendar_events WHERE source = ? AND event_date BETWEEN ? AND ?`)
      .run(sources, minDate, maxDate);

  const insert = db.prepare(UPSERT_SQL);
  const tx = db.transaction(() => {
    if (nasdaqHealthy) del("nasdaq"); // 완전 성공 시에만 prune
    for (const ev of nasdaqEvents) insert.run({ ...ev, updated_at: now });
    // 한국은행: 결정적 큐레이션 → 항상 안전하게 재적재
    del("bok");
    for (const ev of bokEvents) insert.run({ ...ev, updated_at: now });
    // DART: 성공했을 때만 prune (실패 시 기존 국내실적 보존)
    if (dartOk) {
      del("dart");
      for (const ev of dartEvents) insert.run({ ...ev, updated_at: now });
    }
  });
  tx();

  return {
    dates: dates.length,
    macro: events.filter((e) => e.category === "macro").length,
    earningsIntl: top.length,
    earningsKr: krEvents.length,
  };
}

// ---------------------------------------------------------------------------
// DART 국내 잠정실적 공시 (선택) — corp_code 는 butler 와 동일한 DART 8자리.
// ---------------------------------------------------------------------------
async function collectDartEarnings(
  db: Database,
  key: string,
  minDate: string,
  maxDate: string,
  onLog: (m: string) => void,
): Promise<CalEvent[]> {
  const top = db
    .prepare(
      `SELECT corp_code, name, stock_code, market_cap
       FROM companies WHERE market_cap IS NOT NULL
       ORDER BY market_cap DESC LIMIT 100`,
    )
    .all() as Array<{ corp_code: string; name: string; stock_code: string; market_cap: number }>;
  const byCode = new Map(top.map((c) => [c.corp_code, c]));
  const bgn = minDate.replace(/-/g, "");
  const end = maxDate.replace(/-/g, "");
  const out: CalEvent[] = [];
  const seen = new Set<string>();

  let page = 1;
  for (;;) {
    const url =
      `https://opendart.fss.or.kr/api/list.json?crtfc_key=${key}` +
      `&bgn_de=${bgn}&end_de=${end}&pblntf_ty=I&page_no=${page}&page_count=100`;
    const j = await fetchJson<any>(url, { accept: "application/json" });
    if (!j || j.status !== "000") {
      if (j && j.status !== "013") onLog(`  ⚠️ DART status=${j.status} ${j.message ?? ""}`);
      break;
    }
    const list: any[] = j.list ?? [];
    for (const it of list) {
      if (!/잠정실적|영업\(잠정\)실적|매출액또는손익구조/.test(String(it.report_nm))) continue;
      const co = byCode.get(it.corp_code);
      if (!co) continue;
      const rcept = String(it.rcept_dt);
      if (rcept.length !== 8) continue;
      const date = `${rcept.slice(0, 4)}-${rcept.slice(4, 6)}-${rcept.slice(6, 8)}`;
      const id = makeId(["earnings_kr", date, co.stock_code, it.report_nm]);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        category: "earnings_kr",
        subcategory: null,
        country: "KR",
        event_date: date,
        event_time: null,
        tz: null,
        title: co.name,
        symbol: co.stock_code,
        importance: 2,
        actual: null,
        consensus: null,
        previous: null,
        market_cap: co.market_cap,
        url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${it.rcept_no}`,
        note: txt(it.report_nm),
        source: "dart",
      });
    }
    if (list.length < 100 || page >= (j.total_page ?? 1)) break;
    page++;
    await sleep(200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ICS (iCalendar) 빌더 — Google/Apple 캘린더 구독·가져오기용.
// ---------------------------------------------------------------------------
function icsEscape(s: string): string {
  // CRLF 모두 처리(CR 누락 시 ICS 필드 인젝션 여지) — \r\n 을 먼저 단일 \n 으로.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}
/** RFC5545 75옥텟 폴딩(보수적으로 73자 기준). */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const chunks: string[] = [];
  let s = line;
  chunks.push(s.slice(0, 73));
  s = s.slice(73);
  while (s.length) {
    chunks.push(" " + s.slice(0, 72));
    s = s.slice(72);
  }
  return chunks.join("\r\n");
}
function ymd(date: string): string {
  return date.replace(/-/g, "");
}
function addDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const CAT_PREFIX: Record<string, string> = {
  macro: "📊",
  earnings_intl: "🌐",
  earnings_kr: "🇰🇷",
};

/** 이벤트 목록 → ICS 문자열. dtstamp 는 ISO(미지정 시 현재). */
export function buildIcs(
  events: CalEvent[],
  opts: { name?: string; dtstamp?: string } = {},
): string {
  const name = opts.name ?? "butler.view 경제·실적 캘린더";
  const stamp = (opts.dtstamp ?? new Date().toISOString()).replace(/[-:]/g, "").replace(/\.\d+/, "").replace(/(\d{8}T\d{6}).*/, "$1Z");
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//butler.view//economic calendar//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(name)}`,
    "X-WR-TIMEZONE:Asia/Seoul",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const ev of events) {
    const prefix = CAT_PREFIX[ev.category] ?? "";
    const ctry = ev.country ? `[${COUNTRY_LABEL[ev.country] ?? ev.country}] ` : "";
    const sym = ev.symbol ? ` (${ev.symbol})` : "";
    const summary = `${prefix} ${ctry}${ev.title}${sym}`.trim();

    const descParts: string[] = [];
    if (ev.consensus) descParts.push(`예상 ${ev.consensus}`);
    if (ev.previous) descParts.push(`이전 ${ev.previous}`);
    if (ev.actual) descParts.push(`실제 ${ev.actual}`);
    if (ev.note) descParts.push(ev.note);
    if (ev.event_time && ev.tz) descParts.push(`발표 ${ev.event_time} ${ev.tz}`);
    if (ev.url) descParts.push(ev.url);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.id}@butler.view`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.event_time && ev.tz === "GMT") {
      // 거시 지표: GMT 시각 → UTC 타임드 이벤트(1시간)
      const [h, mi] = ev.event_time.split(":");
      const start = `${ymd(ev.event_date)}T${h}${mi}00Z`;
      const endDt = new Date(
        Date.UTC(
          Number(ev.event_date.slice(0, 4)),
          Number(ev.event_date.slice(5, 7)) - 1,
          Number(ev.event_date.slice(8, 10)),
          Number(h),
          Number(mi),
        ) + 3600_000,
      );
      const end = `${endDt.getUTCFullYear()}${String(endDt.getUTCMonth() + 1).padStart(2, "0")}${String(endDt.getUTCDate()).padStart(2, "0")}T${String(endDt.getUTCHours()).padStart(2, "0")}${String(endDt.getUTCMinutes()).padStart(2, "0")}00Z`;
      lines.push(`DTSTART:${start}`);
      lines.push(`DTEND:${end}`);
    } else {
      // 실적/시각미상: 종일 이벤트
      lines.push(`DTSTART;VALUE=DATE:${ymd(ev.event_date)}`);
      lines.push(`DTEND;VALUE=DATE:${addDay(ev.event_date)}`);
    }
    lines.push(fold(`SUMMARY:${icsEscape(summary)}`));
    if (descParts.length) lines.push(fold(`DESCRIPTION:${icsEscape(descParts.join(" · "))}`));
    if (ev.url) lines.push(fold(`URL:${icsEscape(ev.url)}`));
    lines.push(`CATEGORIES:${ev.category}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
