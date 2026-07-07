const OFF_VALUES = new Set(["0", "false", "off", "no"]);
const ON_VALUES = new Set(["1", "true", "on", "yes"]);

function normalizeEnvValue(name) {
  return String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
}

function isExplicitlyOff(name) {
  return OFF_VALUES.has(normalizeEnvValue(name));
}

function isExplicitlyOn(name) {
  return ON_VALUES.has(normalizeEnvValue(name));
}

export function isCtoDisabled() {
  return isExplicitlyOff("TFX_CTO");
}

export function isCtoManagerEnabled() {
  if (isCtoDisabled()) return false;
  return isExplicitlyOn("TFX_CTO_MANAGER");
}

export function getCtoHygieneApplyMode() {
  if (isExplicitlyOff("TFX_CTO")) return "off";
  return normalizeEnvValue("TFX_CTO_HYGIENE_APPLY") === "archive"
    ? "archive"
    : "off";
}

export function isCtoRetentionEnabled() {
  if (isExplicitlyOff("TFX_CTO")) return false;
  return isExplicitlyOn("TFX_CTO_RETENTION");
}

export function getCtoMode() {
  return normalizeEnvValue("TFX_CTO_MODE") === "bridge" ? "bridge" : "bounded";
}

export function getCtoMaxTokens() {
  const raw = normalizeEnvValue("TFX_CTO_MAX_TOKENS");
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
