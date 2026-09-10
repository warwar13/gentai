import test from "node:test";
import assert from "node:assert/strict";
import { analyseHistory, findPeakUsageWindow, historyToCsv } from "../storage.js";

test("calculates daily usage and records the 20 percent crossing", () => {
  const now = new Date(2026, 8, 10, 12, 0, 0);
  const start = new Date(2026, 8, 10, 8, 0, 0).getTime();
  const samples = [
    { timestamp: start, socPct: 22, currentA: -10, powerW: -128 },
    { timestamp: start + 60_000, socPct: 21, currentA: -10, powerW: -128 },
    { timestamp: start + 120_000, socPct: 20, currentA: -10, powerW: -128 },
  ];
  const result = analyseHistory(samples, now);
  assert.equal(result.twentyPercentAt, start + 120_000);
  assert.ok(Math.abs(result.dischargedAh - 1 / 3) < 0.0001);
  assert.ok(Math.abs(result.dischargedWh - 4.2666667) < 0.0001);
  assert.equal(result.netSocChangePct, -2);
});

test("does not invent consumption across history gaps", () => {
  const now = new Date(2026, 8, 10, 12, 0, 0);
  const start = new Date(2026, 8, 10, 8, 0, 0).getTime();
  const result = analyseHistory([
    { timestamp: start, socPct: 90, currentA: -50, powerW: -640 },
    { timestamp: start + 60 * 60_000, socPct: 50, currentA: -50, powerW: -640 },
  ], now);
  assert.equal(result.dischargedAh, 0);
  assert.equal(result.dischargedWh, 0);
});

test("does not report a 15-minute peak across disconnected gaps", () => {
  const start = Date.now() - 30 * 60_000;
  const samples = [
    { timestamp: start, powerW: -500 },
    { timestamp: start + 12 * 60_000, powerW: -500 },
  ];
  assert.equal(findPeakUsageWindow(samples, 15 * 60_000), null);
});

test("exports ISO timestamps and cell values as CSV", () => {
  const csv = historyToCsv([{
    timestamp: Date.UTC(2026, 8, 10, 0, 0, 0),
    socPct: 55,
    sohPct: 98,
    voltageV: 13.1,
    currentA: -2,
    powerW: -26.2,
    remainingAh: 55,
    fullAh: 100,
    ambientC: 24,
    mosC: 28,
    cellsV: [3.275, 3.274, 3.276, 3.275],
    warningCount: 0,
  }]);
  assert.match(csv, /2026-09-10T00:00:00.000Z/);
  assert.match(csv, /3.275,3.274,3.276,3.275/);
});
