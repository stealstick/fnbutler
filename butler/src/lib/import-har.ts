import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { nowIso } from "./db";
import {
  upsertCompanyFromScreen,
  upsertCompanyDetail,
  upsertTargetPriceMonthly,
  upsertFinancials,
  upsertValuations,
  updateCompanyConsensusSummary,
  writeConsensusReports,
  type CollectedReport,
} from "./ingest";

/**
 * butler.works HAR 파일에서 캡처된 응답 바디를 추출해 DB 로 적재한다.
 * 로그인 세션으로 캡처한 HAR 이면 비로그인 API 로는 막혀있는 최신 재무
 * 시계열(2024~2026)까지 그대로 백필된다.
 */

interface HarEntry {
  request: { method: string; url: string };
  response: { content: { text?: string; encoding?: string; size?: number } };
}

function bodyOf(e: HarEntry): any | null {
  const c = e.response?.content;
  let t = c?.text;
  if (!t) return null;
  if (c.encoding === "base64") {
    try {
      t = Buffer.from(t, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export interface ImportStats {
  companies: number;
  detail: number;
  financials: number;
  targetPrice: number;
  reports: number;
  skipped: number;
}

export function importHar(db: Database.Database, harPath: string): ImportStats {
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  const entries: HarEntry[] = har.log.entries;
  const now = nowIso();
  const stats: ImportStats = {
    companies: 0,
    detail: 0,
    financials: 0,
    targetPrice: 0,
    reports: 0,
    skipped: 0,
  };

  // corpCode → { quarter, accumulated } 요약 바디 페어링용
  const summaries = new Map<string, { quarter?: any; accumulated?: any }>();

  const stubStmt = db.prepare(
    `INSERT INTO companies (corp_code, stock_code, name, source, created_at, updated_at)
     VALUES (?, '', '', 'butler', ?, ?) ON CONFLICT(corp_code) DO NOTHING`,
  );
  const stub = (cc: string) => stubStmt.run(cc, now, now);

  for (const e of entries) {
    const url = e.request.url;
    if (!url.includes("api.butler.works")) continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const path = u.pathname;
    const body = bodyOf(e);
    if (!body) {
      stats.skipped++;
      continue;
    }

    // 스크리너 결과 → 기업 목록
    if (path === "/api/screener/screen" && e.request.method === "POST") {
      for (const r of body.results ?? []) {
        upsertCompanyFromScreen(db, r, now);
        stats.companies++;
      }
      continue;
    }

    // 기업 상세 /api/companies/{8자리}
    let m = /^\/api\/companies\/(\d{8})$/.exec(path);
    if (m) {
      upsertCompanyDetail(db, body, now);
      stats.detail++;
      continue;
    }

    // 재무 요약 /api/v2/analysis/summary/{corp} (quarter / accumulated 페어)
    m = /^\/api\/v2\/analysis\/summary\/(\d{8})$/.exec(path);
    if (m) {
      const cc = m[1];
      const period = u.searchParams.get("quarterPeriod") === "quarter" ? "quarter" : "accumulated";
      const s = summaries.get(cc) ?? {};
      s[period] = body;
      summaries.set(cc, s);
      continue;
    }

    // 목표주가 집계
    if (path === "/api/consensus/target-prices") {
      const cc = u.searchParams.get("corpCode");
      if (!cc) continue;
      stub(cc);
      upsertTargetPriceMonthly(db, cc, body);
      updateCompanyConsensusSummary(db, cc, body, now);
      stats.targetPrice++;
      continue;
    }

    // 피드 → 컨센서스 리포트 (증권사별 목표주가)
    m = /^\/api\/feed\/(\d{8})$/.exec(path);
    if (m) {
      const cc = m[1];
      stub(cc);
      const collected: CollectedReport[] = [];
      for (const it of body.data ?? []) {
        if (it.type === "CONSENSUS" && it.contents?.reportId && it.contents.values) {
          collected.push({ reportId: it.contents.reportId, values: it.contents.values });
        }
      }
      stats.reports += writeConsensusReports(db, cc, collected);
      continue;
    }
  }

  // 페어링된 요약 처리 (재무 + 밸류에이션)
  const empty = { fs: {}, consensus: {}, valuations: {} } as any;
  for (const [cc, s] of summaries) {
    stub(cc);
    const q = s.quarter ?? empty;
    const acc = s.accumulated ?? s.quarter ?? empty;
    upsertFinancials(db, cc, q, acc);
    if (s.accumulated) upsertValuations(db, cc, s.accumulated);
    stats.financials++;
  }

  // HAR 로 데이터가 채워진 기업에 상세수집 마킹 (재무/리포트/목표주가 보유 기업)
  db.prepare(
    `UPDATE companies SET detail_ingested_at = COALESCE(detail_ingested_at, ?),
        has_consensus = CASE WHEN EXISTS
          (SELECT 1 FROM consensus_reports r WHERE r.corp_code = companies.corp_code)
          THEN 1 ELSE has_consensus END
     WHERE corp_code IN (
        SELECT corp_code FROM financials
        UNION SELECT corp_code FROM consensus_reports
        UNION SELECT corp_code FROM target_price_monthly)`,
  ).run(now);

  return stats;
}
