import test from "node:test";
import assert from "node:assert/strict";
import {
  analyseCapacityTest,
  analyseHistory,
  analyseRange,
  buildSessions,
  capacityCurvePoints,
  capacityTestToCsv,
  findPeakUsageWindow,
  historyToCsv,
} from "../storage.js";

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

test("separates used and charged energy for detailed analytics", () => {
  const start = new Date(2026, 8, 10, 8, 0, 0).getTime();
  const samples = [
    { timestamp: start, socPct: 50, currentA: -10, powerW: -100 },
    { timestamp: start + 60_000, socPct: 49, currentA: -10, powerW: -100 },
    { timestamp: start + 120_000, socPct: 50, currentA: 10, powerW: 100 },
    { timestamp: start + 180_000, socPct: 51, currentA: 10, powerW: 100 },
  ];
  const result = analyseRange(samples, start, start + 180_000);
  assert.ok(result.usedWh > 1.6);
  assert.ok(result.chargedWh > 1.6);
  assert.equal(result.lowestSocPct, 49);
});

test("builds separate charge and discharge sessions", () => {
  const start = Date.now();
  const sessions = buildSessions([
    { timestamp: start, socPct: 60, currentA: -5, powerW: -64 },
    { timestamp: start + 60_000, socPct: 59, currentA: -5, powerW: -64 },
    { timestamp: start + 120_000, socPct: 59, currentA: 5, powerW: 64 },
    { timestamp: start + 180_000, socPct: 60, currentA: 5, powerW: 64 },
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].mode, "charging");
  assert.equal(sessions[1].mode, "discharging");
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

test("calculates five-second capacity-test Ah and Wh", () => {
  const start = Date.UTC(2026, 8, 12, 0, 0, 0);
  const testRun = { id: "test-1", ratedAh: 100, startedAt: start, endedAt: start + 10_000, startSocPct: 100 };
  const samples = [0, 5_000, 10_000].map((offset, index) => ({
    timestamp: start + offset,
    socPct: index === 2 ? 5 : 100 - index,
    currentA: -10,
    powerW: -128,
  }));
  const result = analyseCapacityTest(testRun, samples, testRun.endedAt);
  assert.ok(Math.abs(result.dischargedAh - 10 / 360) < 0.000001);
  assert.ok(Math.abs(result.dischargedWh - 128 / 360) < 0.000001);
  assert.ok(Math.abs(result.averageVoltageV - 12.8) < 0.000001);
  assert.equal(result.averageW, 128);
  assert.equal(result.coveragePct, 100);
  assert.equal(result.fullRange, true);
});

test("excludes capacity-test gaps and reports charging separately", () => {
  const start = Date.UTC(2026, 8, 12, 0, 0, 0);
  const testRun = { id: "test-2", ratedAh: 100, startedAt: start, endedAt: start + 50_000, startSocPct: 90 };
  const samples = [
    { timestamp: start, socPct: 90, currentA: -10, powerW: -128 },
    { timestamp: start + 40_000, socPct: 89, currentA: -10, powerW: -128 },
    { timestamp: start + 45_000, socPct: 89, currentA: 10, powerW: 128 },
    { timestamp: start + 50_000, socPct: 90, currentA: 10, powerW: 128 },
  ];
  const result = analyseCapacityTest(testRun, samples, testRun.endedAt);
  assert.equal(result.missingMs, 40_000);
  assert.equal(result.observedMs, 10_000);
  assert.equal(result.coveragePct, 20);
  assert.equal(result.hasGaps, true);
  assert.equal(result.hasCharging, true);
  assert.ok(result.dischargedAh > 0);
  assert.ok(result.chargedAh > 0);
  assert.equal(result.fullRange, false);
});

test("flags unmeasured time when a disconnected test is stopped", () => {
  const start = Date.UTC(2026, 8, 12, 0, 0, 0);
  const testRun = {
    id: "test-disconnected",
    ratedAh: 100,
    startedAt: start,
    endedAt: start + 5_000,
    stoppedAt: start + 65_000,
    startSocPct: 100,
  };
  const samples = [
    { timestamp: start, socPct: 100, currentA: -10, powerW: -128 },
    { timestamp: start + 5_000, socPct: 99, currentA: -10, powerW: -128 },
  ];
  const result = analyseCapacityTest(testRun, samples, testRun.stoppedAt);
  assert.equal(result.observedMs, 5_000);
  assert.equal(result.missingMs, 60_000);
  assert.equal(result.hasGaps, true);
  assert.ok(result.coveragePct < 8);
});

test("builds a voltage-versus-capacity curve without bridging gaps", () => {
  const start = Date.UTC(2026, 8, 12, 0, 0, 0);
  const testRun = { id: "test-curve", ratedAh: 100, startedAt: start, endedAt: start + 50_000 };
  const points = capacityCurvePoints(testRun, [
    { timestamp: start, voltageV: 13.2, currentA: -10 },
    { timestamp: start + 5_000, voltageV: 13.1, currentA: -10 },
    { timestamp: start + 50_000, voltageV: 12.8, currentA: -10 },
  ]);
  assert.equal(points.length, 3);
  assert.ok(points[1].capacityAh > 0);
  assert.equal(points[2].capacityAh, points[1].capacityAh);
  assert.equal(points[2].gap, true);
});

test("exports capacity-test metadata and high-frequency samples", () => {
  const startedAt = Date.UTC(2026, 8, 12, 0, 0, 0);
  const testRun = { id: "test-3", ratedAh: 100, startedAt, endedAt: startedAt + 5_000 };
  const csv = capacityTestToCsv(testRun, [{
    testId: testRun.id,
    timestamp: startedAt + 5_000,
    socPct: 99,
    sohPct: 98,
    voltageV: 13.1,
    currentA: -2,
    powerW: -26.2,
    remainingAh: 99,
    fullAh: 100,
    ambientC: 24,
    mosC: 28,
    cellsV: [3.275, 3.274, 3.276, 3.275],
    warningCount: 0,
  }]);
  assert.match(csv, /^test_id,rated_ah,test_started_at,test_ended_at,test_stopped_at,timestamp,elapsed_seconds/);
  assert.match(csv, /test-3,100,2026-09-12T00:00:00.000Z,2026-09-12T00:00:05.000Z,,2026-09-12T00:00:05.000Z,5.0/);
});
