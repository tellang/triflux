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

function normalizeEnv(env, name) {
  return String(env?.[name] ?? "")
    .trim()
    .toLowerCase();
}

function isEnvOff(env, name) {
  return OFF_VALUES.has(normalizeEnv(env, name));
}

function isEnvOn(env, name) {
  return ON_VALUES.has(normalizeEnv(env, name));
}

/**
 * Resolve the C6a control plane without mutating environment or runtime
 * state. Callers own storing and incrementing the returned generation.
 */
export function resolveRoleControlSnapshot(env = process.env, options = {}) {
  const masterEnabled = !isEnvOff(env, "TFX_CTO");
  const ctoManagerEnabled = masterEnabled && isEnvOn(env, "TFX_CTO_MANAGER");
  const leadManagerEnabled =
    ctoManagerEnabled && isEnvOn(env, "TFX_LEAD_MANAGER");
  const northStarEnabled =
    masterEnabled && !isEnvOff(env, "TFX_CTO_NORTH_STAR");
  const autoCollectEnabled =
    masterEnabled && !isEnvOff(env, "TFX_CTO_AUTO_COLLECT");
  const values = {
    master_enabled: masterEnabled,
    cto_manager_enabled: ctoManagerEnabled,
    lead_manager_enabled: leadManagerEnabled,
    north_star_enabled: northStarEnabled,
    auto_collect_enabled: autoCollectEnabled,
  };
  const previous = options.previous;
  const changed = Object.keys(values).some(
    (field) => previous?.[field] !== values[field],
  );
  const generation = previous
    ? Number(previous.generation || 0) + (changed ? 1 : 0)
    : Number.isSafeInteger(options.generation) && options.generation >= 0
      ? options.generation
      : 0;
  return { generation, ...values };
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
