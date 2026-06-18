/**
 * 유저 데이터 저장소 (회원·세션·관심목록·알림).
 *
 * 시세/컨센서스 데이터는 배포마다 GCS에서 다시 구워지므로 유실이 없지만,
 * 라이브에서 생기는 유저 데이터는 영속 저장이 필요하다.
 *  - prod(Cloud Run): Firestore  (BUTLER_USERSTORE=firestore) — 배포해도 유지, 사실상 무료.
 *  - local dev: Postgres (기본)  — GCP 인증 없이 로컬 DB 로 개발 가능.
 *
 * 모든 함수는 async. user.id 는 불투명 문자열.
 *   Postgres: BIGSERIAL id 문자열.  Firestore: 정규화 이메일.
 */
import { Firestore } from "@google-cloud/firestore";
import { all, one, query, tx, nowIso } from "./db";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  telegramChatId: string | null;
  alertsEnabled: boolean;
}

export interface AlertTarget {
  userId: string;
  telegramChatId: string;
  corpCodes: string[];
}

/** 계정별 캘린더 필터. */
export interface CalendarPrefsData {
  categories?: string[]; // macro / earnings_intl / earnings_kr
  countries?: string[]; // US/CN/JP/KR
  subcategories?: string[]; // central_bank/inflation/employment/activity/other
  minImportance?: number; // 1..3
}
export interface CalendarPrefsRecord {
  userId: string;
  prefs: CalendarPrefsData;
  feedToken: string | null;
}

/**
 * 경제·실적 캘린더 이벤트 — 런타임에 자주 갱신되고 재배포 없이 반영돼야 하므로
 * 시세/컨센서스 Postgres와 별도로, prod에서는 유저 데이터와 같은 Firestore 계층에 둔다.
 * 수집 윈도우(±N일)가 사실상 전부라 매 수집 = 전량 교체(putAll). 로컬 dev 는 Postgres 폴백.
 */
export interface CalendarEventRecord {
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

const useFirestore = process.env.BUTLER_USERSTORE === "firestore";

/* ============================ Firestore 백엔드 ============================ */
let _fs: Firestore | null = null;
function fs(): Firestore {
  if (!_fs) _fs = new Firestore({ databaseId: process.env.BUTLER_FIRESTORE_DB || "(default)" });
  return _fs;
}
const norm = (email: string) => email.toLowerCase().trim();
const watchId = (uid: string, corp: string) => `${uid}|${corp}`;
const notifId = (uid: string, changeId: number) => `${uid}|${changeId}`;

const firestoreBackend = {
  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const doc = await fs().collection("users").doc(norm(email)).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return {
      id: doc.id,
      email: doc.id,
      passwordHash: d.passwordHash,
      telegramChatId: d.telegramChatId ?? null,
      alertsEnabled: d.alertsEnabled !== false,
    };
  },
  async getUserById(id: string) {
    return this.getUserByEmail(id);
  },
  async createUser(email: string, passwordHash: string): Promise<StoredUser> {
    const ref = fs().collection("users").doc(norm(email));
    await fs().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) throw new Error("UNIQUE email");
      tx.set(ref, { passwordHash, telegramChatId: null, alertsEnabled: true, createdAt: nowIso() });
    });
    return { id: ref.id, email: ref.id, passwordHash, telegramChatId: null, alertsEnabled: true };
  },
  async updateUserTelegram(id: string, p: { telegramChatId?: string | null; alertsEnabled?: boolean }) {
    const patch: Record<string, unknown> = {};
    if (p.telegramChatId !== undefined) patch.telegramChatId = p.telegramChatId || null;
    if (p.alertsEnabled !== undefined) patch.alertsEnabled = p.alertsEnabled;
    await fs().collection("users").doc(id).set(patch, { merge: true });
  },
  async createSession(token: string, userId: string, expiresAt: string) {
    await fs().collection("sessions").doc(token).set({ userId, expiresAt, createdAt: nowIso() });
  },
  async getSession(token: string) {
    const doc = await fs().collection("sessions").doc(token).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return { userId: d.userId as string, expiresAt: d.expiresAt as string };
  },
  async deleteSession(token: string) {
    await fs().collection("sessions").doc(token).delete();
  },
  async addWatch(userId: string, corpCode: string) {
    await fs()
      .collection("watchlist")
      .doc(watchId(userId, corpCode))
      .set({ userId, corpCode, createdAt: nowIso() });
  },
  async removeWatch(userId: string, corpCode: string) {
    await fs().collection("watchlist").doc(watchId(userId, corpCode)).delete();
  },
  async isWatched(userId: string, corpCode: string) {
    return (await fs().collection("watchlist").doc(watchId(userId, corpCode)).get()).exists;
  },
  async listWatchCorpCodes(userId: string): Promise<string[]> {
    const snap = await fs().collection("watchlist").where("userId", "==", userId).get();
    return snap.docs.map((d) => d.data().corpCode as string);
  },
  async listAlertTargets(): Promise<AlertTarget[]> {
    const users = await fs().collection("users").where("alertsEnabled", "==", true).get();
    const out: AlertTarget[] = [];
    for (const u of users.docs) {
      const chat = u.data().telegramChatId;
      if (!chat) continue;
      out.push({ userId: u.id, telegramChatId: chat, corpCodes: await this.listWatchCorpCodes(u.id) });
    }
    return out;
  },
  async hasNotification(userId: string, changeId: number) {
    return (await fs().collection("notifications").doc(notifId(userId, changeId)).get()).exists;
  },
  async recordNotification(userId: string, changeId: number, status: string) {
    await fs()
      .collection("notifications")
      .doc(notifId(userId, changeId))
      .set({ userId, changeId, status, sentAt: nowIso() });
  },
  async createLinkToken(token: string, userId: string, expiresAt: string) {
    await fs().collection("tg_link_tokens").doc(token).set({ userId, expiresAt, createdAt: nowIso() });
  },
  // 일회성: 존재하면 즉시 삭제하고, 만료 전이면 userId 반환(아니면 null).
  async consumeLinkToken(token: string): Promise<string | null> {
    const ref = fs().collection("tg_link_tokens").doc(token);
    return fs().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = snap.data()!;
      tx.delete(ref);
      return new Date(d.expiresAt) < new Date() ? null : (d.userId as string);
    });
  },
  async getCalendarPrefs(userId: string): Promise<CalendarPrefsRecord | null> {
    const doc = await fs().collection("calendar_prefs").doc(userId).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return { userId, prefs: (d.prefs as CalendarPrefsData) ?? {}, feedToken: d.feedToken ?? null };
  },
  async upsertCalendarPrefs(userId: string, prefs: CalendarPrefsData, feedToken: string): Promise<void> {
    await fs()
      .collection("calendar_prefs")
      .doc(userId)
      .set({ prefs, feedToken, updatedAt: nowIso() }, { merge: true });
  },
  async getCalendarPrefsByToken(token: string): Promise<CalendarPrefsRecord | null> {
    const snap = await fs().collection("calendar_prefs").where("feedToken", "==", token).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const d = doc.data();
    return { userId: doc.id, prefs: (d.prefs as CalendarPrefsData) ?? {}, feedToken: d.feedToken ?? null };
  },
  // 캘린더 이벤트는 단일 문서(calendar/events)에 배열로 보관 — 1 read/write 로 저렴.
  async getAllCalendarEvents(): Promise<CalendarEventRecord[]> {
    const doc = await fs().collection("calendar").doc("events").get();
    if (!doc.exists) return [];
    return (doc.data()!.events as CalendarEventRecord[]) ?? [];
  },
  async putAllCalendarEvents(events: CalendarEventRecord[]): Promise<void> {
    await fs().collection("calendar").doc("events").set({ events, updatedAt: nowIso() });
  },
};

/* ============================== Postgres 백엔드 ============================== */
const postgresBackend = {
  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const r = await one<any>(
      "SELECT id, email, password_hash, telegram_chat_id, alerts_enabled FROM users WHERE email = $1",
      [norm(email)],
    );
    return r
      ? {
          id: String(r.id),
          email: r.email,
          passwordHash: r.password_hash,
          telegramChatId: r.telegram_chat_id,
          alertsEnabled: r.alerts_enabled === 1,
        }
      : null;
  },
  async getUserById(id: string): Promise<StoredUser | null> {
    const r = await one<any>(
      "SELECT id, email, password_hash, telegram_chat_id, alerts_enabled FROM users WHERE id = $1",
      [Number(id)],
    );
    return r
      ? {
          id: String(r.id),
          email: r.email,
          passwordHash: r.password_hash,
          telegramChatId: r.telegram_chat_id,
          alertsEnabled: r.alerts_enabled === 1,
        }
      : null;
  },
  async createUser(email: string, passwordHash: string): Promise<StoredUser> {
    const info = await one<{ id: string }>(
      "INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id",
      [norm(email), passwordHash, nowIso()],
    );
    return {
      id: String(info?.id),
      email: norm(email),
      passwordHash,
      telegramChatId: null,
      alertsEnabled: true,
    };
  },
  async updateUserTelegram(id: string, p: { telegramChatId?: string | null; alertsEnabled?: boolean }) {
    if (p.telegramChatId !== undefined)
      await query("UPDATE users SET telegram_chat_id = $1 WHERE id = $2", [p.telegramChatId || null, Number(id)]);
    if (p.alertsEnabled !== undefined)
      await query("UPDATE users SET alerts_enabled = $1 WHERE id = $2", [p.alertsEnabled ? 1 : 0, Number(id)]);
  },
  async createSession(token: string, userId: string, expiresAt: string) {
    await query("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
      token,
      Number(userId),
      nowIso(),
      expiresAt,
    ]);
  },
  async getSession(token: string) {
    const r = await one<any>("SELECT user_id, expires_at FROM sessions WHERE token = $1", [token]);
    return r ? { userId: String(r.user_id), expiresAt: r.expires_at as string } : null;
  },
  async deleteSession(token: string) {
    await query("DELETE FROM sessions WHERE token = $1", [token]);
  },
  async addWatch(userId: string, corpCode: string) {
    await query(
      "INSERT INTO watchlist (user_id, corp_code, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [Number(userId), corpCode, nowIso()],
    );
  },
  async removeWatch(userId: string, corpCode: string) {
    await query("DELETE FROM watchlist WHERE user_id = $1 AND corp_code = $2", [Number(userId), corpCode]);
  },
  async isWatched(userId: string, corpCode: string) {
    return !!(await one("SELECT 1 FROM watchlist WHERE user_id = $1 AND corp_code = $2", [
      Number(userId),
      corpCode,
    ]));
  },
  async listWatchCorpCodes(userId: string): Promise<string[]> {
    return (await all<any>("SELECT corp_code FROM watchlist WHERE user_id = $1", [Number(userId)])).map(
      (r) => r.corp_code,
    );
  },
  async listAlertTargets(): Promise<AlertTarget[]> {
    const users = await all<any>(
      "SELECT id, telegram_chat_id FROM users WHERE alerts_enabled = 1 AND telegram_chat_id IS NOT NULL",
    );
    const out: AlertTarget[] = [];
    for (const u of users) {
      out.push({
        userId: String(u.id),
        telegramChatId: u.telegram_chat_id,
        corpCodes: (await all<any>("SELECT corp_code FROM watchlist WHERE user_id = $1", [u.id])).map(
          (r) => r.corp_code,
        ),
      });
    }
    return out;
  },
  async hasNotification(userId: string, changeId: number) {
    return !!(await one("SELECT 1 FROM notifications WHERE user_id = $1 AND change_log_id = $2", [
      Number(userId),
      changeId,
    ]));
  },
  async recordNotification(userId: string, changeId: number, status: string) {
    await query(
      "INSERT INTO notifications (user_id, change_log_id, channel, status, sent_at) VALUES ($1, $2, 'telegram', $3, $4) ON CONFLICT DO NOTHING",
      [Number(userId), changeId, status, nowIso()],
    );
  },
  async createLinkToken(token: string, userId: string, expiresAt: string) {
    await query("INSERT INTO telegram_link_tokens (token, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", [
      token,
      Number(userId),
      expiresAt,
      nowIso(),
    ]);
  },
  async consumeLinkToken(token: string): Promise<string | null> {
    return tx(async (db) => {
      const r = await one<any>("SELECT user_id, expires_at FROM telegram_link_tokens WHERE token = $1", [token], db);
      if (!r) return null;
      await query("DELETE FROM telegram_link_tokens WHERE token = $1", [token], db);
      return new Date(r.expires_at) < new Date() ? null : String(r.user_id);
    });
  },
  async getCalendarPrefs(userId: string): Promise<CalendarPrefsRecord | null> {
    const r = await one<any>("SELECT prefs_json, feed_token FROM calendar_prefs WHERE user_id = $1", [String(userId)]);
    return r
      ? { userId: String(userId), prefs: JSON.parse(r.prefs_json || "{}"), feedToken: r.feed_token }
      : null;
  },
  async upsertCalendarPrefs(userId: string, prefs: CalendarPrefsData, feedToken: string): Promise<void> {
    await query(
      "INSERT INTO calendar_prefs (user_id, prefs_json, feed_token, updated_at) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json, " +
        "feed_token = excluded.feed_token, updated_at = excluded.updated_at",
      [String(userId), JSON.stringify(prefs), feedToken, nowIso()],
    );
  },
  async getCalendarPrefsByToken(token: string): Promise<CalendarPrefsRecord | null> {
    const r = await one<any>("SELECT user_id, prefs_json, feed_token FROM calendar_prefs WHERE feed_token = $1", [
      token,
    ]);
    return r
      ? { userId: String(r.user_id), prefs: JSON.parse(r.prefs_json || "{}"), feedToken: r.feed_token }
      : null;
  },
  // 로컬 dev 폴백: calendar_events 테이블에 전량 교체.
  async getAllCalendarEvents(): Promise<CalendarEventRecord[]> {
    return all<CalendarEventRecord>(
      `SELECT id, category, subcategory, country, event_date, event_time, tz, title, symbol,
              importance, actual, consensus, previous, market_cap, url, note, source
       FROM calendar_events`,
    );
  },
  async putAllCalendarEvents(events: CalendarEventRecord[]): Promise<void> {
    const now = nowIso();
    await tx(async (db) => {
      await query("DELETE FROM calendar_events", [], db);
      for (const e of events) {
        await query(
          `INSERT INTO calendar_events
             (id, category, subcategory, country, event_date, event_time, tz, title, symbol,
              importance, actual, consensus, previous, market_cap, url, note, source, updated_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT(id) DO UPDATE SET
             category=excluded.category, subcategory=excluded.subcategory, country=excluded.country,
             event_date=excluded.event_date, event_time=excluded.event_time, tz=excluded.tz,
             title=excluded.title, symbol=excluded.symbol, importance=excluded.importance,
             actual=excluded.actual, consensus=excluded.consensus, previous=excluded.previous,
             market_cap=excluded.market_cap, url=excluded.url, note=excluded.note,
             source=excluded.source, updated_at=excluded.updated_at`,
          [
            e.id,
            e.category,
            e.subcategory,
            e.country,
            e.event_date,
            e.event_time,
            e.tz,
            e.title,
            e.symbol,
            e.importance,
            e.actual,
            e.consensus,
            e.previous,
            e.market_cap,
            e.url,
            e.note,
            e.source,
            now,
          ],
          db,
        );
      }
    });
  },
};

export const userStore = useFirestore ? firestoreBackend : postgresBackend;
export const userStoreKind = useFirestore ? "firestore" : "postgres";
