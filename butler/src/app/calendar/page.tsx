import { getCalendarEvents, getCalendarStats } from "@/lib/repo";
import CalendarView from "./CalendarView";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "경제·실적 캘린더 — keystone",
  description:
    "FOMC·BOJ·한국은행 금리결정, 미국 CPI/PPI/고용, 중국 경기·물가·소비, 해외/국내 실적발표를 한 화면에.",
};

export default async function CalendarPage() {
  const [events, stats] = await Promise.all([getCalendarEvents({}), getCalendarStats()]);
  return <CalendarView events={events} stats={stats} />;
}
