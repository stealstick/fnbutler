import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GLOBAL_ESTIMATE_PROVIDER,
  estimateProviderOrder,
  normalizeDomesticEstimateProvider,
  normalizeGlobalEstimateProvider,
} from "./estimate-provider";

test("uses the selected estimate provider without cross-provider fallback", () => {
  assert.deepEqual(estimateProviderOrder("stockanalysis:forecast"), ["stockanalysis:forecast"]);
});

test("normalizes unknown estimate providers to the domestic default", () => {
  assert.deepEqual(estimateProviderOrder("unknown"), ["fnguide"]);
});

test("defaults global estimates to FMP", () => {
  assert.equal(DEFAULT_GLOBAL_ESTIMATE_PROVIDER, "fmp:analyst-estimates");
  assert.equal(normalizeGlobalEstimateProvider(null), "fmp:analyst-estimates");
  assert.equal(normalizeGlobalEstimateProvider("fnguide"), "fmp:analyst-estimates");
});

test("keeps domestic estimates on domestic providers", () => {
  assert.equal(normalizeDomesticEstimateProvider("wisereport"), "wisereport");
  assert.equal(normalizeDomesticEstimateProvider("fmp:analyst-estimates"), "fnguide");
});
