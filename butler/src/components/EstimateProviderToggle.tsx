"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_ESTIMATE_PROVIDER,
  DEFAULT_GLOBAL_ESTIMATE_PROVIDER,
  DOMESTIC_ESTIMATE_PROVIDERS,
  ESTIMATE_PROVIDER_LABEL,
  normalizeDomesticEstimateProvider,
  normalizeGlobalEstimateProvider,
  type EstimateProvider,
} from "@/lib/estimate-provider";

export const ESTIMATE_PROVIDER_STORAGE_KEY = "keystone.estimateProvider";
export const GLOBAL_ESTIMATE_PROVIDER_STORAGE_KEY = "keystone.globalEstimateProvider";

type EstimateProviderStateOptions = {
  defaultProvider?: EstimateProvider;
  normalize?: (raw: string | null | undefined) => EstimateProvider;
  storageKey?: string;
};

export function useEstimateProvider(options: EstimateProviderStateOptions = {}): [EstimateProvider, (provider: EstimateProvider) => void] {
  const defaultProvider = options.defaultProvider ?? DEFAULT_ESTIMATE_PROVIDER;
  const normalize = options.normalize ?? normalizeDomesticEstimateProvider;
  const storageKey = options.storageKey ?? ESTIMATE_PROVIDER_STORAGE_KEY;
  const [provider, setProviderState] = useState<EstimateProvider>(defaultProvider);

  useEffect(() => {
    try {
      setProviderState(normalize(window.localStorage.getItem(storageKey)));
    } catch {
      setProviderState(defaultProvider);
    }
  }, [defaultProvider, normalize, storageKey]);

  const setProvider = useCallback((next: EstimateProvider) => {
    setProviderState(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // localStorage may be unavailable in private or restricted contexts.
    }
  }, [storageKey]);

  return [provider, setProvider];
}

export function useGlobalEstimateProvider(): [EstimateProvider, (provider: EstimateProvider) => void] {
  return useEstimateProvider({
    defaultProvider: DEFAULT_GLOBAL_ESTIMATE_PROVIDER,
    normalize: normalizeGlobalEstimateProvider,
    storageKey: GLOBAL_ESTIMATE_PROVIDER_STORAGE_KEY,
  });
}

export default function EstimateProviderToggle({
  provider,
  onChange,
  providers = DOMESTIC_ESTIMATE_PROVIDERS,
  label = "추정치 기준",
}: {
  provider: EstimateProvider;
  onChange: (provider: EstimateProvider) => void;
  providers?: readonly EstimateProvider[];
  label?: string;
}) {
  return (
    <span className="estimate-provider">
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
      <span className="toggle">
        {providers.map((p) => (
          <button key={p} className={provider === p ? "on" : ""} onClick={() => onChange(p)}>
            {ESTIMATE_PROVIDER_LABEL[p]}
          </button>
        ))}
      </span>
    </span>
  );
}
