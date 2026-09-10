const DB_NAME = "gentai-battery-dashboard";
const DB_VERSION = 1;
const STORE_NAME = "telemetry";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class HistoryStore {
  constructor() {
    this.dbPromise = null;
  }

  async open() {
    if (!("indexedDB" in globalThis)) throw new Error("This browser does not support local history storage");
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "timestamp" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  async add(telemetry) {
    const sample = toHistorySample(telemetry);
    const db = await this.open();
    await transactionPromise(db, "readwrite", (store) => store.put(sample));
    return sample;
  }

  async since(timestamp) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).getAll(IDBKeyRange.lowerBound(timestamp));
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.timestamp - b.timestamp));
      request.onerror = () => reject(request.error);
    });
  }

  async prune(now = Date.now()) {
    const db = await this.open();
    const cutoff = now - RETENTION_MS;
    await transactionPromise(db, "readwrite", (store) => store.delete(IDBKeyRange.upperBound(cutoff)));
  }
}

export function toHistorySample(telemetry) {
  return {
    timestamp: telemetry.timestamp,
    socPct: telemetry.socPct,
    sohPct: telemetry.sohPct,
    voltageV: telemetry.voltageV,
    currentA: telemetry.currentA,
    powerW: telemetry.powerW,
    remainingAh: telemetry.remainingAh,
    fullAh: telemetry.fullAh,
    ambientC: telemetry.temperaturesC?.ambient ?? null,
    mosC: telemetry.temperaturesC?.mos ?? null,
    cellsV: telemetry.cellsV ?? [],
    warningCount: telemetry.warnings?.length ?? 0,
  };
}

export function analyseHistory(allSamples, now = new Date()) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  const samples = allSamples
    .filter((sample) => sample.timestamp >= startOfDay && sample.timestamp < endOfDay)
    .sort((a, b) => a.timestamp - b.timestamp);

  let dischargedAh = 0;
  let dischargedWh = 0;
  let twentyPercentAt = null;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedHours = (current.timestamp - previous.timestamp) / 3_600_000;
    if (elapsedHours > 0 && elapsedHours <= 5 / 60) {
      const averageDischargeA = (Math.max(0, -previous.currentA) + Math.max(0, -current.currentA)) / 2;
      const averageDischargeW = (Math.max(0, -previous.powerW) + Math.max(0, -current.powerW)) / 2;
      dischargedAh += averageDischargeA * elapsedHours;
      dischargedWh += averageDischargeW * elapsedHours;
    }
    if (twentyPercentAt === null && previous.socPct > 20 && current.socPct <= 20) {
      twentyPercentAt = current.timestamp;
    }
  }

  const peakWindow = findPeakUsageWindow(samples, 15 * 60 * 1000);
  const first = samples[0] ?? null;
  const last = samples.at(-1) ?? null;

  return {
    count: samples.length,
    dischargedAh,
    dischargedWh,
    twentyPercentAt,
    belowTwentyAtStart: Boolean(first && first.socPct <= 20),
    firstTimestamp: first?.timestamp ?? null,
    peak15MinuteW: peakWindow?.averageW ?? null,
    peak15MinuteAt: peakWindow?.timestamp ?? null,
    netSocChangePct: first && last ? last.socPct - first.socPct : null,
  };
}

export function findPeakUsageWindow(samples, windowMs) {
  if (!samples.length) return null;
  let start = 0;
  let sum = 0;
  let best = null;

  samples.forEach((sample, end) => {
    if (end > 0 && sample.timestamp - samples[end - 1].timestamp > 5 * 60_000) {
      start = end;
      sum = 0;
    }
    sum += Math.max(0, -sample.powerW);
    while (samples[end].timestamp - samples[start].timestamp > windowMs) {
      sum -= Math.max(0, -samples[start].powerW);
      start += 1;
    }
    const count = end - start + 1;
    const coverage = sample.timestamp - samples[start].timestamp;
    if (count >= 2 && coverage >= windowMs * 0.66) {
      const averageW = sum / count;
      if (!best || averageW > best.averageW) best = { averageW, timestamp: sample.timestamp };
    }
  });

  return best;
}

export function historyToCsv(samples) {
  const header = [
    "timestamp",
    "soc_percent",
    "soh_percent",
    "voltage_v",
    "current_a",
    "power_w",
    "remaining_ah",
    "full_ah",
    "ambient_c",
    "mos_c",
    "cell_1_v",
    "cell_2_v",
    "cell_3_v",
    "cell_4_v",
    "warning_count",
  ];

  const rows = samples.map((sample) => [
    new Date(sample.timestamp).toISOString(),
    sample.socPct,
    sample.sohPct,
    sample.voltageV,
    sample.currentA,
    sample.powerW,
    sample.remainingAh,
    sample.fullAh,
    sample.ambientC ?? "",
    sample.mosC ?? "",
    ...(sample.cellsV ?? []).slice(0, 4),
    ...Array(Math.max(0, 4 - (sample.cellsV?.length ?? 0))).fill(""),
    sample.warningCount,
  ]);

  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function transactionPromise(db, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    action(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("History transaction was aborted"));
  });
}
