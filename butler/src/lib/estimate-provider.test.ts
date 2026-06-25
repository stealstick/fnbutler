import assert from "node:assert/strict";
import test from "node:test";
import { estimateProviderOrder } from "./estimate-provider";

test("uses the selected estimate provider without cross-provider fallback", () => {
  assert.deepEqual(estimateProviderOrder("stockanalysis:forecast"), ["stockanalysis:forecast"]);
});

test("normalizes unknown estimate providers to the domestic default", () => {
  assert.deepEqual(estimateProviderOrder("unknown"), ["fnguide"]);
});
