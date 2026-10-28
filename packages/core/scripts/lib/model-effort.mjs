import {
  AGY_FAMILY_PROFILES,
  CODEX_FAMILY_PROFILES,
  readCodexModelCatalog,
  resolveModelFamilies,
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

export function modelEffortFromProfile(cli, profile, effort) {
  if (effort !== undefined) {
    const definitions =
      cli === "codex"
        ? CODEX_FAMILY_PROFILES
        : cli === "antigravity" || cli === "agy"
          ? AGY_FAMILY_PROFILES
          : {};
    return EFFORT_ORDER.includes(effort) &&
      Object.values(definitions).some(({ family }) => family === profile)
      ? { family: profile, effort }
      : null;
  }
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

export function resolveCodexModelEffort({ family, effort }, opts = {}) {
  const { families } = resolveModelFamilies("codex", {
    ...opts,
    allowCommand: false,
    persist: false,
  });
  if (!Object.hasOwn(families, family) || !EFFORT_ORDER.includes(effort)) {
    throw new Error(`알 수 없는 Codex 가족 또는 effort: ${family}/${effort}`);
  }
  const model = families[family].model;
  const supported = readCodexModelCatalog(opts)?.models?.find(
    (entry) => entry?.slug === model,
  )?.supported_reasoning_levels;
  if (!Array.isArray(supported)) return { family, model, effort };
  const levels = supported.map((level) => level?.effort ?? level);
  const selected = EFFORT_ORDER.slice(0, EFFORT_ORDER.indexOf(effort) + 1)
    .filter((level) => levels.includes(level))
    .at(-1);
  if (!selected) {
    const error = new Error(
      `${model}: ${effort} 이하의 지원 effort가 없습니다`,
    );
    error.code = "unsupported-effort";
    throw error;
  }
  return { family, model, effort: selected };
}
