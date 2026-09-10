export const GENTAI_BLE = Object.freeze({
  namePrefixes: Object.freeze(["DCHE", "BMC1_"]),
  service: "00000001-0000-1000-8000-00805f9b34fb",
  writeCharacteristic: "00000002-0000-1000-8000-00805f9b34fb",
  notifyCharacteristic: "00000003-0000-1000-8000-00805f9b34fb",
});

export const READ_COMMAND = Object.freeze({
  HANDSHAKE: 0x00,
  MANUFACTURER: 0x10,
  PACK_NAME: 0x11,
  RUNNING_STATUS: 0x20,
  BATTERY_INFO: 0x21,
  CELL_VOLTAGES: 0x22,
  FIRMWARE: 0xf5,
});

const ALLOWED_READ_COMMANDS = new Set(Object.values(READ_COMMAND));

export function checksum16(bytes) {
  return bytes.reduce((sum, byte) => (sum + byte) & 0xffff, 0);
}

/**
 * Builds only zero-payload telemetry queries. Control/configuration frames cannot
 * be expressed through this function, which is the app's sole BLE write path.
 */
export function buildReadQuery(command) {
  if (!Number.isInteger(command) || !ALLOWED_READ_COMMANDS.has(command)) {
    throw new Error(`Blocked non-read BMS command: 0x${Number(command).toString(16)}`);
  }

  const checksum = command;
  return Uint8Array.of(0xaa, command, 0x00, checksum & 0xff, checksum >> 8);
}

export function parseFrame(input) {
  const bytes = toBytes(input);
  if (bytes.length < 5) throw new Error("Truncated BMS frame");
  if (bytes[0] !== 0xaa) throw new Error("Invalid BMS frame marker");

  const payloadLength = bytes[2];
  const expectedLength = payloadLength + 5;
  if (bytes.length !== expectedLength) {
    throw new Error(`Invalid BMS frame length: expected ${expectedLength}, received ${bytes.length}`);
  }

  const payloadEnd = 3 + payloadLength;
  const actualChecksum = bytes[payloadEnd] | (bytes[payloadEnd + 1] << 8);
  const expectedChecksum = checksum16([...bytes.slice(1, payloadEnd)]);
  if (actualChecksum !== expectedChecksum) throw new Error("Invalid BMS frame checksum");

  return {
    command: bytes[1],
    payload: bytes.slice(3, payloadEnd),
    raw: bytes,
  };
}

export class FrameStream {
  constructor({ maxFrameSize = 512, onError = () => {} } = {}) {
    this.buffer = [];
    this.maxFrameSize = maxFrameSize;
    this.onError = onError;
  }

  reset() {
    this.buffer.length = 0;
  }

  push(chunk) {
    this.buffer.push(...toBytes(chunk));
    const frames = [];

    while (this.buffer.length) {
      const marker = this.buffer.indexOf(0xaa);
      if (marker === -1) {
        this.onError(new Error("Discarded notification without a BMS frame marker"));
        this.buffer.length = 0;
        break;
      }
      if (marker > 0) {
        this.onError(new Error(`Discarded ${marker} byte(s) before a BMS frame`));
        this.buffer.splice(0, marker);
      }
      if (this.buffer.length < 3) break;

      const expectedLength = this.buffer[2] + 5;
      if (expectedLength > this.maxFrameSize) {
        this.onError(new Error(`Rejected oversized BMS frame (${expectedLength} bytes)`));
        this.buffer.shift();
        continue;
      }
      if (this.buffer.length < expectedLength) break;

      const candidate = Uint8Array.from(this.buffer.splice(0, expectedLength));
      try {
        frames.push(parseFrame(candidate));
      } catch (error) {
        this.onError(error);
      }
    }

    return frames;
  }
}

export function decodeIdentity(payload) {
  return new TextDecoder()
    .decode(toBytes(payload))
    .replace(/\0/g, "")
    .trim();
}

export function decodeBatteryInfo(payload) {
  const bytes = toBytes(payload);
  if (bytes.length < 26) throw new Error("Battery-info response is too short");
  const view = dataView(bytes);

  const info = {
    voltageV: view.getInt32(0, true) / 1000,
    currentA: view.getInt32(4, true) / 1000,
    socPct: view.getUint8(8),
    sohPct: view.getUint8(9),
    remainingAh: view.getInt32(10, true) / 1000,
    fullAh: view.getInt32(14, true) / 1000,
    cycles: view.getUint16(18, true),
    temperaturesC: {
      probes: [20, 21, 22, 23].map((offset) => decodeTemperature(view.getUint8(offset))),
      ambient: decodeTemperature(view.getUint8(24)),
      mos: decodeTemperature(view.getUint8(25)),
    },
  };

  if (!isPlausibleBatteryInfo(info)) throw new Error("Battery-info values are outside safe validation limits");
  return info;
}

const STATUS_FLAGS = Object.freeze([
  "Charge overcurrent protection",
  "Charge over-temperature protection",
  "Charge under-temperature protection",
  "Cell overvoltage protection",
  "Pack overvoltage protection",
  "AFE error",
  "Charging stopped",
  "Charge FET on",
  "Charge overcurrent warning",
  "Charge over-temperature warning",
  "Charge under-temperature warning",
  "Cell overvoltage warning",
  "Pack overvoltage warning",
  "Cell voltage-difference warning",
  "Cell voltage difference too large",
  "Heating active",
  "Discharge overcurrent protection",
  "Discharge over-temperature protection",
  "Discharge under-temperature protection",
  "Cell undervoltage protection",
  "Short-circuit protection",
  "Pack undervoltage protection",
  "Discharging stopped",
  "Discharge FET on",
  "Discharge overcurrent warning",
  "Discharge over-temperature warning",
  "Discharge under-temperature warning",
  "Cell undervoltage warning",
  "Pack undervoltage warning",
  "MOS over-temperature warning",
  "MOS over-temperature protection",
  "Pre-discharge FET on",
]);

const INFORMATIONAL_STATUS_BITS = new Set([7, 15, 23, 31]);

export function decodeRunningStatus(payload) {
  const bytes = toBytes(payload);
  if (bytes.length < 15) throw new Error("Running-status response is too short");
  const view = dataView(bytes);
  const bitfield = view.getUint32(4, true);
  const activeFlags = [];
  const warnings = [];

  STATUS_FLAGS.forEach((label, bit) => {
    if ((bitfield & (2 ** bit)) !== 0) {
      activeFlags.push(label);
      if (!INFORMATIONAL_STATUS_BITS.has(bit)) warnings.push(label);
    }
  });

  return {
    uptime: {
      days: view.getUint16(0, true),
      hours: view.getUint8(2),
      minutes: view.getUint8(3),
    },
    bitfield,
    activeFlags,
    warnings,
    chargeFetOn: Boolean(bitfield & 0x00000080),
    dischargeFetOn: Boolean(bitfield & 0x00800000),
    heating: Boolean(bitfield & 0x00008000),
    balanceMask: view.getUint32(8, true),
    disconnectedCellMask: bytes[12] | (bytes[13] << 8) | (bytes[14] << 16),
  };
}

export function decodeCellVoltages(payload) {
  const bytes = toBytes(payload);
  if (bytes.length < 2 || bytes.length % 2 !== 0) throw new Error("Invalid cell-voltage response length");
  const view = dataView(bytes);
  const cellsV = [];

  for (let offset = 0; offset < bytes.length; offset += 2) {
    const millivolts = view.getUint16(offset, true);
    if (millivolts !== 0) cellsV.push(millivolts / 1000);
  }

  if (!cellsV.length || cellsV.some((voltage) => voltage < 1.5 || voltage > 5)) {
    throw new Error("Cell voltages are outside safe validation limits");
  }
  return cellsV;
}

export function mergeTelemetry({ info, status, cellsV, identity = {}, timestamp = Date.now() }) {
  if (!info) throw new Error("Battery information is required");
  const powerW = info.voltageV * info.currentA;
  const mode = info.currentA > 0.15 ? "charging" : info.currentA < -0.15 ? "discharging" : "idle";
  const cellMinV = cellsV?.length ? Math.min(...cellsV) : null;
  const cellMaxV = cellsV?.length ? Math.max(...cellsV) : null;
  const estimate = estimateRuntime(info);

  return {
    timestamp,
    ...info,
    powerW,
    mode,
    estimate,
    cellsV: cellsV ?? [],
    cellMinV,
    cellMaxV,
    cellDeltaV: cellMinV === null ? null : cellMaxV - cellMinV,
    status: status ?? null,
    warnings: status?.warnings ?? [],
    identity,
  };
}

export function estimateRuntime(info) {
  if (info.currentA < -0.15 && info.remainingAh >= 0) {
    const hours = info.remainingAh / Math.abs(info.currentA);
    return finiteEstimate("empty", hours);
  }
  if (info.currentA > 0.15 && info.fullAh >= info.remainingAh) {
    const hours = (info.fullAh - info.remainingAh) / info.currentA;
    return finiteEstimate("full", hours);
  }
  return null;
}

export function isPlausibleBatteryInfo(info) {
  return (
    Number.isFinite(info.voltageV) &&
    info.voltageV >= 8 &&
    info.voltageV <= 16.5 &&
    Number.isFinite(info.currentA) &&
    Math.abs(info.currentA) <= 500 &&
    info.socPct >= 0 &&
    info.socPct <= 100 &&
    info.sohPct >= 0 &&
    info.sohPct <= 100 &&
    info.remainingAh >= 0 &&
    info.remainingAh <= 500 &&
    info.fullAh > 0 &&
    info.fullAh <= 500
  );
}

function finiteEstimate(direction, hours) {
  if (!Number.isFinite(hours) || hours < 0 || hours > 10_000) return null;
  return { direction, hours, at: Date.now() + hours * 3_600_000 };
}

function decodeTemperature(raw) {
  return raw > 127 ? raw - 256 : raw;
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof DataView) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new TypeError("Expected byte data");
}
