import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCompanyRouteParam } from "./company-code";

test("decodes Nasdaq route params before company lookup", () => {
  assert.equal(normalizeCompanyRouteParam("NASDAQ%3ANVDA"), "NASDAQ:NVDA");
});

test("keeps already-decoded company codes unchanged", () => {
  assert.equal(normalizeCompanyRouteParam("00126380"), "00126380");
  assert.equal(normalizeCompanyRouteParam("NASDAQ:NVDA"), "NASDAQ:NVDA");
});

test("returns malformed route params unchanged", () => {
  assert.equal(normalizeCompanyRouteParam("NASDAQ%3"), "NASDAQ%3");
});
