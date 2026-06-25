import { nowIso, query, type Queryable } from "./db";
import { classifyNasdaqSector } from "./sectors";

const NASDAQ_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,ko;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  referer: "https://www.nasdaq.com/",
  origin: "https://www.nasdaq.com",
};

const FALLBACK_USD_KRW = Number(process.env.USD_KRW_FALLBACK || "1400");
const US_EXCHANGES = ["nasdaq", "nyse", "amex"] as const;
const EXCHANGE_MARKET: Record<(typeof US_EXCHANGES)[number], string> = {
  nasdaq: "NASDAQ",
  nyse: "NYSE",
  amex: "AMEX",
};

type NasdaqRow = {
  symbol?: string;
  name?: string;
  lastsale?: string;
  pctchange?: string;
  marketCap?: string;
  country?: string;
  sector?: string;
  industry?: string;
  url?: string;
};

export interface NasdaqCompany {
  symbol: string;
  name: string;
  exchange: string;
  priceUsd: number | null;
  pctChange: number | null;
  marketCapUsd: number;
  country: string | null;
  sector: string | null;
  industry: string | null;
}

export interface NasdaqIngestSummary {
  fetched: number;
  selected: number;
  upserted: number;
  usdKrw: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseNumber(raw: unknown): number | null {
  const n = Number(String(raw ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function cleanText(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s && s !== "-" ? s : null;
}

function isTradableCompany(
  row: Pick<NasdaqCompany, "symbol" | "name" | "industry">,
  marketCapUsd: number,
): boolean {
  const symbol = cleanText(row.symbol);
  const name = cleanText(row.name) ?? "";
  const industry = cleanText(row.industry) ?? "";
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return false;
  if (marketCapUsd <= 0) return false;
  if (/blank checks?|shell companies?/i.test(industry)) return false;
  if (/\bacquisition corp\b/i.test(name)) return false;
  if (/\b(warrants?|rights?|units?|notes?|preferred|depositary share representing preferred|etf|fund)\b/i.test(name))
    return false;
  return true;
}

async function fetchJson<T>(url: string, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: NASDAQ_HEADERS });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= retries) throw new Error(`Nasdaq HTTP ${res.status}`);
    await sleep(800 * (attempt + 1));
  }
}

export async function fetchUsdKrwRate(): Promise<number> {
  const configured = Number(process.env.USD_KRW_RATE || "");
  if (Number.isFinite(configured) && configured > 0) return configured;

  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
    const j = (await res.json()) as { rates?: { KRW?: number } };
    const rate = Number(j.rates?.KRW);
    return Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_USD_KRW;
  } catch {
    return FALLBACK_USD_KRW;
  }
}

async function fetchNasdaqScreenerCompanies(exchange: (typeof US_EXCHANGES)[number]): Promise<NasdaqCompany[]> {
  const url = `https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true&exchange=${exchange}`;
  const json = await fetchJson<{ data?: { rows?: NasdaqRow[] } }>(url);
  const rows = json.data?.rows ?? [];
  return rows.map((row) => {
    const symbol = cleanText(row.symbol)?.toUpperCase() ?? "";
    const name = cleanText(row.name) ?? symbol;
    const marketCapUsd = parseNumber(row.marketCap) ?? 0;
    return {
      symbol,
      name,
      exchange: EXCHANGE_MARKET[exchange],
      priceUsd: parseNumber(row.lastsale),
      pctChange: parseNumber(row.pctchange),
      marketCapUsd,
      country: cleanText(row.country),
      sector: cleanText(row.sector),
      industry: cleanText(row.industry),
    };
  });
}

export async function fetchNasdaqTopCompanies(limit = 500): Promise<NasdaqCompany[]> {
  const batches = await Promise.all(
    US_EXCHANGES.map(async (exchange) =>
      (await fetchNasdaqScreenerCompanies(exchange))
        .filter((row) => isTradableCompany(row, row.marketCapUsd))
        .sort((a, b) => b.marketCapUsd - a.marketCapUsd)
        .slice(0, limit),
    ),
  );
  return batches.flat().sort((a, b) => b.marketCapUsd - a.marketCapUsd);
}

export async function ingestNasdaqTopCompanies(
  db: Queryable,
  limit = 500,
  log: (message: string) => void = () => {},
): Promise<NasdaqIngestSummary> {
  const [companies, usdKrw] = await Promise.all([fetchNasdaqTopCompanies(limit), fetchUsdKrwRate()]);
  const now = nowIso();
  let upserted = 0;

  if (companies.length === 0) throw new Error("Nasdaq screener selected 0 companies");

  await query("UPDATE companies SET active = 0, updated_at = $1 WHERE source = 'nasdaq'", [now], db);

  for (const c of companies) {
    const sector = classifyNasdaqSector(c.sector, c.industry);
    const corpCode = `${c.exchange}:${c.symbol}`;
    await query(
      `INSERT INTO companies
         (corp_code, stock_code, name, name_eng, market, sector, sector_code, sector_name,
          industry_code, is_financial, market_cap, price, fluctuation_rate, per, pbr, fper,
          eps, feps, bps, dps, dividend_yield, has_consensus, cover_securities,
          target_price_avg, target_return_rate, currency, country, active, source, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, 0, NULL,
          NULL, NULL, 'USD', $14, 1, 'nasdaq', $15, $15)
       ON CONFLICT(corp_code) DO UPDATE SET
          stock_code = excluded.stock_code,
          name = excluded.name,
          name_eng = excluded.name_eng,
          market = excluded.market,
          sector = excluded.sector,
          sector_code = excluded.sector_code,
          sector_name = excluded.sector_name,
          industry_code = excluded.industry_code,
          is_financial = excluded.is_financial,
          market_cap = excluded.market_cap,
          price = excluded.price,
          fluctuation_rate = excluded.fluctuation_rate,
          per = NULL,
          pbr = NULL,
          fper = NULL,
          eps = NULL,
          feps = NULL,
          bps = NULL,
          dps = NULL,
          dividend_yield = NULL,
          has_consensus = 0,
          cover_securities = NULL,
          target_price_avg = NULL,
          target_return_rate = NULL,
          currency = 'USD',
          country = excluded.country,
          active = 1,
          source = 'nasdaq',
          updated_at = excluded.updated_at`,
      [
        corpCode,
        c.symbol,
        c.name,
        c.name,
        c.exchange,
        c.industry ?? c.sector ?? null,
        sector.code,
        sector.name,
        c.sector ?? null,
        sector.code === "financials" ? 1 : 0,
        Math.round(c.marketCapUsd * usdKrw),
        c.priceUsd,
        c.pctChange,
        c.country,
        now,
      ],
      db,
    );
    upserted++;
  }

  log(`US-listed TOP${limit}/exchange 수집 완료 — selected=${companies.length} upserted=${upserted} usdKrw=${usdKrw}\n`);
  return { fetched: companies.length, selected: companies.length, upserted, usdKrw };
}
