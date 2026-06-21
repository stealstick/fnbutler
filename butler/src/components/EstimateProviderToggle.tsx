"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_ESTIMATE_PROVIDER,
  ESTIMATE_PROVIDER_LABEL,
  ESTIMATE_PROVIDERS,
  normalizeEstimateProvider,
  type EstimateProvider,
} from "@/lib/estimate-provider";

export const ESTIMATE_PROVIDER_STORAGE_KEY = "keystone.estimateProvider";

export function useEstimateProvider(): [EstimateProvider, (provider: EstimateProvider) => void] {
  const [provider, setProviderState] = useState<EstimateProvider>(DEFAULT_ESTIMATE_PROVIDER);

  useEffect(() => {
    try {
      setProviderState(normalizeEstimateProvider(window.localStorage.getItem(ESTIMATE_PROVIDER_STORAGE_KEY)));
    } catch {
      setProviderState(DEFAULT_ESTIMATE_PROVIDER);
    }
  }, []);

  const setProvider = useCallback((next: EstimateProvider) => {
    setProviderState(next);
    try {
      window.localStorage.setItem(ESTIMATE_PROVIDER_STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable in private or restricted contexts.
    }
  }, []);

  return [provider, setProvider];
}

export default function EstimateProviderToggle({
  provider,
  onChange,
}: {
  provider: EstimateProvider;
  onChange: (provider: EstimateProvider) => void;
}) {
  return (
    <span className="estimate-provider">
      <span className="muted" style={{ fontSize: 12 }}>추정치 기준</span>
      <span className="toggle">
        {ESTIMATE_PROVIDERS.map((p) => (
          <button key={p} className={provider === p ? "on" : ""} onClick={() => onChange(p)}>
            {ESTIMATE_PROVIDER_LABEL[p]}
          </button>
        ))}
      </span>
    </span>
  );
}
