/**
 * butler.works 업스트림 API 클라이언트.
 *
 * - 인증 불필요(공개). CORS '*'. user rate limit 100req/60s 이므로
 *   기본 80req/min 토큰버킷으로 스스로 throttle 한다.
 * - 모든 호출은 브라우저와 동일한 origin/referer 헤더를 붙인다.
 */

export const BUTLER_BASE = process.env.BUTLER_API_BASE || "https://api.butler.works";

const COMMON_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "ko,en-US;q=0.8,en;q=0.7",
  origin: "https://www.butler.works",
  referer: "https://www.butler.works/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

// --- 토큰버킷 throttle (분당 maxPerMin) ---------------------------------------
const MAX_PER_MIN = Number(process.env.BUTLER_RATE_PER_MIN || 80);
let tokens = MAX_PER_MIN;
let lastRefill = Date.now();

function refill() {
  const now = Date.now();
  const add = ((now - lastRefill) / 60000) * MAX_PER_MIN;
  if (add >= 1) {
    tokens = Math.min(MAX_PER_MIN, tokens + add);
    lastRefill = now;
  }
}

async function take() {
  for (;;) {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(750);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ButlerError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`butler ${status} ${url}`);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { retries?: number },
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BUTLER_BASE}${path}`;
  const retries = init?.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    await take();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...COMMON_HEADERS, ...(init?.headers as Record<string, string>) },
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
    if (res.status === 429 || res.status >= 500) {
      // rate limited / transient — back off and retry
      if (attempt < retries) {
        const reset = Number(res.headers.get("x-ratelimit-reset-user")) || 5;
        await sleep(Math.min(reset, 30) * 1000);
        continue;
      }
    }
    const text = await res.text();
    if (!res.ok) throw new ButlerError(res.status, url, text.slice(0, 500));
    return text ? (JSON.parse(text) as T) : (null as T);
  }
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// --- 타입 (필요한 필드만) ----------------------------------------------------
export interface ScreenRow {
  stockCode: string;
  stockName: string;
  corpCode: string;
  price: number;
  fluctuationRate: string;
  marketCap: string;
}

export interface CompanyDetail {
  country: string;
  corpCode: string;
  stockCode: string;
  corpNameEng: string;
  stockName: string;
  corpCls: string; // 'Y'=KOSPI, 'K'=KOSDAQ
  fsDiv: string;
  codeNameKR: string;
  industryCode: string;
  treasuryOutstandingRatio: string | null;
  priceInfo: {
    price: number;
    fluctuationRate: string;
    marketCapital: string;
    per: string;
    pbr: string;
    fper: string;
    eps: number;
    feps: number;
    bps: number;
    dps: number;
    marketDividendYield: string;
  };
  menuOptions: { consensus: boolean; fundamental: boolean };
}

export interface TargetPricesResponse {
  charts: {
    targetPrices: Array<{
      max?: number;
      avg?: number;
      min?: number;
      date: string;
      fullDate: string;
      price?: number;
      coverSecurities?: number;
      returnRatio?: number;
    }>;
    stocksHistories: Array<{ date: string; value?: number }>;
  };
  tables: {
    price: number;
    targetPriceAvg: number;
    returnRate: string;
    coverSecurities: number;
  };
}

export interface ConsensusReportValues {
  date: string;
  analyst: string;
  securitiesCompany: string;
  targetPrice: number;
  priceClose: number;
  rating: string;
  ratingChange: string;
  targetPriceChange: string;
  returnRate: string;
  aiSummary?: string;
}

export interface FeedItem {
  id: number;
  type: "NEWS" | "CONSENSUS" | "DISCLOSURE";
  corpCode: string;
  contents: {
    reportId?: string;
    reportName?: string;
    values?: ConsensusReportValues;
  };
}
export interface FeedResponse {
  nextCursor: string | null;
  hasNext: boolean;
  data: FeedItem[];
}

export interface ReportDetail {
  id: string;
  corpCode: string;
  securitiesCompany: string;
  securitiesCompanyUrl?: string;
  analyst: string;
  date: string;
  title: string;
  targetPrice: number;
  rating: string;
  ratingChange: string;
  targetPriceChange: string;
  priceClose: number;
  returnRate: string;
  aiSummary?: string;
}

type Series = Array<{
  date: string;
  value?: number;
  bsnsYear?: string;
  quarter?: string;
  isEstimate?: boolean;
}>;
type ValSeries = { data?: Array<{ date: string; value?: number }> };

export interface AnalysisSummary {
  fs: {
    isRevenue: Series;
    isOperatingProfitLoss: Series;
    isNetIncome: Series;
    [k: string]: unknown;
  };
  valuations: {
    valPER: ValSeries;
    valPBR: ValSeries;
    [k: string]: unknown;
  };
  consensus: {
    hasReports: boolean;
    hasTargetPrice: boolean;
    targetPrices: TargetPricesResponse["charts"]["targetPrices"];
    consensusRevenueAvg?: Series;
    consensusOperatingProfitLossAvg?: Series;
    [k: string]: unknown;
  };
}

// --- 엔드포인트 --------------------------------------------------------------
export const butler = {
  screenerCount: (filters: unknown[] = []) =>
    post<{ count: number }>("/api/screener/count", { filters }),

  screen: (page: number, size = 50, orderColumn = "marketCap") =>
    post<{ results: ScreenRow[] }>("/api/screener/screen", {
      filters: [],
      orderBy: "DESC",
      orderColumn,
      page,
      size,
    }),

  company: (corpCode: string) => get<CompanyDetail>(`/api/companies/${corpCode}`),

  summary: (corpCode: string, quarterPeriod: "quarter" | "accumulated" = "accumulated") =>
    get<AnalysisSummary>(
      `/api/v2/analysis/summary/${corpCode}?fsDiv=MFS&quarterPeriod=${quarterPeriod}`,
    ),

  targetPrices: (corpCode: string) =>
    get<TargetPricesResponse>(`/api/consensus/target-prices?corpCode=${corpCode}`),

  feed: (corpCode: string, nextCursor = "", limit = 15) =>
    get<FeedResponse>(
      `/api/feed/${corpCode}?limit=${limit}&nextCursor=${encodeURIComponent(nextCursor)}`,
    ),

  reportDetail: (reportId: string) =>
    get<ReportDetail>(`/api/consensus/reports/${reportId}`),

  securitiesCompanies: (corpCode: string) =>
    get<{ data: Array<{ corpName: string }> }>(
      `/api/consensus/securities-companies?corpCode=${corpCode}`,
    ),

  markets: () =>
    get<Record<string, { price: number; fluctuationRate: string; per: string; pbr: string }>>(
      "/api/markets/all",
    ),
};
