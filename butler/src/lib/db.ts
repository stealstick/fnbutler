import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 단일 SQLite 연결을 프로세스 전역에 캐시한다.
 * Next.js dev 의 HMR 로 모듈이 재평가돼도 연결이 중복 생성되지 않도록
 * globalThis 에 보관한다.
 */
const DB_PATH = process.env.BUTLER_DB_PATH || join(process.cwd(), "db", "butler.db");
const SCHEMA_PATH = join(process.cwd(), "db", "schema.sql");

type G = typeof globalThis & { __butlerDb?: Database.Database; __butlerMigrated?: boolean };
const g = globalThis as G;

export function getDb(): Database.Database {
  if (g.__butlerDb) return g.__butlerDb;
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  g.__butlerDb = db;
  // 최초 연결 시 1회 스키마 보장 (컬럼/뷰 누락으로 페이지가 깨지지 않게)
  if (!g.__butlerMigrated) {
    try {
      migrate(db);
      g.__butlerMigrated = true;
    } catch {
      /* 다른 프로세스가 마이그레이션 중일 수 있음 — 무시 */
    }
  }
  return db;
}

/** 스키마를 적용한다 (CREATE IF NOT EXISTS 이므로 멱등). */
export function migrate(db = getDb()): void {
  // companies 신규 컬럼 (ALTER 는 IF NOT EXISTS 미지원 → 존재 확인 후 추가)
  const cols = new Set(
    (db.prepare("PRAGMA table_info(companies)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  // companies 테이블이 아직 없으면(최초) schema.sql 가 만든 뒤 컬럼이 다 들어있음
  if (cols.size > 0) {
    if (!cols.has("sector_code")) db.exec("ALTER TABLE companies ADD COLUMN sector_code TEXT");
    if (!cols.has("sector_name")) db.exec("ALTER TABLE companies ADD COLUMN sector_name TEXT");
  }
  // change_logs.occurred_at (실제 발생일) 추가
  const clCols = new Set(
    (db.prepare("PRAGMA table_info(change_logs)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (clCols.size > 0 && !clCols.has("occurred_at")) {
    db.exec("ALTER TABLE change_logs ADD COLUMN occurred_at TEXT");
    // 기존 행은 발생일을 모르므로 일단 관측시각 날짜로 채움(백필 스크립트가 재생성)
    db.exec("UPDATE change_logs SET occurred_at = substr(observed_at,1,10) WHERE occurred_at IS NULL");
  }
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql);
}

export const nowIso = () => new Date().toISOString();
