import { all, ensureMigrated, nowIso, one } from "./db";

export interface RecordCompanyViewInput {
  browserUuid: string;
  userId?: string | null;
  corpCode: string;
  path?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
}

export interface AdminViewTotals {
  views: number;
  browsers: number;
  loggedUsers: number;
  companies: number;
}

export interface AdminCompanyViewSummary {
  corp_code: string;
  name: string;
  stock_code: string;
  market: string | null;
  views: number;
  browsers: number;
  logged_users: number;
  last_viewed_at: string;
}

export interface AdminVisitorSummary {
  browser_uuid: string;
  emails: string | null;
  views: number;
  companies: number;
  first_viewed_at: string;
  last_viewed_at: string;
  top_companies: string | null;
}

export interface AdminRawViewEvent {
  id: number;
  viewed_at: string;
  browser_uuid: string;
  email: string | null;
  corp_code: string;
  name: string;
  stock_code: string;
  market: string | null;
  path: string | null;
  referrer: string | null;
  user_agent: string | null;
}

export interface AdminCompanyViewData {
  totals: AdminViewTotals;
  topCompanies: AdminCompanyViewSummary[];
  visitors: AdminVisitorSummary[];
  recent: AdminRawViewEvent[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidBrowserUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function cleanText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export async function recordCompanyView(input: RecordCompanyViewInput): Promise<number | null> {
  await ensureMigrated();

  const row = await one<{ id: number }>(
    `INSERT INTO company_view_events
       (browser_uuid, user_id, corp_code, viewed_at, path, referrer, user_agent)
     SELECT $1, $2::BIGINT, c.corp_code, $4, $5, $6, $7
     FROM companies c
     WHERE c.corp_code = $3
     RETURNING id`,
    [
      input.browserUuid,
      input.userId ? Number(input.userId) : null,
      input.corpCode,
      nowIso(),
      cleanText(input.path, 512),
      cleanText(input.referrer, 512),
      cleanText(input.userAgent, 512),
    ],
  );

  return row?.id ?? null;
}

export async function getAdminCompanyViewData(limit = 200): Promise<AdminCompanyViewData> {
  await ensureMigrated();

  const [totals, topCompanies, visitors, recent] = await Promise.all([
    one<AdminViewTotals>(
      `SELECT
         COUNT(*)::int AS views,
         COUNT(DISTINCT browser_uuid)::int AS browsers,
         COUNT(DISTINCT user_id)::int AS "loggedUsers",
         COUNT(DISTINCT corp_code)::int AS companies
       FROM company_view_events`,
    ),
    all<AdminCompanyViewSummary>(
      `SELECT
         e.corp_code,
         c.name,
         c.stock_code,
         c.market,
         COUNT(*)::int AS views,
         COUNT(DISTINCT e.browser_uuid)::int AS browsers,
         COUNT(DISTINCT e.user_id)::int AS logged_users,
         MAX(e.viewed_at) AS last_viewed_at
       FROM company_view_events e
       JOIN companies c ON c.corp_code = e.corp_code
       GROUP BY e.corp_code, c.name, c.stock_code, c.market
       ORDER BY views DESC, last_viewed_at DESC
       LIMIT $1`,
      [limit],
    ),
    all<AdminVisitorSummary>(
      `WITH per_company AS (
         SELECT
           e.browser_uuid,
           c.corp_code,
           c.name,
           c.stock_code,
           COUNT(*)::int AS view_count,
           MAX(e.viewed_at) AS last_viewed_at
         FROM company_view_events e
         JOIN companies c ON c.corp_code = e.corp_code
         GROUP BY e.browser_uuid, c.corp_code, c.name, c.stock_code
       ),
       ranked AS (
         SELECT
           *,
           ROW_NUMBER() OVER (
             PARTITION BY browser_uuid
             ORDER BY view_count DESC, last_viewed_at DESC
           ) AS rn
         FROM per_company
       ),
       top_lists AS (
         SELECT
           browser_uuid,
           STRING_AGG(name || ' ' || stock_code || ' (' || view_count || ')', ', ' ORDER BY view_count DESC, last_viewed_at DESC) AS top_companies
         FROM ranked
         WHERE rn <= 5
         GROUP BY browser_uuid
       ),
       totals AS (
         SELECT
           e.browser_uuid,
           STRING_AGG(DISTINCT u.email, ', ' ORDER BY u.email) FILTER (WHERE u.email IS NOT NULL) AS emails,
           COUNT(*)::int AS views,
           COUNT(DISTINCT e.corp_code)::int AS companies,
           MIN(e.viewed_at) AS first_viewed_at,
           MAX(e.viewed_at) AS last_viewed_at
         FROM company_view_events e
         LEFT JOIN users u ON u.id = e.user_id
         GROUP BY e.browser_uuid
       )
       SELECT
         totals.browser_uuid,
         totals.emails,
         totals.views,
         totals.companies,
         totals.first_viewed_at,
         totals.last_viewed_at,
         top_lists.top_companies
       FROM totals
       LEFT JOIN top_lists ON top_lists.browser_uuid = totals.browser_uuid
       ORDER BY totals.last_viewed_at DESC
       LIMIT $1`,
      [limit],
    ),
    all<AdminRawViewEvent>(
      `SELECT
         e.id,
         e.viewed_at,
         e.browser_uuid,
         u.email,
         c.corp_code,
         c.name,
         c.stock_code,
         c.market,
         e.path,
         e.referrer,
         e.user_agent
       FROM company_view_events e
       JOIN companies c ON c.corp_code = e.corp_code
       LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.viewed_at DESC
       LIMIT $1`,
      [limit],
    ),
  ]);

  return {
    totals: totals ?? { views: 0, browsers: 0, loggedUsers: 0, companies: 0 },
    topCompanies,
    visitors,
    recent,
  };
}
