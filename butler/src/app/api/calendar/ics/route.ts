import { NextRequest } from "next/server";
import { getCalendarEvents } from "@/lib/repo";
import { buildIcs, type CalEvent } from "@/lib/calendar";
import { userStore } from "@/lib/userstore";

export const dynamic = "force-dynamic";

/**
 * iCalendar(.ics) 구독 피드 — Google/Apple 캘린더에서 URL 로 구독하거나 가져온다.
 *
 *   GET /api/calendar/ics                              # 전체
 *   GET /api/calendar/ics?category=macro&country=US,KR  # 쿼리 필터
 *   GET /api/calendar/ics?u=<feedToken>                # 계정 저장 필터(개인 구독)
 *   GET /api/calendar/ics?download=1                    # 첨부파일로 내려받기
 *
 * 구글 캘린더: 다른 캘린더 + → URL로 추가 → 위 URL 붙여넣기 (주기적 자동 동기화).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  let categories = sp.get("category")?.split(",").map((s) => s.trim()).filter(Boolean);
  let countries = sp.get("country")?.split(",").map((s) => s.trim()).filter(Boolean);
  let subcategories: string[] | undefined;
  let minImportance: number | undefined;
  let name = "keystone 경제·실적 캘린더";

  // 개인 구독 토큰이 있으면 계정 저장 필터를 적용(쿼리 필터보다 우선).
  const token = sp.get("u");
  if (token) {
    const rec = await userStore.getCalendarPrefsByToken(token);
    if (rec) {
      const p = rec.prefs || {};
      categories = p.categories?.length ? p.categories : undefined;
      countries = p.countries?.length ? p.countries : undefined;
      subcategories = p.subcategories?.length ? p.subcategories : undefined;
      minImportance = p.minImportance;
      name = "keystone 내 캘린더";
    }
  }

  let events = (await getCalendarEvents({ categories, countries, minImportance })) as unknown as CalEvent[];
  if (subcategories?.length) {
    const set = new Set(subcategories);
    // 소분류 필터는 거시 이벤트에만 적용(실적은 통과).
    events = events.filter((e) => e.category !== "macro" || (e.subcategory != null && set.has(e.subcategory)));
  }

  const ics = buildIcs(events, { name });

  const headers: Record<string, string> = {
    "content-type": "text/calendar; charset=utf-8",
    // 개인 피드(?u=토큰)는 공유 캐시에 남지 않도록 private.
    "cache-control": token ? "private, max-age=900" : "public, max-age=1800",
  };
  if (sp.get("download")) headers["content-disposition"] = 'attachment; filename="keystone-calendar.ics"';

  return new Response(ics, { headers });
}
