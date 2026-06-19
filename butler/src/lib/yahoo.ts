import { all, nowIso, query, tx, type Queryable } from "./db";
import { fetchUsdKrwRate } from "./nasdaq";

const YAHOO_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "application/json,text/plain,*/*",
};
const YAHOO_MODULES = "financialData,earningsTrend,price";
const ESTIMATE_SOURCE = "yahoo:earningsTrend";
const TARGET_SOURCE = "yahoo:financialData";

type YahooValue = number | string | { raw?: number | string | null } | null | undefined;
type YahooTrend = {
  period?: string;
  endDate?: string;
  earningsEstimate?: {
    avg?: YahooValue;
    numberOfAnalysts?: YahooValue;
  };
  revenueEstimate?: {
    avg?: YahooValue;
    numberOfAnalysts?: YahooValue;
  };
};
type YahooQuoteResult = {
  financialData?: {
    targetMeanPrice?: YahooValue;
    targetHighPrice?: YahooValue;
    targetLowPrice?: YahooValue;
    targetMedianPrice?: YahooValue;
    numberOfAnalystOpinions?: YahooValue;
    currentPrice?: YahooValue;
  };
  earningsTrend?: { trend?: YahooTrend[] };
};
type YahooSummary = {
  quoteSummary?: {
    result?: YahooQuoteResult[];
    error?: { code?: string; description?: string };
  };
  finance?: { error?: { code?: string; description?: string } };
};
type YahooSession = { cookie: string; crumb: string };

type NasdaqCandidate = {
  corp_code: string;
  stock_code: string;
  price: number | null;
  target_price_avg: number | null;
};

export interface YahooNasdaqBackfillOptions {
  limit?: number;
  corpCode?: string;
  symbol?: string;
  callDelayMs?: number;
  overwriteEstimates?: boolean;
  overwriteTargets?: boolean;
  log?: (message: string) => void;
}

export interface YahooNasdaqBackfillSummary {
  targeted: number;
  ok: number;
  fail: number;
  writes: number;
  estimateWrites: number;
  targetWrites: number;
  usdKrw: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  return h.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
}

function cookieHeader(cookies: string[]): string {
  return cookies
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function raw(rawValue: YahooValue): number | null {
  const v = rawValue && typeof rawValue === "object" && "raw" in rawValue ? rawValue.raw : rawValue;
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function quarterFromDate(date: string | undefined): { year: number; quarter: number } | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(date ?? ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  return { year, quarter: Math.ceil(month / 3) };
}

function yearFromDate(date: string | undefined): number | null {
  const year = Number(String(date ?? "").slice(0, 4));
  return Number.isInteger(year) && year > 1900 ? year : null;
}

async function getYahooSession(log: (message: string) => void = () => {}): Promise<YahooSession> {
  const attempts = Math.max(1, Math.floor(Number(process.env.YAHOO_SESSION_RETRIES || "3")));
  const retryDelayMs = Math.max(0, Math.floor(Number(process.env.YAHOO_SESSION_RETRY_DELAY_MS || "60000")));
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const fc = await fetch("https://fc.yahoo.com", { redirect: "manual", headers: YAHOO_HEADERS });
      const cookie = cookieHeader(getSetCookies(fc.headers));
      if (!cookie) throw new Error("Yahoo did not provide a session cookie");

      const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
        headers: { ...YAHOO_HEADERS, cookie },
      });
      const crumb = (await crumbRes.text()).trim();
      if (!crumbRes.ok || !crumb || /<html|Too Many Requests|Unauthorized/i.test(crumb)) {
        throw new Error(`Yahoo crumb failed: HTTP ${crumbRes.status}`);
      }
      const cookie2 = cookieHeader([...getSetCookies(fc.headers), ...getSetCookies(crumbRes.headers)]) || cookie;
      return { cookie: cookie2, crumb };
    } catch (e) {
      lastError = e as Error;
      if (attempt >= attempts) break;
      log(`  yahoo session retry ${attempt + 1}/${attempts} after ${lastError.message}\n`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new Error("Yahoo session failed");
}

async function fetchYahooSummary(
  symbol: string,
  session: YahooSession,
): Promise<YahooQuoteResult> {
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=${YAHOO_MODULES}&formatted=false&lang=en-US&region=US&corsDomain=finance.yahoo.com` +
    `&crumb=${encodeURIComponent(session.crumb)}`;
  const res = await fetch(url, {
    headers: { ...YAHOO_HEADERS, cookie: session.cookie },
  });
  const json = (await res.json().catch(() => null)) as YahooSummary | null;
  const err = json?.quoteSummary?.error ?? json?.finance?.error;
  if (!res.ok || err) throw new Error(`Yahoo ${symbol} HTTP ${res.status}: ${err?.description ?? err?.code ?? "unknown"}`);
  const result = json?.quoteSummary?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} returned no quoteSummary result`);
  return result;
}

async function candidates(db: Queryable, limit: number, options: YahooNasdaqBackfillOptions): Promise<NasdaqCandidate[]> {
  const where = ["active = 1", "market = 'NASDAQ'", "source = 'nasdaq'"];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (options.corpCode) where.push(`corp_code = ${push(options.corpCode)}`);
  if (options.symbol) where.push(`stock_code = ${push(options.symbol.toUpperCase())}`);
  params.push(limit);
  return all<NasdaqCandidate>(
    `SELECT corp_code, stock_code, price, target_price_avg
     FROM companies
     WHERE ${where.join(" AND ")}
     ORDER BY yahoo_estimates_at ASC NULLS FIRST, market_cap DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
    db,
  );
}

async function insertFinancial(
  db: Queryable,
  c: NasdaqCandidate,
  metric: "REVENUE" | "EPS",
  value: number | null,
  fiscalYear: number,
  quarter: number,
  periodType: "Q" | "A",
  dateLabel: string | undefined,
  usdKrw: number,
  overwrite: boolean,
): Promise<number> {
  if (value == null) return 0;
  const storedValue = metric === "EPS" ? value : Math.round(value * usdKrw);
  const conflict = overwrite
    ? `DO UPDATE SET value = excluded.value, raw_label = excluded.raw_label,
                     date_label = excluded.date_label, source = excluded.source`
    : "DO NOTHING";
  const res = await query(
    `INSERT INTO financials
       (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate)
     ${conflict}`,
    [
      c.corp_code,
      metric,
      metric === "REVENUE" ? "Yahoo Revenue Avg" : "Yahoo EPS Avg",
      fiscalYear,
      quarter,
      periodType,
      storedValue,
      dateLabel ?? (periodType === "A" ? String(fiscalYear) : `${fiscalYear}.${quarter}Q`),
      ESTIMATE_SOURCE,
    ],
    db,
  );
  return res.rowCount ?? 0;
}

async function upsertYahooRows(
  db: Queryable,
  c: NasdaqCandidate,
  result: Awaited<ReturnType<typeof fetchYahooSummary>>,
  usdKrw: number,
  options: Required<Pick<YahooNasdaqBackfillOptions, "overwriteEstimates" | "overwriteTargets">>,
): Promise<{ writes: number; estimateWrites: number; targetWrites: number }> {
  const now = nowIso();
  let estimateWrites = 0;
  let targetWrites = 0;
  const trends = result.earningsTrend?.trend ?? [];
  const annualEps: Array<{ period: string; year: number; eps: number | null; analysts: number | null }> = [];
  const analystCounts: number[] = [];

  for (const t of trends) {
    const revenue = raw(t.revenueEstimate?.avg);
    const eps = raw(t.earningsEstimate?.avg);
    const analysts = Math.max(raw(t.revenueEstimate?.numberOfAnalysts) ?? 0, raw(t.earningsEstimate?.numberOfAnalysts) ?? 0);
    if (analysts > 0) analystCounts.push(Math.round(analysts));

    if (t.period === "0q" || t.period === "+1q") {
      const q = quarterFromDate(t.endDate);
      if (!q) continue;
      estimateWrites += await insertFinancial(db, c, "REVENUE", revenue, q.year, q.quarter, "Q", t.endDate, usdKrw, options.overwriteEstimates);
      estimateWrites += await insertFinancial(db, c, "EPS", eps, q.year, q.quarter, "Q", t.endDate, usdKrw, options.overwriteEstimates);
    }
    if (t.period === "0y" || t.period === "+1y") {
      const year = yearFromDate(t.endDate);
      if (!year) continue;
      annualEps.push({ period: t.period, year, eps, analysts: analysts > 0 ? Math.round(analysts) : null });
      estimateWrites += await insertFinancial(db, c, "REVENUE", revenue, year, 0, "A", t.endDate, usdKrw, options.overwriteEstimates);
      estimateWrites += await insertFinancial(db, c, "EPS", eps, year, 0, "A", t.endDate, usdKrw, options.overwriteEstimates);
    }
  }

  const currentAnnual = annualEps.find((r) => r.period === "0y") ?? annualEps[0];
  const nextAnnual =
    annualEps.find((r) => r.period === "+1y") ?? annualEps.find((r) => currentAnnual && r.year > currentAnnual.year);
  const target = raw(result.financialData?.targetMeanPrice);
  const targetHigh = raw(result.financialData?.targetHighPrice);
  const targetLow = raw(result.financialData?.targetLowPrice);
  const currentPrice = c.price ?? raw(result.financialData?.currentPrice);
  const targetReturn = target != null && currentPrice != null && currentPrice !== 0 ? ((target - currentPrice) / Math.abs(currentPrice)) * 100 : null;
  const targetAnalysts = raw(result.financialData?.numberOfAnalystOpinions);
  const cover = Math.max(0, targetAnalysts ?? 0, ...analystCounts) || null;
  const shouldUpdateTarget = target != null && (options.overwriteTargets || c.target_price_avg == null);

  const res = await query(
    `UPDATE companies SET
       eps = CASE WHEN $1::double precision IS NULL THEN eps ELSE COALESCE(eps, $1::double precision) END,
       feps = CASE WHEN $2::double precision IS NULL THEN feps ELSE COALESCE(feps, $2::double precision) END,
       has_consensus = CASE WHEN $3::integer IS NULL THEN has_consensus ELSE 1 END,
       cover_securities = GREATEST(COALESCE(cover_securities, 0), COALESCE($3::integer, 0)),
       target_price_avg = CASE WHEN $4::boolean THEN $5::double precision ELSE target_price_avg END,
       target_return_rate = CASE WHEN $4::boolean THEN $6::double precision ELSE target_return_rate END,
       yahoo_estimates_at = $7,
       yahoo_targets_at = CASE WHEN $8::boolean THEN $7 ELSE yahoo_targets_at END,
       updated_at = $7
     WHERE corp_code = $9`,
    [
      currentAnnual?.eps ?? null,
      nextAnnual?.eps ?? null,
      cover,
      shouldUpdateTarget,
      target,
      targetReturn,
      now,
      target != null,
      c.corp_code,
    ],
    db,
  );
  const companyWrites = res.rowCount ?? 0;

  if (shouldUpdateTarget) {
    const month = now.slice(0, 7);
    const res2 = await query(
      `INSERT INTO target_price_monthly
         (corp_code, month, full_date, tp_max, tp_avg, tp_min, price, cover_securities, return_ratio, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(corp_code, month)
       DO UPDATE SET full_date = excluded.full_date,
                     tp_max = COALESCE(excluded.tp_max, target_price_monthly.tp_max),
                     tp_avg = excluded.tp_avg,
                     tp_min = COALESCE(excluded.tp_min, target_price_monthly.tp_min),
                     price = excluded.price,
                     cover_securities = excluded.cover_securities,
                     return_ratio = excluded.return_ratio,
                     source = excluded.source`,
      [c.corp_code, month, now.slice(0, 10), targetHigh, target, targetLow, currentPrice, targetAnalysts, targetReturn, TARGET_SOURCE],
      db,
    );
    targetWrites += res2.rowCount ?? 0;
  }

  return { writes: companyWrites + estimateWrites + targetWrites, estimateWrites, targetWrites };
}

export async function backfillYahooNasdaqEstimates(
  db: Queryable,
  options: YahooNasdaqBackfillOptions = {},
): Promise<YahooNasdaqBackfillSummary> {
  const limit = Math.max(0, Math.floor(options.limit ?? Number(process.env.YAHOO_NASDAQ_LIMIT || "200")));
  const callDelayMs = Math.max(0, Math.floor(options.callDelayMs ?? Number(process.env.YAHOO_CALL_DELAY_MS || "800")));
  const overwriteEstimates = options.overwriteEstimates ?? false;
  const overwriteTargets = options.overwriteTargets ?? false;
  const log = options.log ?? (() => {});
  const [targets, usdKrw] = await Promise.all([candidates(db, limit, options), fetchUsdKrwRate()]);
  if (targets.length === 0) return { targeted: 0, ok: 0, fail: 0, writes: 0, estimateWrites: 0, targetWrites: 0, usdKrw };

  let session = await getYahooSession(log);
  let ok = 0;
  let fail = 0;
  let writes = 0;
  let estimateWrites = 0;
  let targetWrites = 0;

  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const symbol = c.stock_code;
    try {
      let result: Awaited<ReturnType<typeof fetchYahooSummary>>;
      try {
        result = await fetchYahooSummary(symbol, session);
      } catch (e) {
        if (!/Unauthorized|Invalid Crumb|HTTP 401/i.test((e as Error).message)) throw e;
        session = await getYahooSession(log);
        result = await fetchYahooSummary(symbol, session);
      }
      const r = await tx((client) =>
        upsertYahooRows(client, c, result, usdKrw, { overwriteEstimates, overwriteTargets }),
      );
      ok++;
      writes += r.writes;
      estimateWrites += r.estimateWrites;
      targetWrites += r.targetWrites;
      log(`  yahoo [${i + 1}/${targets.length}] ${symbol} ok writes=${r.writes}\n`);
    } catch (e) {
      fail++;
      log(`  yahoo [${i + 1}/${targets.length}] ${symbol} ERROR ${(e as Error).message}\n`);
    } finally {
      if (callDelayMs > 0) await sleep(callDelayMs);
    }
  }

  return { targeted: targets.length, ok, fail, writes, estimateWrites, targetWrites, usdKrw };
}
