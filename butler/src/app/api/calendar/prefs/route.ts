import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { userStore, type CalendarPrefsData } from "@/lib/userstore";

const user = (req: NextRequest) => getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);

const CATEGORIES = new Set(["macro", "earnings_intl", "earnings_kr"]);
const COUNTRIES = new Set(["US", "CN", "JP", "KR", "EZ"]);
const SUBCATS = new Set(["central_bank", "inflation", "employment", "activity", "other"]);

function sanitize(body: any): CalendarPrefsData {
  const arr = (v: unknown, allow: Set<string>) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && allow.has(x)) : undefined;
  const out: CalendarPrefsData = {};
  const cats = arr(body?.categories, CATEGORIES);
  const ctry = arr(body?.countries, COUNTRIES);
  const subs = arr(body?.subcategories, SUBCATS);
  if (cats) out.categories = cats;
  if (ctry) out.countries = ctry;
  if (subs) out.subcategories = subs;
  const mi = Number(body?.minImportance);
  if (Number.isFinite(mi) && mi >= 1 && mi <= 3) out.minImportance = Math.floor(mi);
  return out;
}

export async function GET(req: NextRequest) {
  const u = await user(req);
  if (!u) return NextResponse.json({ error: "로그인 필요", authed: false }, { status: 401 });
  const rec = await userStore.getCalendarPrefs(u.id);
  return NextResponse.json({
    authed: true,
    prefs: rec?.prefs ?? null,
    feedToken: rec?.feedToken ?? null,
  });
}

export async function PUT(req: NextRequest) {
  const u = await user(req);
  if (!u) return NextResponse.json({ error: "로그인 필요", authed: false }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const prefs = sanitize(body);
  const existing = await userStore.getCalendarPrefs(u.id);
  const feedToken = existing?.feedToken || randomBytes(24).toString("hex"); // 192-bit 불투명 토큰
  await userStore.upsertCalendarPrefs(u.id, prefs, feedToken);
  return NextResponse.json({ authed: true, prefs, feedToken });
}
