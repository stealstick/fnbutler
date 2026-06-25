import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { all, nowIso, query, tx, type Queryable } from "./db";
import { fetchUsdKrwRate } from "./nasdaq";

const SEEKING_ALPHA_BASE = "https://seekingalpha.com/api/v3";
const DEFAULT_LIMIT = 500;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_CALL_DELAY_MS = 60_000;
const ESTIMATE_SOURCE = "seekingalpha:symbol_data_estimates";
const QUARTERLY_RELATIVE_PERIODS = [-4, -3, -2, -1, 0, 1, 2];
const ANNUAL_RELATIVE_PERIODS = [-1, 0, 1, 2, 3];

const SEEKING_ALPHA_HEADERS: Record<string, string> = {
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9,ko;q=0.8",
  "user-agent":
    process.env.SEEKING_ALPHA_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  referer: "https://seekingalpha.com/",
};
if (process.env.SEEKING_ALPHA_COOKIE) SEEKING_ALPHA_HEADERS.cookie = process.env.SEEKING_ALPHA_COOKIE;
const execFileAsync = promisify(execFile);
let preferCurl = process.env.SEEKING_ALPHA_USE_CURL === "1";

type NasdaqCandidate = {
  corp_code: string;
  stock_code: string;
};

type SeekingAlphaSymbolData = {
  data?: Array<{
    id?: string;
    tickerId?: number | string | null;
    attributes?: {
      estimateEps?: number | string | null;
      dilutedEpsExclExtraItmes?: number | string | null;
    };
  }>;
};

type EstimateItem =
  | "revenue_consensus_mean"
  | "revenue_actual"
  | "eps_normalized_consensus_mean"
  | "eps_normalized_actual";

type SeekingAlphaPeriod = {
  periodtypeid?: "annual" | "quarterly" | string;
  fiscalquarter?: number | string | null;
  fiscalyear?: number | string | null;
  periodenddate?: string | null;
};

type SeekingAlphaEstimateRow = {
  dataitemvalue?: number | string | null;
  effectivedate?: string | null;
  period?: SeekingAlphaPeriod | null;
};

type SeekingAlphaEstimates = {
  estimates?: Record<string, Partial<Record<EstimateItem, Record<string, SeekingAlphaEstimateRow[]>>>>;
};

type ParsedEstimate = {
  fiscalYear: number;
  quarter: number;
  periodType: "Q" | "A";
  value: number;
  dateLabel: string;
};

export interface SeekingAlphaNasdaqBackfillOptions {
  limit?: number;
  corpCode?: string;
  symbol?: string;
  batchSize?: number;
  callDelayMs?: number;
  overwriteEstimates?: boolean;
  currentYear?: number;
  log?: (message: string) => void;
}

export interface SeekingAlphaNasdaqBackfillSummary {
  targeted: number;
  mapped: number;
  ok: number;
  fail: number;
  writes: number;
  financialWrites: number;
  usdKrw: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toNum(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isBlockError(e: unknown): boolean {
  return /Seeking Alpha HTTP 403|captcha|PXxgCxM9By|PerimeterX/i.test((e as Error).message);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function dateLabel(row: SeekingAlphaEstimateRow, fallback: string): string {
  return row.period?.periodenddate?.slice(0, 10) || row.effectivedate?.slice(0, 10) || fallback;
}

function parseEstimateRow(row: SeekingAlphaEstimateRow, periodType: "Q" | "A"): ParsedEstimate | null {
  const value = toNum(row.dataitemvalue);
  const fiscalYear = toNum(row.period?.fiscalyear);
  const fiscalQuarter = toNum(row.period?.fiscalquarter);
  if (value == null || fiscalYear == null) return null;
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900) return null;

  if (periodType === "A") {
    return {
      fiscalYear,
      quarter: 0,
      periodType,
      value,
      dateLabel: dateLabel(row, String(fiscalYear)),
    };
  }

  if (fiscalQuarter == null || !Number.isInteger(fiscalQuarter) || fiscalQuarter < 1 || fiscalQuarter > 4) return null;
  return {
    fiscalYear,
    quarter: fiscalQuarter,
    periodType,
    value,
    dateLabel: dateLabel(row, `${fiscalYear}.${fiscalQuarter}Q`),
  };
}

function rowsFor(
  payload: SeekingAlphaEstimates,
  tickerId: number,
  item: EstimateItem,
  periodType: "Q" | "A",
): ParsedEstimate[] {
  const groups = payload.estimates?.[String(tickerId)]?.[item] ?? {};
  return Object.values(groups)
    .flat()
    .map((row) => parseEstimateRow(row, periodType))
    .filter((row): row is ParsedEstimate => !!row)
    .sort((a, b) => a.fiscalYear - b.fiscalYear || a.quarter - b.quarter);
}

async function fetchJson<T>(url: URL, retries = 2): Promise<T> {
  if (preferCurl) return fetchJsonWithCurl<T>(url);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: SEEKING_ALPHA_HEADERS });
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Seeking Alpha non-JSON response: ${text.slice(0, 120)}`);
      }
    }
    if (res.status === 403) {
      preferCurl = true;
      return fetchJsonWithCurl<T>(url);
    }
    const msg = text.trim().replace(/\s+/g, " ").slice(0, 180);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(res.status === 429 ? 30_000 : 3_000 * (attempt + 1));
      continue;
    }
    throw new Error(`Seeking Alpha HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
  }
}

async function fetchJsonWithCurl<T>(url: URL): Promise<T> {
  const marker = "\n__SA_HTTP_STATUS__:";
  const args = ["-sS", "-L", "--max-time", "45", "-w", `${marker}%{http_code}`];
  for (const [k, v] of Object.entries(SEEKING_ALPHA_HEADERS)) args.push("-H", `${k}: ${v}`);
  args.push(url.toString());

  let stdout = "";
  try {
    const result = await execFileAsync("curl", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    throw new Error(`Seeking Alpha curl failed: ${(err.stderr || err.message).trim()}`);
  }

  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) throw new Error(`Seeking Alpha curl missing status: ${stdout.slice(0, 120)}`);
  const body = stdout.slice(0, markerIndex);
  const status = Number(stdout.slice(markerIndex + marker.length).trim());
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const msg = body.trim().replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`Seeking Alpha HTTP ${status}${msg ? `: ${msg}` : ""}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Seeking Alpha curl non-JSON response: ${body.slice(0, 120)}`);
  }
}

async function fetchSymbolData(symbols: string[]): Promise<Map<string, number>> {
  const url = new URL(`${SEEKING_ALPHA_BASE}/symbol_data`);
  url.searchParams.append("fields[]", "estimateEps");
  url.searchParams.append("fields[]", "dilutedEpsExclExtraItmes");
  url.searchParams.set("slugs", symbols.join(","));
  const json = await fetchJson<SeekingAlphaSymbolData>(url);
  const out = new Map<string, number>();
  for (const row of json.data ?? []) {
    const symbol = String(row.id ?? "").toUpperCase();
    const tickerId = toNum(row.tickerId);
    if (symbol && tickerId != null) out.set(symbol, tickerId);
  }
  return out;
}

async function fetchEstimates(
  tickerIds: number[],
  periodType: "annual" | "quarterly",
  relativePeriods: number[],
): Promise<SeekingAlphaEstimates> {
  const url = new URL(`${SEEKING_ALPHA_BASE}/symbol_data/estimates`);
  url.searchParams.set(
    "estimates_data_items",
    "revenue_consensus_mean,revenue_actual,eps_normalized_consensus_mean,eps_normalized_actual",
  );
  url.searchParams.set("period_type", periodType);
  url.searchParams.set("relative_periods", relativePeriods.join(","));
  url.searchParams.set("ticker_ids", tickerIds.join(","));
  return fetchJson<SeekingAlphaEstimates>(url);
}

async function candidates(
  db: Queryable,
  limit: number,
  options: Pick<SeekingAlphaNasdaqBackfillOptions, "corpCode" | "symbol">,
): Promise<NasdaqCandidate[]> {
  const where = ["active = 1", "source = 'nasdaq'"];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (options.corpCode) where.push(`corp_code = ${push(options.corpCode)}`);
  if (options.symbol) where.push(`stock_code = ${push(options.symbol.toUpperCase())}`);
  params.push(limit);
  return all<NasdaqCandidate>(
    `SELECT corp_code, stock_code
     FROM companies
     WHERE ${where.join(" AND ")}
     ORDER BY seekingalpha_estimates_at ASC NULLS FIRST, market_cap DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
    db,
  );
}

async function insertFinancial(
  db: Queryable,
  c: NasdaqCandidate,
  metric: "REVENUE" | "EPS",
  parsed: ParsedEstimate,
  isEstimate: boolean,
  usdKrw: number,
  overwriteEstimates: boolean,
): Promise<number> {
  const storedValue = metric === "EPS" ? parsed.value : Math.round(parsed.value * usdKrw);
  const conflict =
    !isEstimate || overwriteEstimates
      ? `DO UPDATE SET value = excluded.value, raw_label = excluded.raw_label,
                       date_label = excluded.date_label, source = excluded.source`
      : "DO NOTHING";
  const res = await query(
    `INSERT INTO financials
       (corp_code, metric, raw_label, fiscal_year, quarter, period_type, value, is_estimate, date_label, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(corp_code, metric, fiscal_year, quarter, period_type, is_estimate, source)
     ${conflict}`,
    [
      c.corp_code,
      metric,
      `Seeking Alpha ${metric === "REVENUE" ? "Revenue" : "EPS"} ${isEstimate ? "Consensus Mean" : "Actual"}`,
      parsed.fiscalYear,
      parsed.quarter,
      parsed.periodType,
      storedValue,
      isEstimate ? 1 : 0,
      parsed.dateLabel,
      ESTIMATE_SOURCE,
    ],
    db,
  );
  return res.rowCount ?? 0;
}

async function upsertSeekingAlphaRows(
  db: Queryable,
  c: NasdaqCandidate,
  tickerId: number,
  quarterly: SeekingAlphaEstimates,
  annual: SeekingAlphaEstimates,
  usdKrw: number,
  options: Required<Pick<SeekingAlphaNasdaqBackfillOptions, "overwriteEstimates" | "currentYear">>,
): Promise<{ writes: number; financialWrites: number }> {
  const now = nowIso();
  let financialWrites = 0;

  const dataSets: Array<{
    metric: "REVENUE" | "EPS";
    rows: ParsedEstimate[];
    isEstimate: boolean;
  }> = [
    { metric: "REVENUE", rows: rowsFor(quarterly, tickerId, "revenue_actual", "Q"), isEstimate: false },
    { metric: "EPS", rows: rowsFor(quarterly, tickerId, "eps_normalized_actual", "Q"), isEstimate: false },
    { metric: "REVENUE", rows: rowsFor(quarterly, tickerId, "revenue_consensus_mean", "Q"), isEstimate: true },
    { metric: "EPS", rows: rowsFor(quarterly, tickerId, "eps_normalized_consensus_mean", "Q"), isEstimate: true },
    { metric: "REVENUE", rows: rowsFor(annual, tickerId, "revenue_actual", "A"), isEstimate: false },
    { metric: "EPS", rows: rowsFor(annual, tickerId, "eps_normalized_actual", "A"), isEstimate: false },
    { metric: "REVENUE", rows: rowsFor(annual, tickerId, "revenue_consensus_mean", "A"), isEstimate: true },
    { metric: "EPS", rows: rowsFor(annual, tickerId, "eps_normalized_consensus_mean", "A"), isEstimate: true },
  ];

  for (const dataSet of dataSets) {
    for (const row of dataSet.rows) {
      financialWrites += await insertFinancial(
        db,
        c,
        dataSet.metric,
        row,
        dataSet.isEstimate,
        usdKrw,
        options.overwriteEstimates,
      );
    }
  }

  const annualEps = rowsFor(annual, tickerId, "eps_normalized_consensus_mean", "A");
  const currentAnnual = annualEps.find((row) => row.fiscalYear >= options.currentYear) ?? annualEps[annualEps.length - 1];
  const nextAnnual = currentAnnual ? annualEps.find((row) => row.fiscalYear > currentAnnual.fiscalYear) : undefined;
  const hasConsensus = financialWrites > 0 || annualEps.length > 0;

  const res = await query(
    `UPDATE companies SET
       eps = CASE
         WHEN $1::double precision IS NULL THEN eps
         WHEN $3::boolean THEN $1::double precision
         ELSE COALESCE(eps, $1::double precision)
       END,
       feps = CASE
         WHEN $2::double precision IS NULL THEN feps
         WHEN $3::boolean THEN $2::double precision
         ELSE COALESCE(feps, $2::double precision)
       END,
       has_consensus = CASE WHEN $4::boolean THEN 1 ELSE has_consensus END,
       seekingalpha_estimates_at = $5,
       updated_at = $5
     WHERE corp_code = $6`,
    [
      currentAnnual?.value ?? null,
      nextAnnual?.value ?? null,
      options.overwriteEstimates,
      hasConsensus,
      now,
      c.corp_code,
    ],
    db,
  );

  return { writes: financialWrites + (res.rowCount ?? 0), financialWrites };
}

export async function backfillSeekingAlphaNasdaqEstimates(
  db: Queryable,
  options: SeekingAlphaNasdaqBackfillOptions = {},
): Promise<SeekingAlphaNasdaqBackfillSummary> {
  const limit = Math.max(0, Math.floor(options.limit ?? Number(process.env.SEEKING_ALPHA_NASDAQ_LIMIT || DEFAULT_LIMIT)));
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? Number(process.env.SEEKING_ALPHA_BATCH_SIZE || DEFAULT_BATCH_SIZE)));
  const callDelayMs = Math.max(
    0,
    Math.floor(options.callDelayMs ?? Number(process.env.SEEKING_ALPHA_CALL_DELAY_MS || DEFAULT_CALL_DELAY_MS)),
  );
  const overwriteEstimates = options.overwriteEstimates ?? false;
  const currentYear = options.currentYear ?? new Date().getFullYear();
  const log = options.log ?? (() => {});
  const [targets, usdKrw] = await Promise.all([candidates(db, limit, options), fetchUsdKrwRate()]);

  let mapped = 0;
  let ok = 0;
  let fail = 0;
  let writes = 0;
  let financialWrites = 0;

  for (const [batchIndex, batch] of chunks(targets, batchSize).entries()) {
    const symbols = batch.map((c) => c.stock_code.toUpperCase());
    try {
      const idBySymbol = await fetchSymbolData(symbols);
      const mappedBatch = batch
        .map((c) => ({ c, tickerId: idBySymbol.get(c.stock_code.toUpperCase()) }))
        .filter((row): row is { c: NasdaqCandidate; tickerId: number } => row.tickerId != null);
      mapped += mappedBatch.length;

      if (mappedBatch.length === 0) {
        fail += batch.length;
        log(`  seekingalpha batch ${batchIndex + 1} no ticker ids for ${symbols.join(",")}\n`);
        continue;
      }

      const tickerIds = [...new Set(mappedBatch.map((row) => row.tickerId))];
      const [quarterly, annual] = await Promise.all([
        fetchEstimates(tickerIds, "quarterly", QUARTERLY_RELATIVE_PERIODS),
        fetchEstimates(tickerIds, "annual", ANNUAL_RELATIVE_PERIODS),
      ]);

      for (const { c, tickerId } of mappedBatch) {
        const result = await tx((client) =>
          upsertSeekingAlphaRows(client, c, tickerId, quarterly, annual, usdKrw, { overwriteEstimates, currentYear }),
        );
        ok++;
        writes += result.writes;
        financialWrites += result.financialWrites;
        log(`  seekingalpha ${c.stock_code} ok writes=${result.writes}\n`);
      }

      const missing = batch.length - mappedBatch.length;
      if (missing > 0) {
        fail += missing;
        const missingSymbols = symbols.filter((symbol) => !idBySymbol.has(symbol));
        log(`  seekingalpha missing ticker ids: ${missingSymbols.join(",")}\n`);
      }
    } catch (e) {
      if (isBlockError(e)) {
        fail += targets.length - batchIndex * batchSize;
        log(`  seekingalpha batch ${batchIndex + 1} BLOCKED ${(e as Error).message}; stop run\n`);
        break;
      }
      fail += batch.length;
      log(`  seekingalpha batch ${batchIndex + 1} ERROR ${(e as Error).message}\n`);
    } finally {
      if (callDelayMs > 0) await sleep(callDelayMs);
    }
  }

  return { targeted: targets.length, mapped, ok, fail, writes, financialWrites, usdKrw };
}
