import assert from "node:assert/strict";
import test from "node:test";
import { MAX_COMPARE_CODES, parseCompareCodes } from "./compare-codes";

test("keeps more than ten comparison codes", () => {
  const codes = Array.from({ length: 11 }, (_, i) => `C${String(i + 1).padStart(3, "0")}`);

  assert.deepEqual(parseCompareCodes(codes.join(",")), codes);
});

test("deduplicates comparison codes while preserving order", () => {
  assert.deepEqual(parseCompareCodes("AAPL,NVDA,AAPL,005930,NVDA"), ["AAPL", "NVDA", "005930"]);
});

test("caps comparison codes at the shared maximum", () => {
  const codes = Array.from({ length: MAX_COMPARE_CODES + 5 }, (_, i) => `C${i}`);

  assert.equal(parseCompareCodes(codes.join(",")).length, MAX_COMPARE_CODES);
});
