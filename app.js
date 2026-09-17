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
import {
  HistoryStore,
  analyseCapacityTest,
  analyseHistory,
  analyseRange,
  capacityCurvePoints,
  capacityTestToCsv,
  historyToCsv,
} from "./storage.js";
import {
  assessCellBalance,
  assessHealth,
  assessPower,
  assessTemperature,
  gaugeRatio,
  PACK_VOLTAGE_MAX_V,
  PACK_VOLTAGE_MIN_V,
  POWER_LIMIT_W,
  socGaugeAngle,
} from "./status.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const historyStore = new HistoryStore();
const demoMode = new URLSearchParams(location.search).has("demo");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 60_000;
const CAPACITY_RATING_AH = 100;
const FRESH_TELEMETRY_MS = 15_000;

let historySamples = [];
let lastSavedAt = 0;
let latestTelemetry = null;
let selectedDevice = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let allowAutomaticReconnect = true;
let connectionInProgress = false;
let chartMetric = "usage";
let chartRangeHours = 24;
let analyticsRangeHours = 24;
let toastTimer = null;
let pendingExportCsv = "";
let pendingExportFilename = "gentai-battery-history.csv";
let capacityTests = [];
let activeCapacityTest = null;
let activeCapacitySamples = [];
let capacitySampleWrite = Promise.resolve();
let viewedCapacityTestId = null;
let viewedCapacitySamples = [];

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
    if (device.gatt.connected) {
      this.disconnect("restart");
      await delay(900);
    }
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
    showConnectionError(error);
    if (fatal) allowAutomaticReconnect = false;
  },
  onDisconnect: (reason) => {
    if (!["manual", "fatal", "restart", "pagehide"].includes(reason) && allowAutomaticReconnect) scheduleReconnect();
  },
});

async function initialize() {
  bindEvents();
  await loadHistory();
  await loadCapacityTests();
  setupChartResize();
  renderHistory();
  renderCapacityTest();

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
        showConnectionError(error);
        showToast(error.message);
      }
    }
  });

  $("#release-reconnect-button").addEventListener("click", async () => {
    allowAutomaticReconnect = true;
    try {
      await connectSelectedDevice({ forceRelease: true });
    } catch (error) {
      setConnectionState("error", error.message);
      showConnectionError(error);
    }
  });

  $("#choose-again-button").addEventListener("click", async () => {
    allowAutomaticReconnect = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (client.device?.gatt?.connected) client.disconnect("restart");
    selectedDevice = null;
    try {
      await requestBattery();
    } catch (error) {
      if (error.name !== "NotFoundError") {
        setConnectionState("error", error.message);
        showConnectionError(error);
      }
    }
  });

  $("#details-button").addEventListener("click", () => $("#details-dialog").showModal());
  $("#forget-button").addEventListener("click", forgetBattery);
  $("#export-button").addEventListener("click", exportHistory);
  $("#copy-export-button").addEventListener("click", copyExportCsv);
  $("#download-export-button").addEventListener("click", downloadExportCsv);
  $("#start-capacity-test").addEventListener("click", startCapacityTest);
  $("#stop-capacity-test").addEventListener("click", stopCapacityTest);
  $("#capacity-test-history").addEventListener("click", handleCapacityTestHistoryAction);
  $("#export-saved-capacity-test").addEventListener("click", async () => {
    const test = capacityTests.find((item) => item.id === viewedCapacityTestId);
    if (test) {
      $("#capacity-test-dialog").close();
      await exportCapacityTest(test);
    }
  });

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

  $$("[data-analytics-range]").forEach((button) => {
    button.addEventListener("click", () => {
      analyticsRangeHours = Number(button.dataset.analyticsRange);
      $$("[data-analytics-range]").forEach((item) => item.classList.toggle("active", item === button));
      renderDetailedAnalytics();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && selectedDevice && !client.connected && allowAutomaticReconnect) {
      scheduleReconnect(300);
    }
  });

  window.addEventListener("pagehide", () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (client.device?.gatt?.connected) client.disconnect("pagehide");
  });

  setInterval(() => {
    if (latestTelemetry && Date.now() - latestTelemetry.timestamp > 15_000 && client.connected) {
      $("#last-updated").textContent = `Readings stale · ${formatRelative(latestTelemetry.timestamp)}`;
    }
    renderCapacityTest();
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

async function connectSelectedDevice({ forceRelease = false } = {}) {
  if (!selectedDevice || connectionInProgress) return;
  if (client.connected && !forceRelease) return;
  connectionInProgress = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  $("#device-name").textContent = selectedDevice.name || "Gentai battery";
  $("#dialog-device").textContent = selectedDevice.name || "Gentai battery";
  try {
    if (forceRelease && selectedDevice.gatt?.connected) {
      client.disconnect("restart");
      await delay(1_200);
    }

    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await client.connect(selectedDevice);
        reconnectAttempt = 0;
        $("#connection-error").hidden = true;
        return;
      } catch (error) {
        lastError = error;
        if (selectedDevice.gatt?.connected) client.disconnect("restart");
        if (attempt === 0) await delay(1_200);
      }
    }
    throw lastError;
  } finally {
    connectionInProgress = false;
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
      showConnectionError(error);
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
  $("#connection-error").hidden = true;
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
  button.classList.toggle("button-connected", state === "connected");

  if (state === "connected") {
    $("#connection-error").hidden = true;
    button.textContent = "Connected";
    button.disabled = true;
  } else if (state === "connecting" || state === "reconnecting") {
    button.textContent = state === "connecting" ? "Connecting…" : "Reconnect now";
    button.disabled = state === "connecting";
  } else {
    button.textContent = selectedDevice ? "Reconnect" : "Connect battery";
    button.disabled = !navigator.bluetooth && !demoMode;
  }
  renderCapacityTest();
}

async function handleTelemetry(telemetry) {
  latestTelemetry = telemetry;
  renderTelemetry(telemetry);
  await recordCapacityTestTelemetry(telemetry);

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
  $("#soc-caption").textContent = titleCase(data.mode);
  $("#soc-gauge").dataset.status = soc <= 20 ? "danger" : soc <= 40 ? "warning" : "good";
  $("#soc-gauge").style.setProperty("--soc-angle", `${socGaugeAngle(soc)}deg`);
  $("#soc-gauge").setAttribute("aria-valuenow", `${soc}`);
  $("#capacity-fill").style.width = `${soc}%`;
  $("#mode-pill").dataset.mode = data.mode;
  $("#mode-pill").textContent = titleCase(data.mode);

  setValue("#hero-power-value", Math.abs(data.powerW), 0);
  setValue("#power-value", Math.abs(data.powerW), 0);
  const powerStatus = assessPower(data.powerW);
  setGlanceState("#power-card", "#power-caption", powerStatus);
  setMeterAngle("#power-card", gaugeRatio(Math.abs(data.powerW), 0, POWER_LIMIT_W), Math.abs(data.powerW));
  setValue("#voltage-value", data.voltageV, 2);
  $("#hero-voltage-value").textContent = `${formatNumber(data.voltageV, 2)} V`;
  setMeterAngle("#voltage-card", gaugeRatio(data.voltageV, PACK_VOLTAGE_MIN_V, PACK_VOLTAGE_MAX_V), data.voltageV);
  setValue("#soh-value", data.sohPct, 0);
  setValue("#ambient-value", data.temperaturesC.ambient, 0);
  setValue("#mos-value", data.temperaturesC.mos, 0);
  const temperatures = [data.temperaturesC.ambient, data.temperaturesC.mos, ...(data.temperaturesC.probes ?? [])].filter(Number.isFinite);
  const maximumTemperature = temperatures.length ? Math.max(...temperatures) : null;
  $("#hero-temperature-value").textContent = maximumTemperature === null ? "— °C" : `${formatNumber(maximumTemperature, 0)} °C`;
  setGlanceState("#health-card", "#soh-caption", assessHealth(data.sohPct));
  setGlanceState("#ambient-card", "#ambient-caption", assessTemperature(data.temperaturesC.ambient, "ambient"));
  setGlanceState("#mos-card", "#mos-caption", assessTemperature(data.temperaturesC.mos, "mos"));
  $("#remaining-capacity").textContent = `${formatNumber(data.remainingAh, 1)} Ah`;
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
    $("#estimate-clock").textContent = "Shown while charging or in use";
    return;
  }
  $("#estimate-label").textContent = estimate.direction === "empty" ? "Until 20%" : "Until full";
  $("#estimate-value").textContent = formatDuration(estimate.hours);
  $("#estimate-clock").textContent = `≈ ${formatTime(estimate.at)}`;
}

function renderCells(cells, min, max, delta) {
  const balance = assessCellBalance(delta);
  const deltaMv = Number.isFinite(delta) ? delta * 1000 : null;
  const balanceBadge = $("#cell-balance-status");
  balanceBadge.dataset.status = balance.state;
  balanceBadge.querySelector("span").textContent = balance.label;
  $("#cell-min").textContent = min === null ? "— V" : `${formatNumber(min, 3)} V`;
  $("#cell-max").textContent = max === null ? "— V" : `${formatNumber(max, 3)} V`;
  $("#cell-delta").textContent = delta === null ? "— mV" : `${formatNumber(delta * 1000, 0)} mV`;
  $("#instrument-cell-delta").textContent = deltaMv === null ? "—" : formatNumber(deltaMv, 0);
  setGlanceState("#instrument-delta-card", "#instrument-delta-caption", balance);
  $("#instrument-cell-list").innerHTML = Array.from({ length: 4 }, (_, index) => {
    const value = cells[index];
    return `<article class="instrument-cell" data-status="${Number.isFinite(value) ? balance.state : "neutral"}"><span>C${index + 1}</span><strong>${Number.isFinite(value) ? formatNumber(value, 3) : "—"}</strong><small>V</small></article>`;
  }).join("");
  $("#cell-list").innerHTML = cells.length
    ? cells.map((value, index) => `<div class="cell-item" data-status="${balance.state}"><span>Cell ${index + 1}</span><strong>${formatNumber(value, 3)} V</strong><i aria-hidden="true"></i></div>`).join("")
    : "<p>No cell readings</p>";
}

function renderTemperatures(probes) {
  $("#probe-list").innerHTML = probes.map((value, index) => {
    const status = assessTemperature(value, "ambient");
    return `<span data-status="${status.state}"><i aria-hidden="true"></i>T${index + 1} · ${formatNumber(value, 0)}°C</span>`;
  }).join("");
}

function setGlanceState(cardSelector, labelSelector, assessment) {
  $(cardSelector).dataset.status = assessment.state;
  $(labelSelector).textContent = assessment.label;
}

function setMeterAngle(selector, ratio, value = null) {
  const safeRatio = Number.isFinite(ratio) ? clamp(ratio, 0, 1) : 0;
  const card = $(selector);
  card.style.setProperty("--meter-angle", `${safeRatio * 270}deg`);
  card.style.setProperty("--meter-needle-angle", `${safeRatio * 270}deg`);
  const meter = card.querySelector(".instrument-dial");
  if (meter && Number.isFinite(value)) meter.setAttribute("aria-valuenow", `${value}`);
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

async function loadCapacityTests() {
  if (demoMode) return;
  try {
    capacityTests = await historyStore.capacityTests();
    activeCapacityTest = capacityTests.find((test) => test.status === "active") ?? null;
    activeCapacitySamples = activeCapacityTest ? await historyStore.capacityTestSamples(activeCapacityTest.id) : [];
  } catch (error) {
    console.warn("Capacity test history unavailable", error);
    showToast(`Capacity test history unavailable: ${error.message}`);
  }
}

async function startCapacityTest() {
  if (demoMode || activeCapacityTest || !client.connected || !latestTelemetry || Date.now() - latestTelemetry.timestamp > FRESH_TELEMETRY_MS) return;
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `capacity-${Date.now()}`;
  activeCapacityTest = {
    id,
    status: "active",
    deviceId: selectedDevice?.id ?? null,
    ratedAh: CAPACITY_RATING_AH,
    startedAt: latestTelemetry.timestamp,
    endedAt: null,
    startSocPct: latestTelemetry.socPct,
    endSocPct: null,
    createdAt: Date.now(),
  };
  activeCapacitySamples = [];
  try {
    await historyStore.putCapacityTest(activeCapacityTest);
    const sample = await historyStore.addCapacityTestSample(id, latestTelemetry);
    activeCapacitySamples.push(sample);
    capacityTests = [activeCapacityTest, ...capacityTests.filter((test) => test.id !== id)];
    renderCapacityTest();
    showToast("Capacity test started. Keep this page open and connected.");
  } catch (error) {
    try {
      await historyStore.deleteCapacityTest(id);
    } catch {
      // The original storage error is more useful to the user.
    }
    activeCapacityTest = null;
    activeCapacitySamples = [];
    showToast(`Could not start capacity test: ${error.message}`);
  }
}

async function recordCapacityTestTelemetry(telemetry) {
  if (!activeCapacityTest || demoMode) return;
  if (activeCapacityTest.deviceId && selectedDevice?.id !== activeCapacityTest.deviceId) {
    renderCapacityTest();
    return;
  }
  const testId = activeCapacityTest.id;
  capacitySampleWrite = capacitySampleWrite.then(async () => {
    if (activeCapacityTest?.id !== testId) return;
    try {
      const sample = await historyStore.addCapacityTestSample(testId, telemetry);
      if (activeCapacityTest?.id !== testId) return;
      const previous = activeCapacitySamples.at(-1);
      if (previous?.timestamp === sample.timestamp) activeCapacitySamples[activeCapacitySamples.length - 1] = sample;
      else activeCapacitySamples.push(sample);
      renderCapacityTest();
    } catch (error) {
      showToast(`Capacity test sample was not saved: ${error.message}`);
    }
  });
  await capacitySampleWrite;
}

async function stopCapacityTest() {
  if (!activeCapacityTest) return;
  await capacitySampleWrite;
  const finalSample = activeCapacitySamples.at(-1);
  const completed = {
    ...activeCapacityTest,
    status: "completed",
    endedAt: finalSample?.timestamp ?? activeCapacityTest.startedAt,
    stoppedAt: Date.now(),
    endSocPct: finalSample?.socPct ?? activeCapacityTest.startSocPct,
  };
  completed.summary = capacitySummaryForStorage(analyseCapacityTest(completed, activeCapacitySamples, completed.endedAt));
  try {
    await historyStore.putCapacityTest(completed);
    capacityTests = capacityTests.map((test) => test.id === completed.id ? completed : test);
    activeCapacityTest = null;
    activeCapacitySamples = [];
    renderCapacityTest();
    showToast("Capacity test stopped and saved.");
  } catch (error) {
    showToast(`Could not stop capacity test: ${error.message}`);
  }
}

function capacitySummaryForStorage(analysis) {
  return {
    sampleCount: analysis.sampleCount,
    elapsedMs: analysis.elapsedMs,
    observedMs: analysis.observedMs,
    missingMs: analysis.missingMs,
    coveragePct: analysis.coveragePct,
    dischargedAh: analysis.dischargedAh,
    dischargedWh: analysis.dischargedWh,
    chargedAh: analysis.chargedAh,
    chargedWh: analysis.chargedWh,
    averageVoltageV: analysis.averageVoltageV,
    averageW: analysis.averageW,
    peakW: analysis.peakW,
    startSocPct: analysis.startSocPct,
    endSocPct: analysis.endSocPct,
    fullRange: analysis.fullRange,
    hasGaps: analysis.hasGaps,
    hasCharging: analysis.hasCharging,
    percentOfRated: analysis.percentOfRated,
  };
}

function renderCapacityTest() {
  const idle = $("#capacity-test-idle");
  if (!idle) return;
  const active = $("#capacity-test-active");
  const badge = $("#capacity-test-status");
  const startButton = $("#start-capacity-test");
  const telemetryFresh = Boolean(latestTelemetry && Date.now() - latestTelemetry.timestamp <= FRESH_TELEMETRY_MS);
  const canStart = !demoMode && !activeCapacityTest && client.connected && telemetryFresh;
  startButton.disabled = !canStart;

  if (demoMode) $("#capacity-test-readiness").textContent = "Capacity recording is disabled for generated demo data.";
  else if (activeCapacityTest) $("#capacity-test-readiness").textContent = "A capacity test is already running.";
  else if (!client.connected) $("#capacity-test-readiness").textContent = "Connect the battery to begin.";
  else if (!telemetryFresh) $("#capacity-test-readiness").textContent = "Waiting for a fresh battery reading.";
  else $("#capacity-test-readiness").textContent = latestTelemetry.socPct >= 95
    ? `Ready at ${formatNumber(latestTelemetry.socPct, 0)}% charge.`
    : `Ready at ${formatNumber(latestTelemetry.socPct, 0)}%; a full-range test should begin at 95% or above.`;

  idle.hidden = Boolean(activeCapacityTest);
  active.hidden = !activeCapacityTest;
  if (!activeCapacityTest) {
    badge.dataset.state = "idle";
    badge.textContent = "Ready";
  } else {
    const analysis = analyseCapacityTest(activeCapacityTest, activeCapacitySamples);
    badge.dataset.state = "active";
    badge.textContent = "Recording";
    $("#test-capacity-ah").textContent = `${formatNumber(analysis.dischargedAh, 2)} Ah`;
    $("#test-capacity-percent").textContent = `${formatNumber(analysis.percentOfRated, 1)}% of ${CAPACITY_RATING_AH} Ah`;
    $("#test-energy-wh").textContent = `${formatNumber(analysis.dischargedWh, 1)} Wh`;
    $("#test-elapsed").textContent = analysis.elapsedMs < 60_000 ? "<1m" : formatDurationMs(analysis.elapsedMs);
    $("#test-soc-range").textContent = analysis.endSocPct === null ? "Waiting for readings" : `${formatNumber(analysis.startSocPct, 0)}% to ${formatNumber(analysis.endSocPct, 0)}% SOC`;
    const displayedCoverage = analysis.sampleCount === 1 && !analysis.hasGaps ? 100 : analysis.coveragePct;
    $("#test-coverage").textContent = `${formatNumber(displayedCoverage, 1)}%`;
    $("#test-coverage-note").textContent = analysis.hasGaps ? `${formatDurationMs(analysis.missingMs)} unmeasured` : `${analysis.sampleCount} saved readings`;
    $("#test-average-voltage").textContent = analysis.averageVoltageV === null ? "— V" : `${formatNumber(analysis.averageVoltageV, 2)} V`;
    $("#test-power-summary").textContent = analysis.averageW === null ? "— W" : `${formatNumber(analysis.averageW, 0)} / ${formatNumber(analysis.peakW, 0)} W`;
    const warnings = [];
    if (activeCapacityTest.startSocPct < 95) warnings.push(`Started at ${formatNumber(activeCapacityTest.startSocPct, 0)}%; this result will be labelled partial.`);
    if (!client.connected) warnings.push("Battery disconnected; recording will resume after reconnection and unmeasured time will be flagged.");
    if (analysis.hasGaps) warnings.push("A recording gap longer than 30 seconds was excluded from the totals.");
    if (analysis.hasCharging) warnings.push("Charging was detected and is not included in delivered capacity.");
    if (activeCapacityTest.deviceId && selectedDevice?.id && activeCapacityTest.deviceId !== selectedDevice.id) warnings.push("The connected battery is not the battery that started this test; readings are paused.");
    const warningBox = $("#capacity-test-warnings");
    warningBox.hidden = warnings.length === 0;
    warningBox.textContent = warnings.join(" ");
    drawCapacityCurve("#capacity-curve-chart", "#capacity-curve-empty", activeCapacityTest, activeCapacitySamples);
  }

  renderCapacityTestHistory();
}

function renderCapacityTestHistory() {
  const completed = capacityTests.filter((test) => test.status === "completed");
  $("#capacity-test-history").innerHTML = completed.length ? completed.map((test) => {
    const summary = test.summary ?? {};
    const label = capacityResultLabel(summary);
    return `<article class="saved-test">
      <div class="saved-test-title"><strong>${escapeHtml(formatDateTime(test.startedAt))}</strong><span>${escapeHtml(label)} · ${formatNumber(summary.startSocPct, 0)}% to ${formatNumber(summary.endSocPct, 0)}%</span></div>
      <div class="saved-test-metric"><strong>${formatNumber(summary.dischargedAh, 2)} Ah</strong><span>${formatNumber(summary.percentOfRated, 1)}% of 100 Ah</span></div>
      <div class="saved-test-metric"><strong>${formatNumber(summary.dischargedWh, 1)} Wh</strong><span>Delivered energy</span></div>
      <div class="saved-test-metric"><strong>${formatDurationMs(summary.elapsedMs)}</strong><span>Elapsed</span></div>
      <div class="saved-test-metric"><strong>${formatNumber(summary.coveragePct, 1)}%</strong><span>Coverage</span></div>
      <div class="saved-test-actions"><button class="button button-quiet" type="button" data-test-action="view" data-test-id="${escapeHtml(test.id)}">View</button><button class="button button-quiet" type="button" data-test-action="export" data-test-id="${escapeHtml(test.id)}">Export CSV</button><button class="button button-danger" type="button" data-test-action="delete" data-test-id="${escapeHtml(test.id)}">Delete</button></div>
    </article>`;
  }).join("") : '<p class="capacity-test-empty">No completed capacity tests yet.</p>';
}

async function handleCapacityTestHistoryAction(event) {
  const button = event.target.closest("[data-test-action]");
  if (!button) return;
  const test = capacityTests.find((item) => item.id === button.dataset.testId);
  if (!test) return;
  if (button.dataset.testAction === "view") {
    await showCapacityTestResult(test);
    return;
  }
  if (button.dataset.testAction === "export") {
    await exportCapacityTest(test);
    return;
  }
  if (button.dataset.testAction === "delete" && confirm(`Delete the capacity test from ${formatDateTime(test.startedAt)} and all of its saved readings?`)) {
    try {
      await historyStore.deleteCapacityTest(test.id);
      capacityTests = capacityTests.filter((item) => item.id !== test.id);
      renderCapacityTest();
      showToast("Capacity test deleted from this browser.");
    } catch (error) {
      showToast(`Could not delete capacity test: ${error.message}`);
    }
  }
}

async function showCapacityTestResult(test) {
  const summary = test.summary ?? {};
  const label = capacityResultLabel(summary);
  viewedCapacityTestId = test.id;
  $("#saved-test-result").textContent = label;
  $("#saved-test-period").textContent = `${formatDateTime(test.startedAt)} · ${formatDurationMs(summary.elapsedMs)}`;
  $("#saved-test-soc").textContent = `${formatNumber(summary.startSocPct, 0)}% to ${formatNumber(summary.endSocPct, 0)}%`;
  $("#saved-test-capacity").textContent = `${formatNumber(summary.dischargedAh, 2)} Ah · ${formatNumber(summary.percentOfRated, 1)}% of 100 Ah`;
  $("#saved-test-energy").textContent = `${formatNumber(summary.dischargedWh, 1)} Wh`;
  $("#saved-test-voltage").textContent = summary.averageVoltageV === null ? "—" : `${formatNumber(summary.averageVoltageV, 2)} V`;
  $("#saved-test-power").textContent = summary.averageW === null ? "—" : `${formatNumber(summary.averageW, 0)} / ${formatNumber(summary.peakW, 0)} W`;
  $("#saved-test-coverage").textContent = summary.sampleCount < 2
    ? "Insufficient readings"
    : summary.hasGaps
    ? `${formatNumber(summary.coveragePct, 1)}% · ${formatDurationMs(summary.missingMs)} missing`
    : `${formatNumber(summary.coveragePct, 1)}% · complete capture`;
  $("#saved-test-charging").textContent = summary.hasCharging ? `${formatNumber(summary.chargedAh, 2)} Ah` : "None";
  $("#capacity-test-dialog").showModal();
  const empty = $("#saved-capacity-curve-empty");
  empty.hidden = false;
  empty.textContent = "Loading discharge curve…";
  try {
    viewedCapacitySamples = await historyStore.capacityTestSamples(test.id);
    requestAnimationFrame(() => drawCapacityCurve("#saved-capacity-curve-chart", "#saved-capacity-curve-empty", test, viewedCapacitySamples));
  } catch (error) {
    viewedCapacitySamples = [];
    empty.textContent = `Curve unavailable: ${error.message}`;
  }
}

function capacityResultLabel(summary) {
  if ((summary.sampleCount ?? 0) < 2) return "Too short";
  if (summary.hasGaps) return "Interrupted";
  if (summary.hasCharging) return "Charging detected";
  return summary.fullRange ? "Full-range" : "Partial";
}

function drawCapacityCurve(canvasSelector, emptySelector, test, samples) {
  const prepared = prepareCanvas(canvasSelector);
  if (!prepared.canvas) return;
  const { ctx, width, height } = prepared;
  const points = capacityCurvePoints(test, samples).filter((point) => Number.isFinite(point.capacityAh) && Number.isFinite(point.voltageV));
  const maxCapacityAh = Math.max(0, ...points.map((point) => point.capacityAh));
  const empty = $(emptySelector);
  empty.hidden = points.length >= 2 && maxCapacityAh > 0;
  empty.textContent = "The curve appears after discharge begins";
  ctx.clearRect(0, 0, width, height);
  if (points.length < 2 || maxCapacityAh <= 0) return;

  const padding = { top: 18, right: 12, bottom: 23, left: 12 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  let minVoltage = Math.min(...points.map((point) => point.voltageV));
  let maxVoltage = Math.max(...points.map((point) => point.voltageV));
  if (minVoltage === maxVoltage) {
    minVoltage -= 0.1;
    maxVoltage += 0.1;
  } else {
    const voltagePadding = Math.max(0.03, (maxVoltage - minVoltage) * 0.08);
    minVoltage -= voltagePadding;
    maxVoltage += voltagePadding;
  }

  drawCanvasGrid(ctx, width, height, padding);
  const xFor = (point) => padding.left + (point.capacityAh / maxCapacityAh) * plotWidth;
  const yFor = (point) => padding.top + plotHeight - ((point.voltageV - minVoltage) / (maxVoltage - minVoltage)) * plotHeight;
  drawCanvasSeries(ctx, points, xFor, yFor, "#34d7cb");

  const latest = points.at(-1);
  ctx.fillStyle = "#a8e063";
  ctx.beginPath();
  ctx.arc(xFor(latest), yFor(latest), 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#738c93";
  ctx.font = "10px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("0 Ah", padding.left, height - 3);
  ctx.fillText(`${formatNumber(maxVoltage, 2)} V`, padding.left, 10);
  ctx.textAlign = "right";
  ctx.fillText(`${formatNumber(maxCapacityAh, 2)} Ah`, width - padding.right, height - 3);
  ctx.fillText(`${formatNumber(minVoltage, 2)} V`, width - padding.right, padding.top + plotHeight - 3);
}

async function exportCapacityTest(test) {
  try {
    const samples = await historyStore.capacityTestSamples(test.id);
    const stamp = new Date(test.startedAt).toISOString().replace(/[:.]/g, "-");
    pendingExportFilename = `gentai-capacity-test-${stamp}.csv`;
    pendingExportCsv = capacityTestToCsv(test, samples);
    await shareCsv(pendingExportFilename, "Gentai capacity test", `${samples.length} capacity-test readings`);
  } catch (error) {
    showToast(`Could not export capacity test: ${error.message}`);
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
  renderDetailedAnalytics();
}

async function exportHistory() {
  if (!historySamples.length) return;
  pendingExportCsv = historyToCsv(historySamples);
  const stamp = new Date().toISOString().slice(0, 10);
  pendingExportFilename = `gentai-battery-history-${stamp}.csv`;
  await shareCsv(pendingExportFilename, "Gentai battery history", `${historySamples.length} locally recorded battery readings`);
}

async function shareCsv(filename, title, description) {
  try {
    if (typeof File === "function" && typeof navigator.share === "function") {
      const file = new File([pendingExportCsv], filename, { type: "text/csv" });
      const canShareFile = typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] });
      if (!canShareFile) throw new Error("This browser cannot share CSV files");
      await navigator.share({
        title,
        text: description,
        files: [file],
      });
      showToast("CSV opened in the iPad share sheet. Choose Save to Files to keep it locally.");
      return;
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    console.warn("File sharing was unavailable", error);
  }

  openExportFallback();
}

function openExportFallback() {
  $("#export-text").value = pendingExportCsv;
  $("#export-dialog").showModal();
}

async function copyExportCsv() {
  if (!pendingExportCsv) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(pendingExportCsv);
    else {
      const textarea = $("#export-text");
      textarea.focus();
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("Copy command was rejected");
    }
    showToast("CSV copied. Paste it into Numbers, Notes, or another app.");
  } catch (error) {
    showToast(`Automatic copy failed. Select the CSV text and choose Copy. ${error.message}`);
  }
}

function downloadExportCsv() {
  if (!pendingExportCsv) return;
  const blob = new Blob([pendingExportCsv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pendingExportFilename;
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showToast("Download requested. If Bluefy blocks it, use Copy CSV instead.");
}

function renderDetailedAnalytics() {
  const end = Date.now();
  const start = end - analyticsRangeHours * 3_600_000;
  const analytics = analyseRange(historySamples, start, end);
  $("#range-used").textContent = `${formatNumber(analytics.usedWh, 1)} Wh`;
  $("#range-charged").textContent = `${formatNumber(analytics.chargedWh, 1)} Wh`;
  $("#range-runtime").textContent = formatDurationMs(analytics.dischargingMs);
  $("#range-lowest-soc").textContent = analytics.lowestSocPct === null ? "—" : `${formatNumber(analytics.lowestSocPct, 0)}%`;
  $("#range-lowest-time").textContent = analytics.lowestSocAt ? `at ${formatRangeTimestamp(analytics.lowestSocAt)}` : "No readings";
  drawEnergyChart(analytics);
  drawHourlyChart(analytics);
  renderSessions(analytics.sessions);
}

function drawEnergyChart(analytics) {
  const { canvas, ctx, width, height } = prepareCanvas("#energy-chart");
  if (!canvas) return;
  const points = analytics.cumulative;
  $("#energy-chart-empty").hidden = points.length >= 2;
  ctx.clearRect(0, 0, width, height);
  if (points.length < 2) return;

  const padding = { top: 12, right: 8, bottom: 22, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const firstTime = points[0].timestamp;
  const lastTime = Math.max(points.at(-1).timestamp, firstTime + 1);
  const maxEnergy = Math.max(1, ...points.flatMap((point) => [point.usedWh, point.chargedWh]));
  drawCanvasGrid(ctx, width, height, padding);

  const xFor = (timestamp) => padding.left + ((timestamp - firstTime) / (lastTime - firstTime)) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - (value / maxEnergy) * plotHeight;
  drawCanvasSeries(ctx, points, (point) => xFor(point.timestamp), (point) => yFor(point.usedWh), "#ffc857");
  drawCanvasSeries(ctx, points, (point) => xFor(point.timestamp), (point) => yFor(point.chargedWh), "#34d7cb");

  ctx.fillStyle = "#738c93";
  ctx.font = "10px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(formatRangeTimestamp(firstTime), padding.left, height - 3);
  ctx.textAlign = "right";
  ctx.fillText(`${formatNumber(maxEnergy, 0)} Wh`, width - padding.right, 10);
  ctx.fillText(formatRangeTimestamp(lastTime), width - padding.right, height - 3);
}

function drawHourlyChart(analytics) {
  const { canvas, ctx, width, height } = prepareCanvas("#hourly-chart");
  if (!canvas) return;
  const maxEnergy = Math.max(0, ...analytics.hourly.flatMap((hour) => [hour.usedWh, hour.chargedWh]));
  $("#hourly-chart-empty").hidden = maxEnergy > 0;
  ctx.clearRect(0, 0, width, height);
  if (maxEnergy <= 0) return;

  const padding = { top: 12, right: 6, bottom: 22, left: 6 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  drawCanvasGrid(ctx, width, height, padding);
  const groupWidth = plotWidth / 24;
  const barWidth = Math.max(2, groupWidth * 0.3);

  analytics.hourly.forEach((hour, index) => {
    const center = padding.left + groupWidth * index + groupWidth / 2;
    const usedHeight = (hour.usedWh / maxEnergy) * plotHeight;
    const chargedHeight = (hour.chargedWh / maxEnergy) * plotHeight;
    ctx.fillStyle = "#ffc857";
    ctx.fillRect(center - barWidth - 1, padding.top + plotHeight - usedHeight, barWidth, usedHeight);
    ctx.fillStyle = "#34d7cb";
    ctx.fillRect(center + 1, padding.top + plotHeight - chargedHeight, barWidth, chargedHeight);
  });

  ctx.fillStyle = "#738c93";
  ctx.font = "9px -apple-system, sans-serif";
  ctx.textAlign = "center";
  [0, 4, 8, 12, 16, 20, 23].forEach((hour) => {
    const x = padding.left + groupWidth * hour + groupWidth / 2;
    ctx.fillText(hourLabel(hour), x, height - 3);
  });
  ctx.textAlign = "right";
  ctx.fillText(`${formatNumber(maxEnergy, 0)} Wh`, width - padding.right, 10);
}

function renderSessions(sessions) {
  const rows = sessions.slice(0, 12);
  $("#sessions-body").innerHTML = rows.length
    ? rows.map((session) => {
        const change = `${session.socChangePct > 0 ? "+" : ""}${formatNumber(session.socChangePct, 0)}%`;
        return `<tr>
          <td><span class="session-type ${session.mode}">${titleCase(session.mode)}</span></td>
          <td>${formatRangeTimestamp(session.startTimestamp)}</td>
          <td>${formatDurationMs(session.durationMs)}</td>
          <td>${change}</td>
          <td>${formatNumber(session.averageW, 0)} W</td>
          <td>${formatNumber(session.peakW, 0)} W</td>
          <td>${formatNumber(session.energyWh, 1)} Wh</td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="7" class="empty-cell">Sessions will appear after at least two continuous readings.</td></tr>';
}

function prepareCanvas(selector) {
  const canvas = $(selector);
  if (!canvas) return { canvas: null };
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return { canvas: null };
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { canvas, ctx, width: rect.width, height: rect.height };
}

function drawCanvasGrid(ctx, width, height, padding) {
  const plotHeight = height - padding.top - padding.bottom;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(167, 211, 220, 0.10)";
  for (let row = 0; row <= 4; row += 1) {
    const y = padding.top + (plotHeight * row) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }
}

function drawCanvasSeries(ctx, points, xFor, yFor, color) {
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xFor(point);
    const y = yFor(point);
    if (index === 0 || point.gap) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
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
  const redraw = () => {
    drawChart();
    renderDetailedAnalytics();
    if (activeCapacityTest) drawCapacityCurve("#capacity-curve-chart", "#capacity-curve-empty", activeCapacityTest, activeCapacitySamples);
    const viewedTest = capacityTests.find((test) => test.id === viewedCapacityTestId);
    if (viewedTest && $("#capacity-test-dialog").open) drawCapacityCurve("#saved-capacity-curve-chart", "#saved-capacity-curve-empty", viewedTest, viewedCapacitySamples);
  };
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(redraw);
    observer.observe($(".chart-wrap"));
    $$(".analytics-canvas-wrap").forEach((element) => observer.observe(element));
    $$(".capacity-curve-wrap").forEach((element) => observer.observe(element));
  } else {
    window.addEventListener("resize", redraw);
  }
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

function formatDurationMs(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "—";
  const totalMinutes = Math.round(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatRangeTimestamp(timestamp) {
  if (analyticsRangeHours > 24) {
    return new Date(timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return formatTime(timestamp);
}

function hourLabel(hour) {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
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

function showConnectionError(error) {
  const message = String(error?.message || error || "Unknown Bluetooth error");
  const lower = message.toLowerCase();
  let guidance;
  if (lower.includes("timeout") || lower.includes("timed out")) {
    guidance = "The battery connected but did not answer. Completely close the Gentai app and any BLE scanner, stay near the battery, then use Release & reconnect.";
  } else if (lower.includes("gatt") || lower.includes("network") || lower.includes("connect")) {
    guidance = "Bluefy or the battery may still hold the previous BLE session. Close other battery apps, then use Release & reconnect or choose the battery again.";
  } else if (lower.includes("service") || lower.includes("characteristic")) {
    guidance = "The expected Gentai BLE service was not available. Choose DCHE123 again and ensure no other app is connected.";
  } else {
    guidance = "Close the Gentai app and BLE scanner, keep Bluetooth enabled, then release the old session or choose DCHE123 again.";
  }
  $("#connection-error-message").textContent = `${guidance} Error: ${message}`;
  $("#connection-error").hidden = false;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

initialize().catch((error) => {
  console.error(error);
  setConnectionState("error", error.message);
  showConnectionError(error);
  showToast(`Dashboard failed to start: ${error.message}`);
});
