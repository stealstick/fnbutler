/**
 * 경제/실적 캘린더 수집 CLI.
 *
 *   tsx scripts/ingest-calendar.ts                 # 기본 (과거 10일 ~ 미래 45일)
 *   tsx scripts/ingest-calendar.ts --back 5 --ahead 60
 *   DART_API_KEY=xxxx tsx scripts/ingest-calendar.ts   # 국내 실적(잠정실적 공시)까지
 *
 * 출처: Nasdaq 경제/실적 캘린더(무인증, 해외 실적 TOP500) + 선택적 DART Open API(국내 실적, 키 필요).
 * 멱등: 윈도우(±N일) 안의 행을 지우고 다시 넣는다(재일정/취소 반영).
 */
import { closeDb, getDb, migrate } from "../src/lib/db";
import { ingestCalendar } from "../src/lib/calendar";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

async function main() {
  const db = getDb();
  await migrate(db);

  const daysBack = Number(arg("back") || "14");
  const daysAhead = Number(arg("ahead") || "80");
  const dartKey = process.env.DART_API_KEY || undefined;

  process.stdout.write(
    `🗓️  캘린더 수집 시작 (과거 ${daysBack}일 ~ 미래 ${daysAhead}일${dartKey ? " · DART 국내실적 포함" : ""})\n`,
  );

  const r = await ingestCalendar(db, {
    daysBack,
    daysAhead,
    dartKey,
    onLog: (m) => process.stdout.write(m + "\n"),
  });

  process.stdout.write(
    `✅ 완료 — 거시 ${r.macro} · 해외실적 ${r.earningsIntl} · 국내실적 ${r.earningsKr} (조회 날짜 ${r.dates}일)\n`,
  );
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
