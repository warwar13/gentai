export const POWER_LIMIT_W = 600;

export function assessPower(powerW) {
  if (!Number.isFinite(powerW)) return neutral("Waiting");
  const watts = Math.abs(powerW);
  const ratio = watts / POWER_LIMIT_W;
  if (ratio > 1) return result("danger", "Over limit", ratio);
  if (ratio === 1) return result("danger", "At limit", ratio);
  if (ratio >= 0.85) return result("danger", "Near limit", ratio);
  if (ratio >= 0.6) return result("warning", "Moderate load", ratio);
  return result("good", watts < 15 ? "Very light load" : "Comfortable", ratio);
}

export function assessHealth(percent) {
  if (!Number.isFinite(percent)) return neutral("Waiting");
  if (percent >= 90) return result("good", "Excellent");
  if (percent >= 80) return result("warning", "Monitor health");
  return result("danger", "Needs attention");
}

export function assessTemperature(celsius, source = "ambient") {
  if (!Number.isFinite(celsius)) return neutral("Waiting");
  const warmAt = source === "mos" ? 45 : 35;
  const hotAt = source === "mos" ? 60 : 45;
  if (celsius >= hotAt) return result("danger", "Hot");
  if (celsius >= warmAt) return result("warning", "Warm");
  return result("good", "Cool");
}

export function assessCellBalance(deltaV) {
  if (!Number.isFinite(deltaV)) return neutral("Waiting for cells");
  const millivolts = deltaV * 1000;
  if (millivolts > 50) return result("danger", "High cell spread");
  if (millivolts > 20) return result("warning", "Watch cell spread");
  return result("good", "Cells balanced");
}

function result(state, label, ratio = null) {
  return { state, label, ratio };
}

function neutral(label) {
  return result("neutral", label);
}
