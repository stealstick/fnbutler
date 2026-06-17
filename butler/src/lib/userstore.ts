/**
 * 유저 데이터 저장소 (회원·세션·관심목록·알림).
 *
 * 시세/컨센서스 데이터는 배포마다 GCS에서 다시 구워지므로 유실이 없지만,
 * 라이브에서 생기는 유저 데이터는 영속 저장이 필요하다.
 *  - prod(Cloud Run): Firestore  (BUTLER_USERSTORE=firestore) — 배포해도 유지, 사실상 무료.
 *  - local dev: SQLite (기본)    — GCP 인증 없이 오프라인 개발 가능.
 *
 * 모든 함수는 async (Firestore가 비동기). user.id 는 불투명 문자열.
 *   SQLite: 정수 rowid 의 문자열.  Firestore: 정규화 이메일.
 */
import { Firestore } from "@google-cloud/firestore";
import { getDb, nowIso } from "./db";

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
};

/* ============================== SQLite 백엔드 ============================== */
const sqliteBackend = {
  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const r = getDb()
      .prepare("SELECT id, email, password_hash, telegram_chat_id, alerts_enabled FROM users WHERE email = ?")
      .get(norm(email)) as any;
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
    const r = getDb()
      .prepare("SELECT id, email, password_hash, telegram_chat_id, alerts_enabled FROM users WHERE id = ?")
      .get(Number(id)) as any;
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
    const info = getDb()
      .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
      .run(norm(email), passwordHash, nowIso());
    return {
      id: String(info.lastInsertRowid),
      email: norm(email),
      passwordHash,
      telegramChatId: null,
      alertsEnabled: true,
    };
  },
  async updateUserTelegram(id: string, p: { telegramChatId?: string | null; alertsEnabled?: boolean }) {
    const db = getDb();
    if (p.telegramChatId !== undefined)
      db.prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(p.telegramChatId || null, Number(id));
    if (p.alertsEnabled !== undefined)
      db.prepare("UPDATE users SET alerts_enabled = ? WHERE id = ?").run(p.alertsEnabled ? 1 : 0, Number(id));
  },
  async createSession(token: string, userId: string, expiresAt: string) {
    getDb()
      .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, Number(userId), nowIso(), expiresAt);
  },
  async getSession(token: string) {
    const r = getDb().prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(token) as any;
    return r ? { userId: String(r.user_id), expiresAt: r.expires_at as string } : null;
  },
  async deleteSession(token: string) {
    getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
  },
  async addWatch(userId: string, corpCode: string) {
    getDb()
      .prepare("INSERT INTO watchlist (user_id, corp_code, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(Number(userId), corpCode, nowIso());
  },
  async removeWatch(userId: string, corpCode: string) {
    getDb().prepare("DELETE FROM watchlist WHERE user_id = ? AND corp_code = ?").run(Number(userId), corpCode);
  },
  async isWatched(userId: string, corpCode: string) {
    return !!getDb()
      .prepare("SELECT 1 FROM watchlist WHERE user_id = ? AND corp_code = ?")
      .get(Number(userId), corpCode);
  },
  async listWatchCorpCodes(userId: string): Promise<string[]> {
    return (
      getDb().prepare("SELECT corp_code FROM watchlist WHERE user_id = ?").all(Number(userId)) as any[]
    ).map((r) => r.corp_code);
  },
  async listAlertTargets(): Promise<AlertTarget[]> {
    const users = getDb()
      .prepare("SELECT id, telegram_chat_id FROM users WHERE alerts_enabled = 1 AND telegram_chat_id IS NOT NULL")
      .all() as any[];
    return users.map((u) => ({
      userId: String(u.id),
      telegramChatId: u.telegram_chat_id,
      corpCodes: (
        getDb().prepare("SELECT corp_code FROM watchlist WHERE user_id = ?").all(u.id) as any[]
      ).map((r) => r.corp_code),
    }));
  },
  async hasNotification(userId: string, changeId: number) {
    return !!getDb()
      .prepare("SELECT 1 FROM notifications WHERE user_id = ? AND change_log_id = ?")
      .get(Number(userId), changeId);
  },
  async recordNotification(userId: string, changeId: number, status: string) {
    getDb()
      .prepare(
        "INSERT INTO notifications (user_id, change_log_id, channel, status, sent_at) VALUES (?, ?, 'telegram', ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(Number(userId), changeId, status, nowIso());
  },
  async createLinkToken(token: string, userId: string, expiresAt: string) {
    getDb()
      .prepare("INSERT INTO telegram_link_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(token, Number(userId), expiresAt, nowIso());
  },
  async consumeLinkToken(token: string): Promise<string | null> {
    const db = getDb();
    const r = db.prepare("SELECT user_id, expires_at FROM telegram_link_tokens WHERE token = ?").get(token) as any;
    if (!r) return null;
    db.prepare("DELETE FROM telegram_link_tokens WHERE token = ?").run(token);
    return new Date(r.expires_at) < new Date() ? null : String(r.user_id);
  },
  async getCalendarPrefs(userId: string): Promise<CalendarPrefsRecord | null> {
    const r = getDb()
      .prepare("SELECT prefs_json, feed_token FROM calendar_prefs WHERE user_id = ?")
      .get(String(userId)) as any;
    return r
      ? { userId: String(userId), prefs: JSON.parse(r.prefs_json || "{}"), feedToken: r.feed_token }
      : null;
  },
  async upsertCalendarPrefs(userId: string, prefs: CalendarPrefsData, feedToken: string): Promise<void> {
    getDb()
      .prepare(
        "INSERT INTO calendar_prefs (user_id, prefs_json, feed_token, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json, " +
          "feed_token = excluded.feed_token, updated_at = excluded.updated_at",
      )
      .run(String(userId), JSON.stringify(prefs), feedToken, nowIso());
  },
  async getCalendarPrefsByToken(token: string): Promise<CalendarPrefsRecord | null> {
    const r = getDb()
      .prepare("SELECT user_id, prefs_json, feed_token FROM calendar_prefs WHERE feed_token = ?")
      .get(token) as any;
    return r
      ? { userId: String(r.user_id), prefs: JSON.parse(r.prefs_json || "{}"), feedToken: r.feed_token }
      : null;
  },
};

export const userStore = useFirestore ? firestoreBackend : sqliteBackend;
export const userStoreKind = useFirestore ? "firestore" : "sqlite";
