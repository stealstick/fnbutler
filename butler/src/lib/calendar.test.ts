import assert from "node:assert/strict";
import test from "node:test";
import { buildNasdaqMacroEvent } from "./calendar";

test("coalesces Nasdaq macro rows with the same date/time/name", () => {
  const event = buildNasdaqMacroEvent(
    "US",
    "2026-07-01",
    [
      {
        gmt: "09:00",
        country: "United States",
        eventName: "House Price Index",
        actual: "&nbsp;",
        consensus: " ",
        previous: "0.1%",
      },
      {
        gmt: "09:00",
        country: "United States",
        eventName: "House Price Index",
        actual: "&nbsp;",
        consensus: " ",
        previous: "1.7%",
      },
      {
        gmt: "09:00",
        country: "United States",
        eventName: "House Price Index",
        actual: "&nbsp;",
        consensus: " ",
        previous: "441.5",
      },
    ],
    new Date("2026-06-21T00:00:00Z"),
  );

  assert.ok(event);
  assert.equal(event.title, "House Price Index");
  assert.equal(event.previous, "YoY 1.7% · MoM 0.1% · 지수 441.5");
  assert.equal(event.actual, null);
});

test("keeps released duplicate macro values on one event", () => {
  const event = buildNasdaqMacroEvent(
    "JP",
    "2026-06-19",
    [
      {
        gmt: "19:30",
        country: "Japan",
        eventName: "National CPI",
        actual: "1.5%",
        consensus: " ",
        previous: "1.4%",
      },
      {
        gmt: "19:30",
        country: "Japan",
        eventName: "National CPI",
        actual: "0.4%",
        consensus: " ",
        previous: "0.1%",
      },
    ],
    new Date("2026-06-21T00:00:00Z"),
  );

  assert.ok(event);
  assert.equal(event.title, "National CPI");
  assert.equal(event.previous, "YoY 1.4% · MoM 0.1%");
  assert.equal(event.actual, "YoY 1.5% · MoM 0.4%");
});
