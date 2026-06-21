export const ESTIMATE_PROVIDERS = ["fnguide", "wisereport"] as const;
export type EstimateProvider = (typeof ESTIMATE_PROVIDERS)[number];

export const DEFAULT_ESTIMATE_PROVIDER: EstimateProvider = "fnguide";

export const ESTIMATE_PROVIDER_LABEL: Record<EstimateProvider, string> = {
  fnguide: "FnGuide",
  wisereport: "WiseReport",
};
const GLOBAL_ESTIMATE_FALLBACKS = ["yahoo", "fmp", "seekingalpha"] as const;

export function normalizeEstimateProvider(raw: string | null | undefined): EstimateProvider {
  return ESTIMATE_PROVIDERS.includes(raw as EstimateProvider)
    ? (raw as EstimateProvider)
    : DEFAULT_ESTIMATE_PROVIDER;
}

export function estimateProviderOrder(provider: string | null | undefined): string[] {
  const first = normalizeEstimateProvider(provider);
  return [first, ...ESTIMATE_PROVIDERS.filter((p) => p !== first), ...GLOBAL_ESTIMATE_FALLBACKS];
}
