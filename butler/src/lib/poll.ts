import type Database from "better-sqlite3";
import { sendTelegram, formatTargetAlert } from "./telegram";
import { userStore } from "./userstore";

/** 오늘자 일별 스냅샷 기록 (corp_code+date 멱등). */
export function recordDailySnapshot(db: Database.Database, corpCode: string, date: string) {
  db.prepare(
    `INSERT INTO daily_snapshots
       (corp_code, snapshot_date, price, target_price_avg, target_return_rate, cover_securities, per, pbr, source)
     SELECT corp_code, ?, price, target_price_avg, target_return_rate, cover_securities, per, pbr, 'butler'
     FROM companies WHERE corp_code = ?
     ON CONFLICT(corp_code, snapshot_date) DO UPDATE SET
       price=excluded.price, target_price_avg=excluded.target_price_avg,
       target_return_rate=excluded.target_return_rate, cover_securities=excluded.cover_securities,
       per=excluded.per, pbr=excluded.pbr`,
  ).run(date, corpCode);
}

interface ChangeRow {
  id: number;
  corp_code: string;
  name: string;
  broker: string | null;
  old_value: string | null;
  new_value: string | null;
  delta_pct: number | null;
  change_kind: string | null;
  note: string | null;
}

/**
 * 관심목록 보유 유저에게 목표주가 변경 알림을 텔레그램으로 발송.
 * 유저/관심목록/발송이력은 userStore(Firestore/SQLite), 변경·기업은 SQLite.
 * userStore.hasNotification 으로 멱등 보장. sinceIso 이후 변경만 대상.
 */
export async function dispatchAlerts(
  db: Database.Database,
  opts: { sinceIso: string; baseUrl: string },
): Promise<{ sent: number; failed: number }> {
  const targets = await userStore.listAlertTargets();
  if (targets.length === 0) return { sent: 0, failed: 0 };

  const changeStmt = db.prepare(
    `SELECT cl.id, cl.corp_code, c.name, cl.entity_key AS broker, cl.old_value, cl.new_value,
            cl.delta_pct, cl.change_kind, cl.note
     FROM change_logs cl JOIN companies c ON c.corp_code = cl.corp_code
     WHERE cl.entity_type='target_price' AND cl.corp_code = ? AND cl.observed_at >= ?
     ORDER BY cl.id`,
  );

  let sent = 0,
    failed = 0;
  for (const t of targets) {
    for (const corp of t.corpCodes) {
      const rows = changeStmt.all(corp, opts.sinceIso) as ChangeRow[];
      for (const r of rows) {
        if (await userStore.hasNotification(t.userId, r.id)) continue;
        const text = formatTargetAlert({
          companyName: r.name,
          corpCode: r.corp_code,
          broker: r.broker ?? "증권사",
          oldValue: r.old_value,
          newValue: r.new_value,
          deltaPct: r.delta_pct,
          kind: r.change_kind,
          note: r.note,
          baseUrl: opts.baseUrl,
        });
        const ok = await sendTelegram(t.telegramChatId, text);
        await userStore.recordNotification(t.userId, r.id, ok ? "sent" : "failed");
        if (ok) sent++;
        else failed++;
      }
    }
  }
  return { sent, failed };
}
