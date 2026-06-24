import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { userStore, type StoredUser } from "./userstore";

/** 경량 인증 — scrypt 해시 + 세션 토큰(httpOnly 쿠키). 저장은 Postgres userStore. */

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
  id: string;
  email: string;
  is_admin: number;
  telegram_chat_id: string | null;
  alerts_enabled: number;
}

const toUser = (u: StoredUser): User => ({
  id: u.id,
  email: u.email,
  is_admin: u.isAdmin ? 1 : 0,
  telegram_chat_id: u.telegramChatId,
  alerts_enabled: u.alertsEnabled ? 1 : 0,
});

export async function createUser(email: string, password: string): Promise<User> {
  return toUser(await userStore.createUser(email, hashPassword(password)));
}

export async function getUserById(id: string): Promise<User | undefined> {
  const u = await userStore.getUserById(id);
  return u ? toUser(u) : undefined;
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const u = await userStore.getUserByEmail(email);
  if (!u || !verifyPassword(password, u.passwordHash)) return null;
  return toUser(u);
}

export async function ensureConfiguredAdminUser(): Promise<User | null> {
  const email = process.env.BUTLER_ADMIN_EMAIL?.trim();
  const password = process.env.BUTLER_ADMIN_PASSWORD;
  if (!email || !password) return null;
  return toUser(await userStore.ensureAdminUser(email, hashPassword(password)));
}

export function isAdminUser(user: User | null | undefined): boolean {
  return user?.is_admin === 1;
}

export function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const exp = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  return userStore.createSession(token, userId, exp).then(() => token);
}

export async function getSessionUser(token?: string | null): Promise<User | null> {
  if (!token) return null;
  const s = await userStore.getSession(token);
  if (!s) return null;
  if (new Date(s.expiresAt) < new Date()) {
    await userStore.deleteSession(token);
    return null;
  }
  return (await getUserById(s.userId)) ?? null;
}

export async function destroySession(token: string): Promise<void> {
  await userStore.deleteSession(token);
}

export const sessionCookieMaxAge = SESSION_DAYS * 86400;
