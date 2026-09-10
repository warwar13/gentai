import {
  FrameStream,
  GENTAI_BLE,
  READ_COMMAND,
  buildReadQuery,
  decodeBatteryInfo,
  decodeCellVoltages,
  decodeIdentity,
  decodeRunningStatus,
  mergeTelemetry,
} from "./protocol.js";
import { HistoryStore, analyseHistory, historyToCsv, toHistorySample } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const historyStore = new HistoryStore();
const demoMode = new URLSearchParams(location.search).has("demo");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 60_000;

let historySamples = [];
let lastSavedAt = 0;
let latestTelemetry = null;
let selectedDevice = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let allowAutomaticReconnect = true;
let chartMetric = "usage";
let chartRangeHours = 24;
let toastTimer = null;

class ProtocolError extends Error {}

class GentaiBatteryClient {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.device = null;
    this.server = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this.pending = null;
    this.frameStream = new FrameStream({ onError: (error) => this.callbacks.onPacketError(error) });
    this.pollGeneration = 0;
    this.disconnectReason = "unexpected";
    this.identity = {};
    this.lastStatus = null;
    this.lastCells = [];
    this.boundNotification = (event) => this.handleNotification(event);
    this.boundDisconnect = () => this.handleDisconnect();
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.writeCharacteristic && this.notifyCharacteristic);
  }

  async connect(device) {
    if (!device) throw new Error("No battery selected");
    this.pollGeneration += 1;
    this.rejectPending(new Error("Connection restarted"));
    this.frameStream.reset();
    this.disconnectReason = "unexpected";
    this.callbacks.onState("connecting", `Connecting to ${device.name || "battery"}`);

    if (this.device && this.device !== device) {
      this.device.removeEventListener("gattserverdisconnected", this.boundDisconnect);
    }
    this.device = device;
    device.removeEventListener("gattserverdisconnected", this.boundDisconnect);
    device.addEventListener("gattserverdisconnected", this.boundDisconnect);

    this.server = await device.gatt.connect();
    const service = await this.server.getPrimaryService(GENTAI_BLE.service);
    this.writeCharacteristic = await service.getCharacteristic(GENTAI_BLE.writeCharacteristic);
    this.notifyCharacteristic = await service.getCharacteristic(GENTAI_BLE.notifyCharacteristic);
    this.notifyCharacteristic.removeEventListener("characteristicvaluechanged", this.boundNotification);
    this.notifyCharacteristic.addEventListener("characteristicvaluechanged", this.boundNotification);
    await this.notifyCharacteristic.startNotifications();

    await this.queryWithRetry(READ_COMMAND.HANDSHAKE, 4_000);
    this.identity = await this.readIdentity();
    this.callbacks.onIdentity(this.identity);
    this.callbacks.onState("connected", `Connected to ${device.name || "battery"}`);

    const generation = this.pollGeneration;
    this.poll(generation).catch((error) => {
      if (generation !== this.pollGeneration) return;
      const fatal = error instanceof ProtocolError;
      this.disconnectReason = fatal ? "fatal" : "unexpected";
      this.callbacks.onError(error, fatal);
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    });
  }

  async readIdentity() {
    const result = {};
    for (const [key, command] of [
      ["manufacturer", READ_COMMAND.MANUFACTURER],
      ["packName", READ_COMMAND.PACK_NAME],
      ["firmware", READ_COMMAND.FIRMWARE],
    ]) {
      try {
        result[key] = decodeIdentity(await this.queryWithRetry(command, 3_000));
      } catch {
        result[key] = "";
      }
    }
    return result;
  }

  async poll(generation) {
    let cycle = 0;
    while (this.connected && generation === this.pollGeneration) {
      let info;
      try {
        info = decodeBatteryInfo(await this.queryWithRetry(READ_COMMAND.BATTERY_INFO, 4_000));
      } catch (error) {
        if (/outside safe|too short|frame/i.test(error.message)) throw new ProtocolError(error.message);
        throw error;
      }

      try {
        this.lastStatus = decodeRunningStatus(await this.queryWithRetry(READ_COMMAND.RUNNING_STATUS, 4_000));
      } catch (error) {
        if (/response|invalid|outside/i.test(error.message)) throw new ProtocolError(error.message);
        throw error;
      }

      if (cycle % 3 === 0 || !this.lastCells.length) {
        try {
          this.lastCells = decodeCellVoltages(await this.queryWithRetry(READ_COMMAND.CELL_VOLTAGES, 4_000));
        } catch (error) {
          if (/response|invalid|outside/i.test(error.message)) throw new ProtocolError(error.message);
          throw error;
        }
      }

      const telemetry = mergeTelemetry({
        info,
        status: this.lastStatus,
        cellsV: this.lastCells,
        identity: this.identity,
        timestamp: Date.now(),
      });
      this.callbacks.onTelemetry(telemetry);
      cycle += 1;
      await delay(5_000);
    }
  }

  async queryWithRetry(command, timeoutMs) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.query(command, timeoutMs);
      } catch (error) {
        lastError = error;
        if (!this.connected) break;
      }
    }
    throw lastError;
  }

  async query(command, timeoutMs) {
    if (!this.connected) throw new Error("Battery is disconnected");
    if (this.pending) throw new Error("A battery query is already in progress");

    const frame = buildReadQuery(command);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.command === command) this.pending = null;
        reject(new Error(`Battery query 0x${command.toString(16)} timed out`));
      }, timeoutMs);
      this.pending = { command, resolve, reject, timer };
    });

    try {
      // This is the only BLE write call in the application. buildReadQuery()
      // rejects every command except the fixed telemetry-query allowlist.
      if (typeof this.writeCharacteristic.writeValueWithResponse === "function") {
        await this.writeCharacteristic.writeValueWithResponse(frame);
      } else {
        await this.writeCharacteristic.writeValue(frame);
      }
    } catch (error) {
      this.rejectPending(error);
      throw error;
    }

    return response;
  }

  handleNotification(event) {
    const frames = this.frameStream.push(event.target.value);
    frames.forEach((frame) => {
      this.callbacks.onPacket(frame);
      if (!this.pending || this.pending.command !== frame.command) return;
      const { resolve, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      resolve(frame.payload);
    });
  }

  rejectPending(error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }

  disconnect(reason = "manual") {
    this.disconnectReason = reason;
    this.pollGeneration += 1;
    this.rejectPending(new Error("Battery disconnected"));
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.handleDisconnect();
  }

  handleDisconnect() {
    this.pollGeneration += 1;
    this.rejectPending(new Error("Battery disconnected"));
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this.frameStream.reset();
    const reason = this.disconnectReason;
    this.disconnectReason = "unexpected";
    this.callbacks.onState(reason === "fatal" ? "error" : "disconnected", "Battery disconnected");
    this.callbacks.onDisconnect(reason);
  }
}

const client = new GentaiBatteryClient({
  onState: setConnectionState,
  onIdentity: renderIdentity,
  onTelemetry: handleTelemetry,
  onPacket: () => {
    const now = Date.now();
    $("#dialog-packet").textContent = formatDateTime(now);
  },
  onPacketError: (error) => console.warn("Ignored malformed BMS packet", error),
  onError: (error, fatal) => {
    showToast(fatal ? `Protocol validation stopped: ${error.message}` : `Connection error: ${error.message}`);
    if (fatal) allowAutomaticReconnect = false;
  },
  onDisconnect: (reason) => {
    if (reason !== "manual" && reason !== "fatal" && allowAutomaticReconnect) scheduleReconnect();
  },
});

async function initialize() {
  bindEvents();
  await loadHistory();
  setupChartResize();
  renderHistory();

  if ("serviceWorker" in navigator && !demoMode) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline cache unavailable", error));
  }

  if (demoMode) {
    startDemo();
    return;
  }

  if (!navigator.bluetooth) {
    $("#browser-notice").hidden = false;
    $("#connect-button").disabled = true;
    setConnectionState("error", "Open in Bluefy");
    return;
  }

  preventScreenDimming();
  await reconnectRememberedDevice();
}

function bindEvents() {
  $("#connect-button").addEventListener("click", async () => {
    allowAutomaticReconnect = true;
    try {
      if (selectedDevice) await connectSelectedDevice();
      else await requestBattery();
    } catch (error) {
      if (error.name !== "NotFoundError") {
        setConnectionState("error", error.message);
        showToast(error.message);
      }
    }
  });

  $("#details-button").addEventListener("click", () => $("#details-dialog").showModal());
  $("#forget-button").addEventListener("click", forgetBattery);
  $("#export-button").addEventListener("click", exportHistory);

  $$("[data-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      chartMetric = button.dataset.metric;
      $$("[data-metric]").forEach((item) => item.classList.toggle("active", item === button));
      drawChart();
    });
  });

  $$("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      chartRangeHours = Number(button.dataset.range);
      $$("[data-range]").forEach((item) => item.classList.toggle("active", item === button));
      drawChart();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && selectedDevice && !client.connected && allowAutomaticReconnect) {
      scheduleReconnect(300);
    }
  });

  setInterval(() => {
    if (latestTelemetry && Date.now() - latestTelemetry.timestamp > 15_000 && client.connected) {
      $("#last-updated").textContent = `Readings stale · ${formatRelative(latestTelemetry.timestamp)}`;
    }
  }, 5_000);
}

async function requestBattery() {
  const device = await navigator.bluetooth.requestDevice({
    filters: GENTAI_BLE.namePrefixes.map((namePrefix) => ({ namePrefix })),
    optionalServices: [GENTAI_BLE.service],
  });
  selectedDevice = device;
  localStorage.setItem("gentai-device-id", device.id);
  await connectSelectedDevice();
}

async function reconnectRememberedDevice() {
  if (typeof navigator.bluetooth.getDevices !== "function") return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    const savedId = localStorage.getItem("gentai-device-id");
    selectedDevice =
      devices.find((device) => device.id === savedId) ||
      devices.find((device) => GENTAI_BLE.namePrefixes.some((prefix) => device.name?.startsWith(prefix))) ||
      null;
    if (selectedDevice) await connectSelectedDevice();
  } catch (error) {
    console.warn("Automatic reconnect was unavailable", error);
    setConnectionState("disconnected", error.message);
    if (selectedDevice && allowAutomaticReconnect) scheduleReconnect();
  }
}

async function connectSelectedDevice() {
  if (!selectedDevice || client.connected) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  $("#device-name").textContent = selectedDevice.name || "Gentai battery";
  $("#dialog-device").textContent = selectedDevice.name || "Gentai battery";
  try {
    await client.connect(selectedDevice);
    reconnectAttempt = 0;
  } catch (error) {
    if (selectedDevice.gatt?.connected) client.disconnect("unexpected");
    throw error;
  }
}

function scheduleReconnect(delayMs) {
  if (reconnectTimer || !selectedDevice || !allowAutomaticReconnect) return;
  const waitMs = delayMs ?? Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
  reconnectAttempt += 1;
  setConnectionState("reconnecting", `Retrying in ${Math.ceil(waitMs / 1000)}s`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectSelectedDevice();
    } catch (error) {
      showToast(`Reconnect failed: ${error.message}`);
      scheduleReconnect();
    }
  }, waitMs);
}

async function forgetBattery() {
  allowAutomaticReconnect = false;
  clearTimeout(reconnectTimer);
  client.disconnect("manual");
  try {
    if (typeof selectedDevice?.forget === "function") await selectedDevice.forget();
  } catch (error) {
    console.warn("Bluefy did not revoke the Bluetooth permission", error);
  }
  selectedDevice = null;
  localStorage.removeItem("gentai-device-id");
  $("#dialog-device").textContent = "None";
  $("#details-dialog").close();
  showToast("Battery permission removed from this browser. Battery settings were not changed.");
}

function setConnectionState(state, detail) {
  const chip = $("#connection-status");
  chip.dataset.state = state;
  chip.querySelector("span").textContent = titleCase(state);
  $("#dialog-state").textContent = detail || titleCase(state);
  const button = $("#connect-button");

  if (state === "connected") {
    button.textContent = "Connected";
    button.disabled = true;
  } else if (state === "connecting" || state === "reconnecting") {
    button.textContent = state === "connecting" ? "Connecting…" : "Reconnect now";
    button.disabled = state === "connecting";
  } else {
    button.textContent = selectedDevice ? "Reconnect" : "Connect battery";
    button.disabled = !navigator.bluetooth && !demoMode;
  }
}

async function handleTelemetry(telemetry) {
  latestTelemetry = telemetry;
  renderTelemetry(telemetry);

  if (telemetry.timestamp - lastSavedAt >= SAMPLE_INTERVAL_MS) {
    lastSavedAt = telemetry.timestamp;
    try {
      const sample = await historyStore.add(telemetry);
      historySamples.push(sample);
      historySamples = historySamples.filter((item) => item.timestamp >= Date.now() - RETENTION_MS);
      await historyStore.prune();
      renderHistory();
    } catch (error) {
      $("#history-note").textContent = `Local history unavailable: ${error.message}`;
    }
  }
}

function renderTelemetry(data) {
  const soc = clamp(data.socPct, 0, 100);
  $("#soc-value").textContent = formatNumber(soc, 0);
  $("#soc-caption").textContent = soc <= 20 ? "Low charge" : soc >= 95 ? "Nearly full" : "Available";
  $("#soc-gauge").style.setProperty("--soc-angle", `${soc * 3.6}deg`);
  $("#capacity-fill").style.width = `${soc}%`;
  $("#mode-pill").dataset.mode = data.mode;
  $("#mode-pill").textContent = titleCase(data.mode);

  setValue("#power-value", Math.abs(data.powerW), 0);
  $("#power-caption").textContent = data.mode === "discharging" ? "Being used now" : data.mode === "charging" ? "Going into battery" : "Battery is idle";
  setValue("#voltage-value", data.voltageV, 2);
  $("#current-value").textContent = `${data.currentA > 0 ? "+" : ""}${formatNumber(data.currentA, 2)}`;
  $("#current-caption").textContent = data.currentA > 0 ? "Positive means charging" : data.currentA < 0 ? "Negative means discharging" : "No measurable current";
  setValue("#soh-value", data.sohPct, 0);
  setValue("#ambient-value", data.temperaturesC.ambient, 0);
  setValue("#mos-value", data.temperaturesC.mos, 0);
  $("#remaining-capacity").textContent = `${formatNumber(data.remainingAh, 1)} Ah remaining`;
  $("#full-capacity").textContent = `${formatNumber(data.fullAh, 1)} Ah full`;
  $("#cycle-count").textContent = `${data.cycles} cycles`;
  $("#last-updated").textContent = `Updated ${formatRelative(data.timestamp)}`;

  renderEstimate(data.estimate);
  renderCells(data.cellsV, data.cellMinV, data.cellMaxV, data.cellDeltaV);
  renderTemperatures(data.temperaturesC.probes);
  renderWarnings(data.warnings);
  renderIdentity(data.identity);
}

function renderEstimate(estimate) {
  if (!estimate) {
    $("#estimate-label").textContent = "Remaining time";
    $("#estimate-value").textContent = "Stable / idle";
    $("#estimate-clock").textContent = "Estimate appears while charging or in use";
    return;
  }
  $("#estimate-label").textContent = estimate.direction === "empty" ? "Estimated runtime" : "Estimated charge time";
  $("#estimate-value").textContent = formatDuration(estimate.hours);
  $("#estimate-clock").textContent = `Approximately ${estimate.direction} at ${formatTime(estimate.at)}`;
}

function renderCells(cells, min, max, delta) {
  $("#cell-min").textContent = min === null ? "— V" : `${formatNumber(min, 3)} V`;
  $("#cell-max").textContent = max === null ? "— V" : `${formatNumber(max, 3)} V`;
  $("#cell-delta").textContent = delta === null ? "— mV" : `${formatNumber(delta * 1000, 0)} mV`;
  $("#cell-list").innerHTML = cells.length
    ? cells.map((value, index) => `<div class="cell-item"><span>Cell ${index + 1}</span><strong>${formatNumber(value, 3)} V</strong></div>`).join("")
    : "<p>No cell readings</p>";
}

function renderTemperatures(probes) {
  $("#probe-list").innerHTML = probes.map((value, index) => `<span>T${index + 1} · ${formatNumber(value, 0)}°C</span>`).join("");
}

function renderWarnings(warnings) {
  const panel = $("#alerts-panel");
  const icon = panel.querySelector(".alert-icon");
  if (!warnings.length) {
    panel.dataset.level = "ok";
    icon.textContent = "✓";
    $("#alerts-title").textContent = "No active warnings";
    $("#alerts-list").textContent = "The battery has not reported a protection or warning condition.";
    return;
  }
  panel.dataset.level = "warning";
  icon.textContent = "!";
  $("#alerts-title").textContent = `${warnings.length} active BMS ${warnings.length === 1 ? "warning" : "warnings"}`;
  $("#alerts-list").innerHTML = `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`;
}

function renderIdentity(identity = {}) {
  $("#pack-name").textContent = identity.packName || "—";
  $("#manufacturer").textContent = identity.manufacturer || "—";
  $("#firmware").textContent = identity.firmware || "—";
}

async function loadHistory() {
  if (demoMode) return;
  try {
    await historyStore.prune();
    historySamples = await historyStore.since(Date.now() - RETENTION_MS);
    lastSavedAt = historySamples.at(-1)?.timestamp ?? 0;
  } catch (error) {
    $("#history-note").textContent = `Local history unavailable: ${error.message}`;
  }
}

function renderHistory() {
  const analysis = analyseHistory(historySamples);
  $("#energy-used").textContent = `${formatNumber(analysis.dischargedWh, 1)} Wh`;
  $("#capacity-used").textContent = `${formatNumber(analysis.dischargedAh, 2)} Ah`;
  $("#soc-change").textContent = analysis.netSocChangePct === null ? "—" : `${analysis.netSocChangePct > 0 ? "+" : ""}${formatNumber(analysis.netSocChangePct, 0)}%`;
  $("#peak-usage").textContent = analysis.peak15MinuteW === null ? "—" : `${formatNumber(analysis.peak15MinuteW, 0)} W`;
  $("#peak-time").textContent = analysis.peak15MinuteAt ? `window ending ${formatTime(analysis.peak15MinuteAt)}` : "";
  $("#twenty-time").textContent = analysis.twentyPercentAt
    ? formatTime(analysis.twentyPercentAt)
    : analysis.belowTwentyAtStart
      ? `≤20% at first record (${formatTime(analysis.firstTimestamp)})`
      : "Not reached";
  $("#export-button").disabled = historySamples.length === 0;
  drawChart();
}

function exportHistory() {
  if (!historySamples.length) return;
  const blob = new Blob([historyToCsv(historySamples)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `gentai-battery-history-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
  showToast(`Exported ${historySamples.length} locally saved readings.`);
}

function drawChart() {
  const canvas = $("#history-chart");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const now = Date.now();
  const start = now - chartRangeHours * 3_600_000;
  const samples = historySamples.filter((sample) => sample.timestamp >= start && sample.timestamp <= now);
  $("#chart-empty").hidden = samples.length > 0;
  $("#chart-samples").textContent = `${samples.length} saved ${samples.length === 1 ? "reading" : "readings"}`;
  if (!samples.length) {
    $("#chart-min").textContent = "Min —";
    $("#chart-max").textContent = "Max —";
    return;
  }

  const metric = chartConfiguration(chartMetric);
  const values = samples.map(metric.value);
  let min = metric.fixedMin ?? Math.min(...values);
  let max = metric.fixedMax ?? Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  if (metric.fixedMin === undefined) {
    const padding = (max - min) * 0.1;
    min -= padding;
    max += padding;
  }

  const padding = { top: 10, right: 6, bottom: 20, left: 6 };
  const width = rect.width - padding.left - padding.right;
  const height = rect.height - padding.top - padding.bottom;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(167, 211, 220, 0.10)";
  for (let row = 0; row <= 4; row += 1) {
    const y = padding.top + (height * row) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(rect.width - padding.right, y);
    ctx.stroke();
  }

  const xFor = (timestamp) => padding.left + ((timestamp - start) / (now - start)) * width;
  const yFor = (value) => padding.top + height - ((value - min) / (max - min)) * height;
  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + height);
  gradient.addColorStop(0, `${metric.color}44`);
  gradient.addColorStop(1, `${metric.color}00`);

  ctx.beginPath();
  samples.forEach((sample, index) => {
    const x = xFor(sample.timestamp);
    const y = yFor(metric.value(sample));
    const isGap = index > 0 && sample.timestamp - samples[index - 1].timestamp > 5 * 60_000;
    if (index === 0 || isGap) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = metric.color;
  ctx.stroke();

  if (samples.length > 1) {
    const firstX = xFor(samples[0].timestamp);
    const lastX = xFor(samples.at(-1).timestamp);
    ctx.lineTo(lastX, padding.top + height);
    ctx.lineTo(firstX, padding.top + height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  ctx.fillStyle = "#738c93";
  ctx.font = "10px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(formatChartTime(start, chartRangeHours), padding.left, rect.height - 3);
  ctx.textAlign = "right";
  ctx.fillText(formatChartTime(now, chartRangeHours), rect.width - padding.right, rect.height - 3);

  $("#chart-min").textContent = `Min ${metric.format(Math.min(...values))}`;
  $("#chart-max").textContent = `Max ${metric.format(Math.max(...values))}`;
}

function chartConfiguration(metric) {
  if (metric === "soc") return { color: "#a8e063", value: (sample) => sample.socPct, format: (value) => `${formatNumber(value, 0)}%`, fixedMin: 0, fixedMax: 100 };
  if (metric === "voltage") return { color: "#34d7cb", value: (sample) => sample.voltageV, format: (value) => `${formatNumber(value, 2)} V` };
  return { color: "#ffc857", value: (sample) => Math.max(0, -sample.powerW), format: (value) => `${formatNumber(value, 0)} W`, fixedMin: 0 };
}

function setupChartResize() {
  if ("ResizeObserver" in window) new ResizeObserver(drawChart).observe($(".chart-wrap"));
  else window.addEventListener("resize", drawChart);
}

function preventScreenDimming() {
  try {
    if (typeof navigator.bluetooth?.setScreenDimEnabled === "function") {
      navigator.bluetooth.setScreenDimEnabled(false);
    }
  } catch (error) {
    console.warn("Bluefy screen-dimming control unavailable", error);
  }
}

function startDemo() {
  setConnectionState("connected", "Demonstration data");
  $("#device-name").textContent = "DCHE123 · Demo";
  const now = Date.now();
  historySamples = [];
  for (let minute = 12 * 60; minute >= 0; minute -= 1) {
    const timestamp = now - minute * 60_000;
    const progress = 1 - minute / (12 * 60);
    const currentA = -(4 + Math.sin(minute / 21) * 3 + (minute % 97 < 18 ? 12 : 0));
    const socPct = Math.max(18, 92 - progress * 67);
    historySamples.push({
      timestamp,
      socPct,
      sohPct: 98,
      voltageV: 13.35 - progress * 0.75 + Math.sin(minute / 13) * 0.02,
      currentA,
      powerW: currentA * (13.35 - progress * 0.75),
      remainingAh: socPct,
      fullAh: 100,
      ambientC: 24,
      mosC: 29,
      cellsV: [3.18, 3.181, 3.177, 3.179],
      warningCount: 0,
    });
  }
  const sample = historySamples.at(-1);
  const info = {
    voltageV: sample.voltageV,
    currentA: sample.currentA,
    socPct: sample.socPct,
    sohPct: sample.sohPct,
    remainingAh: sample.remainingAh,
    fullAh: 100,
    cycles: 42,
    temperaturesC: { probes: [24, 24, 25, 24], ambient: 24, mos: 29 },
  };
  latestTelemetry = mergeTelemetry({ info, cellsV: sample.cellsV, identity: { manufacturer: "Gentai", packName: "12.8V 100Ah", firmware: "Demo" }, timestamp: now });
  renderTelemetry(latestTelemetry);
  renderHistory();
  $("#history-note").textContent = "Demonstration mode uses generated data and does not contact the battery.";
}

function setValue(selector, value, decimals) {
  $(selector).textContent = formatNumber(value, decimals);
}

function formatNumber(value, decimals = 0) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : "—";
}

function formatDuration(hours) {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return wholeHours ? `${wholeHours}h ${minutes}m` : `${minutes}m`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatRelative(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function formatChartTime(timestamp, hours) {
  if (hours > 24) return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
  return formatTime(timestamp);
}

function titleCase(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4_500);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

initialize().catch((error) => {
  console.error(error);
  setConnectionState("error", error.message);
  showToast(`Dashboard failed to start: ${error.message}`);
});
