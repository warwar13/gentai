import test from "node:test";
import assert from "node:assert/strict";
import {
  assessCellBalance,
  assessHealth,
  assessPower,
  assessTemperature,
  gaugeRatio,
  POWER_LIMIT_W,
  socGaugeAngle,
} from "../status.js";

test("grades live power against the configured 600 watt limit", () => {
  assert.equal(POWER_LIMIT_W, 600);
  assert.equal(assessPower(200).state, "good");
  assert.equal(assessPower(400).state, "warning");
  assert.equal(assessPower(550).state, "danger");
  assert.equal(assessPower(600).label, "At limit");
  assert.equal(assessPower(650).label, "Over limit");
});

test("grades health, temperature, and cell balance for glance indicators", () => {
  assert.equal(assessHealth(98).label, "Excellent");
  assert.equal(assessHealth(84).state, "warning");
  assert.equal(assessTemperature(29, "mos").label, "Cool");
  assert.equal(assessTemperature(48, "mos").state, "warning");
  assert.equal(assessTemperature(61, "mos").state, "danger");
  assert.equal(assessCellBalance(0.004).label, "Cells balanced");
  assert.equal(assessCellBalance(0.035).state, "warning");
  assert.equal(assessCellBalance(0.060).state, "danger");
});

test("maps SOC to a complete 360 degree ring", () => {
  assert.equal(socGaugeAngle(0), 0);
  assert.equal(socGaugeAngle(50), 180);
  assert.equal(socGaugeAngle(99), 356.4);
  assert.equal(socGaugeAngle(100), 360);
});

test("normalizes the 4S LiFePO4 voltage gauge and clamps visual overflow", () => {
  assert.equal(gaugeRatio(10, 10, 14.6), 0);
  assert.equal(gaugeRatio(14.6, 10, 14.6), 1);
  assert.equal(gaugeRatio(16, 10, 14.6), 1);
  assert.equal(gaugeRatio(8, 10, 14.6), 0);
});
