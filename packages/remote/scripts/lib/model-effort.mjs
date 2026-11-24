import {
  AGY_FAMILIES,
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

export function normalizeAgyProfileName(name) {
  const raw = String(name ?? "").trim();
  // 옛 Flash 이름은 effort와 상관없이 Argon Low로 보낸다.
  return raw.replace(/^flash\d*(?:_(?:low|high))?$/, "argon_low");
}

export function modelEffortFromProfile(cli, profile, effort) {
  const isAgy = cli === "antigravity" || cli === "agy";
  if (effort !== undefined) {
    const known = isAgy
      ? AGY_FAMILIES.includes(profile)
      : cli === "codex" &&
        Object.values(CODEX_FAMILY_PROFILES).some(
          ({ family }) => family === profile,
        );
    return EFFORT_ORDER.includes(effort) && known
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
  } else if (isAgy) {
    const name = normalizeAgyProfileName(profile);
    if (Object.hasOwn(AGY_FAMILY_PROFILES, name))
      definition = AGY_FAMILY_PROFILES[name];
    // 결합 이름이 없는 가족 이름만 받으면 agy 기본 effort(medium)로 둔다.
    else if (AGY_FAMILIES.includes(name))
      definition = { family: name, effort: "medium" };
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

export function resolveAgyModelEffort({ family, effort }, opts = {}) {
  const { families } = resolveModelFamilies("agy", opts);
  if (!Object.hasOwn(families, family) || !EFFORT_ORDER.includes(effort)) {
    throw new Error(`알 수 없는 agy 가족 또는 effort: ${family}/${effort}`);
  }
  const { model, supportedEfforts, fallbackFamily, fallbackFrom } =
    families[family];
  // 폴백이면 실제로 쓰는 가족을 돌려주고 원래 요청 가족을 fallbackFrom에 남긴다.
  const result = fallbackFrom
    ? { family: fallbackFamily, model, fallbackFrom }
    : { family, model };
  if (!supportedEfforts) return { ...result, effort };
  const selected = EFFORT_ORDER.slice(0, EFFORT_ORDER.indexOf(effort) + 1)
    .filter((level) => supportedEfforts.includes(level))
    .at(-1);
  if (!selected) {
    const error = new Error(
      `${model}: ${effort} 이하의 지원 effort가 없습니다`,
    );
    error.code = "unsupported-effort";
    throw error;
  }
  return { ...result, effort: selected };
}
