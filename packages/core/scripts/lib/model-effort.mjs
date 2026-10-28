import {
  AGY_FAMILY_PROFILES,
  CODEX_FAMILY_PROFILES,
} from "./model-family-resolver.mjs";

export const EFFORT_ORDER = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const LEGACY_CANONICAL_PROFILE_ALIASES = Object.freeze({
  gpt56_sol_xhigh: "astra_xhigh",
  gpt56_sol_max: "astra_max",
  gpt56_sol_ultra: "astra_ultra",
  gpt56_terra_high: "sol_high",
  gpt56_terra_med: "sol_med",
});

export function normalizeCodexProfileName(profileName) {
  const normalized = String(profileName ?? "").trim();
  if (Object.hasOwn(LEGACY_CANONICAL_PROFILE_ALIASES, normalized))
    return LEGACY_CANONICAL_PROFILE_ALIASES[normalized];
  const familyName = normalized.replace(/^gpt\d+_(sol|astra|luna)_/, "$1_");
  return Object.hasOwn(CODEX_FAMILY_PROFILES, familyName)
    ? familyName
    : normalized;
}

export function normalizeGeminiProfileName(name) {
  const raw = String(name ?? "").trim();
  // 옛 Flash 이름은 effort와 상관없이 Argon Low로 보낸다.
  return raw.replace(/^flash\d*(?:_(?:low|high))?$/, "argon_low");
}

export function modelEffortFromProfile(cli, profile) {
  let definition;
  if (cli === "codex") {
    const normalized = normalizeCodexProfileName(profile);
    const name =
      normalized === "max" || normalized === "ultra"
        ? `astra_${normalized}`
        : normalized;
    if (Object.hasOwn(CODEX_FAMILY_PROFILES, name))
      definition = CODEX_FAMILY_PROFILES[name];
  } else if (cli === "antigravity" || cli === "agy") {
    const name = normalizeGeminiProfileName(profile);
    if (Object.hasOwn(AGY_FAMILY_PROFILES, name))
      definition = AGY_FAMILY_PROFILES[name];
  }
  return definition
    ? { family: definition.family, effort: definition.effort }
    : null;
}

export function profileFromModelEffort(cli, { family, effort }) {
  const profiles =
    cli === "codex"
      ? CODEX_FAMILY_PROFILES
      : cli === "antigravity" || cli === "agy"
        ? AGY_FAMILY_PROFILES
        : {};
  return (
    Object.entries(profiles).find(
      ([, value]) => value.family === family && value.effort === effort,
    )?.[0] || null
  );
}
