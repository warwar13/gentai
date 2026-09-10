import test from "node:test";
import assert from "node:assert/strict";
import {
  FrameStream,
  READ_COMMAND,
  buildReadQuery,
  decodeBatteryInfo,
  decodeCellVoltages,
  decodeRunningStatus,
  mergeTelemetry,
  parseFrame,
} from "../protocol.js";

function responseFrame(command, payload) {
  const body = Uint8Array.of(command, payload.length, ...payload);
  const checksum = [...body].reduce((sum, byte) => sum + byte, 0) & 0xffff;
  return Uint8Array.of(0xaa, ...body, checksum & 0xff, checksum >> 8);
}

function setInt32(bytes, offset, value) {
  new DataView(bytes.buffer).setInt32(offset, value, true);
}

test("builds only the documented read-only query frames", () => {
  assert.deepEqual([...buildReadQuery(READ_COMMAND.BATTERY_INFO)], [0xaa, 0x21, 0x00, 0x21, 0x00]);
  assert.throws(() => buildReadQuery(0x50), /Blocked non-read BMS command/);
  assert.throws(() => buildReadQuery(0x51), /Blocked non-read BMS command/);
  assert.throws(() => buildReadQuery(0x66), /Blocked non-read BMS command/);
});

test("parses and validates a response checksum", () => {
  const frame = responseFrame(0x10, Uint8Array.from([71, 101, 110, 116, 97, 105]));
  assert.equal(parseFrame(frame).command, 0x10);
  frame[3] ^= 1;
  assert.throws(() => parseFrame(frame), /checksum/);
});

test("reassembles notifications split at arbitrary BLE boundaries", () => {
  const frame = responseFrame(0x22, Uint8Array.from({ length: 48 }, (_, index) => index));
  const stream = new FrameStream();
  assert.deepEqual(stream.push(frame.slice(0, 7)), []);
  assert.deepEqual(stream.push(frame.slice(7, 20)), []);
  const completed = stream.push(frame.slice(20));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.length, 48);
});

test("decodes signed discharge current and core battery information", () => {
  const payload = new Uint8Array(26);
  setInt32(payload, 0, 13_247);
  setInt32(payload, 4, -12_500);
  payload[8] = 64;
  payload[9] = 98;
  setInt32(payload, 10, 64_000);
  setInt32(payload, 14, 100_000);
  new DataView(payload.buffer).setUint16(18, 42, true);
  payload.set([24, 25, 24, 25, 23, 31], 20);
  const info = decodeBatteryInfo(payload);
  assert.equal(info.voltageV, 13.247);
  assert.equal(info.currentA, -12.5);
  assert.equal(info.remainingAh, 64);
  assert.equal(info.cycles, 42);
});

test("decodes cell values and warning flags", () => {
  const cells = new Uint8Array(48);
  const view = new DataView(cells.buffer);
  [3310, 3308, 3312, 3309].forEach((millivolts, index) => view.setUint16(index * 2, millivolts, true));
  assert.deepEqual(decodeCellVoltages(cells), [3.31, 3.308, 3.312, 3.309]);

  const status = new Uint8Array(15);
  new DataView(status.buffer).setUint32(4, 0x00000081, true);
  const decoded = decodeRunningStatus(status);
  assert.equal(decoded.chargeFetOn, true);
  assert.deepEqual(decoded.warnings, ["Charge overcurrent protection"]);
});

test("derives discharge power, cell spread, and runtime", () => {
  const telemetry = mergeTelemetry({
    info: {
      voltageV: 12.8,
      currentA: -10,
      socPct: 50,
      sohPct: 99,
      remainingAh: 50,
      fullAh: 100,
      cycles: 10,
      temperaturesC: { probes: [20, 20, 20, 20], ambient: 20, mos: 25 },
    },
    cellsV: [3.2, 3.21, 3.19, 3.2],
  });
  assert.equal(telemetry.powerW, -128);
  assert.equal(telemetry.mode, "discharging");
  assert.equal(Math.round(telemetry.cellDeltaV * 1000), 20);
  assert.equal(telemetry.estimate.hours, 5);
});
