import type Database from "better-sqlite3";
import { sendTelegram, formatTargetAlert } from "./telegram";

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

interface AlertRow {
  id: number;
  corp_code: string;
  name: string;
  broker: string | null;
  old_value: string | null;
  new_value: string | null;
  delta_pct: number | null;
  change_kind: string | null;
  note: string | null;
  user_id: number;
  telegram_chat_id: string;
}

/**
 * 관심목록 보유 유저에게 목표주가 변경 알림을 텔레그램으로 발송.
 * notifications 테이블로 멱등 보장(같은 변경×유저 1회). sinceIso 이후 변경만 대상.
 */
export async function dispatchAlerts(
  db: Database.Database,
  opts: { sinceIso: string; baseUrl: string },
): Promise<{ sent: number; failed: number }> {
  const rows = db
    .prepare(
      `SELECT cl.id, cl.corp_code, c.name, cl.entity_key AS broker, cl.old_value, cl.new_value,
              cl.delta_pct, cl.change_kind, cl.note, w.user_id, u.telegram_chat_id
       FROM change_logs cl
       JOIN companies c  ON c.corp_code = cl.corp_code
       JOIN watchlist w  ON w.corp_code = cl.corp_code
       JOIN users u      ON u.id = w.user_id
       WHERE cl.entity_type = 'target_price'
         AND cl.observed_at >= @since
         AND u.telegram_chat_id IS NOT NULL AND u.alerts_enabled = 1
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = w.user_id AND n.change_log_id = cl.id AND n.channel='telegram')
       ORDER BY cl.id`,
    )
    .all({ since: opts.sinceIso }) as AlertRow[];

  let sent = 0,
    failed = 0;
  const record = db.prepare(
    `INSERT INTO notifications (user_id, change_log_id, channel, status, sent_at)
     VALUES (?, ?, 'telegram', ?, ?) ON CONFLICT DO NOTHING`,
  );

  for (const r of rows) {
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
    const ok = await sendTelegram(r.telegram_chat_id, text);
    record.run(r.user_id, r.id, ok ? "sent" : "failed", new Date().toISOString());
    if (ok) sent++;
    else failed++;
  }
  return { sent, failed };
}
