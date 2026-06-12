import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb, nowIso } from "./db";

/** 경량 인증 — scrypt 해시 + sessions 테이블 토큰(httpOnly 쿠키). */

export const SESSION_COOKIE = "butler_session";
const SESSION_DAYS = 30;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, "hex");
  return test.length === known.length && timingSafeEqual(test, known);
}

export interface User {
  id: number;
  email: string;
  telegram_chat_id: string | null;
  alerts_enabled: number;
}

export function createUser(email: string, password: string): User {
  const db = getDb();
  const info = db
    .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
    .run(email.toLowerCase().trim(), hashPassword(password), nowIso());
  return getUserById(Number(info.lastInsertRowid))!;
}

export function getUserById(id: number): User | undefined {
  return getDb()
    .prepare("SELECT id, email, telegram_chat_id, alerts_enabled FROM users WHERE id = ?")
    .get(id) as User | undefined;
}

export function authenticate(email: string, password: string): User | null {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) as
    | { id: number; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return getUserById(row.id)!;
}

export function createSession(userId: number): string {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  getDb()
    .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, userId, now.toISOString(), exp.toISOString());
  return token;
}

export function getSessionUser(token?: string | null): User | null {
  if (!token) return null;
  const row = getDb()
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .get(token) as { user_id: number; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    destroySession(token);
    return null;
  }
  return getUserById(row.user_id) ?? null;
}

export function destroySession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export const sessionCookieMaxAge = SESSION_DAYS * 86400;
