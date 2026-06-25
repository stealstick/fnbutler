export const DOMESTIC_ESTIMATE_PROVIDERS = ["fnguide", "wisereport"] as const;
export const GLOBAL_ESTIMATE_PROVIDERS = [
  "stockanalysis:forecast",
  "seekingalpha:symbol_data_estimates",
  "yahoo:earningsTrend",
  "fmp:analyst-estimates",
] as const;
export const ESTIMATE_PROVIDERS = [...DOMESTIC_ESTIMATE_PROVIDERS, ...GLOBAL_ESTIMATE_PROVIDERS] as const;
export type EstimateProvider = (typeof ESTIMATE_PROVIDERS)[number];

export const DEFAULT_ESTIMATE_PROVIDER: EstimateProvider = "fnguide";
export const DEFAULT_GLOBAL_ESTIMATE_PROVIDER: EstimateProvider = "fmp:analyst-estimates";

export const ESTIMATE_PROVIDER_LABEL: Record<EstimateProvider, string> = {
  fnguide: "FnGuide",
  wisereport: "WiseReport",
  "stockanalysis:forecast": "StockAnalysis",
  "seekingalpha:symbol_data_estimates": "Seeking Alpha",
  "yahoo:earningsTrend": "Yahoo",
  "fmp:analyst-estimates": "FMP",
};

export function normalizeEstimateProvider(raw: string | null | undefined): EstimateProvider {
  return ESTIMATE_PROVIDERS.includes(raw as EstimateProvider)
    ? (raw as EstimateProvider)
    : DEFAULT_ESTIMATE_PROVIDER;
}

export function normalizeDomesticEstimateProvider(raw: string | null | undefined): EstimateProvider {
  const provider = normalizeEstimateProvider(raw);
  return DOMESTIC_ESTIMATE_PROVIDERS.includes(provider as (typeof DOMESTIC_ESTIMATE_PROVIDERS)[number])
    ? provider
    : DEFAULT_ESTIMATE_PROVIDER;
}

export function normalizeGlobalEstimateProvider(raw: string | null | undefined): EstimateProvider {
  const provider = normalizeEstimateProvider(raw);
  return GLOBAL_ESTIMATE_PROVIDERS.includes(provider as (typeof GLOBAL_ESTIMATE_PROVIDERS)[number])
    ? provider
    : DEFAULT_GLOBAL_ESTIMATE_PROVIDER;
}

export function estimateProviderOrder(provider: string | null | undefined): string[] {
  return [normalizeEstimateProvider(provider)];
}
