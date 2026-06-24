import { all, nowIso, query, type Queryable } from "./db";

const NAVER_NEWS_URL = "https://openapi.naver.com/v1/search/news.json";
const STOCK_ANALYSIS_BASE = "https://stockanalysis.com/stocks";
const STOCK_ANALYSIS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

type NewsProvider = "naver" | "stockanalysis";

export interface CompanyNewsSearchTarget {
  corp_code: string;
  stock_code: string;
  name: string;
  name_eng: string | null;
  market: string | null;
  source: string;
  news_keyword: string | null;
  news_ingested_at: string | null;
}

export interface CompanyNewsBackfillSummary {
  targeted: number;
  ok: number;
  fail: number;
  skipped: number;
  fetched: number;
  writes: number;
}

export interface CompanyNewsBackfillOptions {
  naverClientId?: string;
  naverClientSecret?: string;
  providers?: NewsProvider[];
  limit?: number;
  corpCode?: string;
  display?: number;
  retainPerCompany?: number;
  staleHours?: number;
  callDelayMs?: number;
  markets?: string[];
  log?: (message: string) => void;
}

interface NaverNewsResponse {
  items?: Array<{
    title?: string;
    originallink?: string;
    link?: string;
    description?: string;
    pubDate?: string;
  }>;
}

interface NormalizedNewsItem {
  provider: NewsProvider;
  query: string;
  sourceName: string | null;
  title: string;
  description: string | null;
  url: string;
  originUrl: string | null;
  publishedAt: string | null;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(n)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isNasdaqCompany(company: CompanyNewsSearchTarget): boolean {
  return company.source === "nasdaq" || company.market === "NASDAQ";
}

function providerForCompany(company: CompanyNewsSearchTarget): NewsProvider {
  return isNasdaqCompany(company) ? "stockanalysis" : "naver";
}

export function buildCompanyNewsQuery(company: CompanyNewsSearchTarget, provider = providerForCompany(company)): string {
  const explicit = company.news_keyword?.trim();
  if (explicit) return explicit;
  if (provider === "stockanalysis") return company.stock_code.trim().toUpperCase();
  return company.name.trim();
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeNewsText(raw: string | undefined): string {
  return decodeHtmlEntities(raw ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePubDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function hostnameOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function decodeJsString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\"/g, "\"").replace(/\\n/g, "\n").replace(/\\u0026/g, "&");
  }
}

function fieldString(obj: string, key: string): string | null {
  const match = new RegExp(`${key}:"((?:\\\\.|[^"\\\\])*)"`).exec(obj);
  return match ? decodeJsString(match[1]) : null;
}

function extractBalanced(source: string, start: number, open: string, close: string): string | null {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaping) escaping = false;
      else if (ch === "\\") escaping = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function splitTopLevelObjects(arraySource: string): string[] {
  const body = arraySource.trim().replace(/^\[/, "").replace(/\]$/, "");
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaping) escaping = false;
      else if (ch === "\\") escaping = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) objects.push(body.slice(start, i + 1));
    }
  }
  return objects;
}

async function searchNaverNews(
  clientId: string,
  clientSecret: string,
  company: CompanyNewsSearchTarget,
  display: number,
): Promise<NormalizedNewsItem[]> {
  const searchQuery = buildCompanyNewsQuery(company, "naver");
  const url = new URL(NAVER_NEWS_URL);
  url.searchParams.set("query", searchQuery);
  url.searchParams.set("display", String(clamp(display, 1, 100)));
  url.searchParams.set("start", "1");
  url.searchParams.set("sort", "date");

  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Naver news search failed ${res.status}: ${body.slice(0, 240)}`);
  }

  const payload = (await res.json()) as NaverNewsResponse;
  return (payload.items ?? [])
    .map((item): NormalizedNewsItem | null => {
      const title = normalizeNewsText(item.title);
      const description = normalizeNewsText(item.description);
      const url = item.link || item.originallink || "";
      if (!title || !url) return null;
      return {
        provider: "naver" as const,
        query: searchQuery,
        sourceName: hostnameOf(item.originallink || item.link),
        title,
        description: description || null,
        url,
        originUrl: item.originallink || null,
        publishedAt: parsePubDate(item.pubDate),
      };
    })
    .filter((item): item is NormalizedNewsItem => item !== null);
}

async function searchStockAnalysisNews(company: CompanyNewsSearchTarget, display: number): Promise<NormalizedNewsItem[]> {
  const symbol = buildCompanyNewsQuery(company, "stockanalysis").toLowerCase();
  const res = await fetch(`${STOCK_ANALYSIS_BASE}/${encodeURIComponent(symbol)}/`, {
    headers: STOCK_ANALYSIS_HEADERS,
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`StockAnalysis ${symbol} HTTP ${res.status}: ${html.slice(0, 120).replace(/\s+/g, " ")}`);
  if (/captcha|enable js|blocked|too many requests/i.test(html.slice(0, 1000))) {
    throw new Error(`StockAnalysis ${symbol} blocked`);
  }

  const marker = "news:{";
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return [];
  const dataAt = html.indexOf("data:[", markerAt + marker.length);
  if (dataAt < 0) return [];
  const arrayStart = html.indexOf("[", dataAt);
  if (arrayStart < 0) return [];
  const arraySource = extractBalanced(html, arrayStart, "[", "]");
  if (!arraySource) return [];

  return splitTopLevelObjects(arraySource)
    .map((obj): NormalizedNewsItem | null => {
      const type = fieldString(obj, "type");
      const url = fieldString(obj, "url");
      const title = normalizeNewsText(fieldString(obj, "title") ?? undefined);
      if (type !== "Article" || !url?.startsWith("http") || !title) return null;
      const text = normalizeNewsText(fieldString(obj, "text") ?? undefined);
      return {
        provider: "stockanalysis" as const,
        query: symbol.toUpperCase(),
        sourceName: fieldString(obj, "source") || hostnameOf(url),
        title,
        description: text || null,
        url,
        originUrl: url,
        publishedAt: parsePubDate(fieldString(obj, "time") ?? undefined),
      };
    })
    .filter((item): item is NormalizedNewsItem => item !== null)
    .slice(0, clamp(display, 1, 100));
}

function enabledProviders(options: CompanyNewsBackfillOptions): Set<NewsProvider> {
  const requested = new Set(options.providers ?? ["naver", "stockanalysis"]);
  const enabled = new Set<NewsProvider>();
  if (requested.has("naver") && options.naverClientId && options.naverClientSecret) enabled.add("naver");
  if (requested.has("stockanalysis")) enabled.add("stockanalysis");
  return enabled;
}

async function selectNewsTargets(
  db: Queryable,
  options: CompanyNewsBackfillOptions,
): Promise<CompanyNewsSearchTarget[]> {
  const providers = enabledProviders(options);
  if (providers.size === 0) return [];

  const params: unknown[] = [];
  const where = ["active = 1"];
  const push = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const providerWhere: string[] = [];
  if (providers.has("naver")) providerWhere.push("(source <> 'nasdaq' AND COALESCE(market, '') <> 'NASDAQ')");
  if (providers.has("stockanalysis")) providerWhere.push("(source = 'nasdaq' OR market = 'NASDAQ')");
  where.push(`(${providerWhere.join(" OR ")})`);

  if (options.corpCode) where.push(`corp_code = ${push(options.corpCode)}`);
  if (options.markets?.length) where.push(`market IN (${options.markets.map((m) => push(m)).join(", ")})`);
  if ((options.staleHours ?? 2) > 0) {
    const staleBefore = new Date(Date.now() - (options.staleHours ?? 2) * 3600_000).toISOString();
    where.push(`(news_ingested_at IS NULL OR news_ingested_at < ${push(staleBefore)})`);
  }

  const limit = Math.max(0, Math.floor(options.limit ?? 80));
  const limitSql = limit > 0 ? `LIMIT ${push(limit)}` : "";

  return all<CompanyNewsSearchTarget>(
    `SELECT corp_code, stock_code, name, name_eng, market, source, news_keyword, news_ingested_at
     FROM companies
     WHERE ${where.join(" AND ")}
     ORDER BY news_ingested_at ASC NULLS FIRST, market_cap DESC NULLS LAST, corp_code
     ${limitSql}`,
    params,
    db,
  );
}

async function pruneCompanyNews(db: Queryable, corpCode: string, retainPerCompany: number) {
  if (retainPerCompany <= 0) return;
  await query(
    `DELETE FROM company_news
     WHERE corp_code = $1
       AND id NOT IN (
         SELECT id
         FROM company_news
         WHERE corp_code = $1
         ORDER BY published_at DESC NULLS LAST, ingested_at DESC, id DESC
         LIMIT $2
       )`,
    [corpCode, retainPerCompany],
    db,
  );
}

async function upsertCompanyNews(
  db: Queryable,
  company: CompanyNewsSearchTarget,
  items: NormalizedNewsItem[],
): Promise<number> {
  const fetchedAt = nowIso();
  let writes = 0;
  for (const item of items) {
    const result = await query(
      `INSERT INTO company_news
         (corp_code, provider, query, source_name, title, description, url, origin_url, published_at, ingested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (corp_code, url) DO UPDATE SET
         provider = EXCLUDED.provider,
         query = EXCLUDED.query,
         source_name = EXCLUDED.source_name,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         origin_url = EXCLUDED.origin_url,
         published_at = EXCLUDED.published_at,
         ingested_at = EXCLUDED.ingested_at
       WHERE company_news.provider IS DISTINCT FROM EXCLUDED.provider
          OR company_news.query IS DISTINCT FROM EXCLUDED.query
          OR company_news.source_name IS DISTINCT FROM EXCLUDED.source_name
          OR company_news.title IS DISTINCT FROM EXCLUDED.title
          OR company_news.description IS DISTINCT FROM EXCLUDED.description
          OR company_news.origin_url IS DISTINCT FROM EXCLUDED.origin_url
          OR company_news.published_at IS DISTINCT FROM EXCLUDED.published_at`,
      [
        company.corp_code,
        item.provider,
        item.query,
        item.sourceName,
        item.title,
        item.description,
        item.url,
        item.originUrl,
        item.publishedAt,
        fetchedAt,
      ],
      db,
    );
    writes += result.rowCount ?? 0;
  }
  await query("UPDATE companies SET news_ingested_at = $1 WHERE corp_code = $2", [fetchedAt, company.corp_code], db);
  return writes;
}

export async function refreshCompanyNews(
  db: Queryable,
  company: CompanyNewsSearchTarget,
  options: CompanyNewsBackfillOptions,
): Promise<{ provider: NewsProvider; fetched: number; writes: number }> {
  const provider = providerForCompany(company);
  const display = options.display ?? 8;
  const items =
    provider === "naver"
      ? await searchNaverNews(options.naverClientId ?? "", options.naverClientSecret ?? "", company, display)
      : await searchStockAnalysisNews(company, display);
  const writes = await upsertCompanyNews(db, company, items);
  await pruneCompanyNews(db, company.corp_code, Math.floor(options.retainPerCompany ?? 40));
  return { provider, fetched: items.length, writes };
}

export async function backfillCompanyNews(
  db: Queryable,
  options: CompanyNewsBackfillOptions,
): Promise<CompanyNewsBackfillSummary> {
  const targets = await selectNewsTargets(db, options);
  const providers = enabledProviders(options);
  const log = options.log ?? (() => {});
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  let fetched = 0;
  let writes = 0;

  for (let i = 0; i < targets.length; i++) {
    const company = targets[i];
    const provider = providerForCompany(company);
    if (!providers.has(provider)) {
      skipped++;
      log(`${company.corp_code} ${company.name} ${provider} skipped:no-provider\n`);
      continue;
    }
    try {
      const result = await refreshCompanyNews(db, company, options);
      ok++;
      fetched += result.fetched;
      writes += result.writes;
      log(
        `${company.corp_code} ${company.name} ${result.provider} fetched=${result.fetched} writes=${result.writes}\n`,
      );
    } catch (e) {
      fail++;
      log(`${company.corp_code} ${company.name} ${provider} error ${(e as Error).message}\n`);
    }
    const delay = Math.max(0, Math.floor(options.callDelayMs ?? 500));
    if (delay > 0 && i < targets.length - 1) await sleep(delay);
  }

  return { targeted: targets.length, ok, fail, skipped, fetched, writes };
}
