import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeGeminiProfileName } from "./model-effort.mjs";
import {
  AGY_FAMILY_PROFILES,
  modelFamilyPaths,
  resolveModelFamilies,
  writeModelFile,
} from "./model-family-resolver.mjs";

const DEFAULT_GEMINI_PROFILES = {
  model: AGY_FAMILY_PROFILES.argon.model,
  profiles: Object.fromEntries(
    Object.entries(AGY_FAMILY_PROFILES).map(([name, { model }]) => [
      name,
      { model },
    ]),
  ),
};

export { normalizeGeminiProfileName };

// 용도별 agy 프로필 매핑 (SSOT, ADR-0054)
// Carbon / Hydrogen / Argon 가족과 effort를 역할군 등급에 맞춰 배정한다.
const GEMINI_PROFILE_BY_PURPOSE = Object.freeze({
  architect: "carbon_high",
  planner: "carbon_high",
  critic: "carbon_high",
  analyst: "carbon_high",
  debugger: "carbon_high",
  "deep-executor": "carbon_high",
  "scientist-deep": "carbon_high",
  "security-reviewer": "carbon_high",
  lead: "carbon_high",
  reviewer: "hydrogen_high",
  "code-reviewer": "hydrogen_high",
  "quality-reviewer": "hydrogen_high",
  designer: "hydrogen_high",
  verifier: "hydrogen_high",
  "qa-tester": "hydrogen_high",
  scientist: "hydrogen_high",
  "test-engineer": "hydrogen_high",
  executor: "hydrogen",
  codex: "hydrogen",
  worker: "hydrogen",
  antigravity: "hydrogen",
  agy: "hydrogen",
  gemini: "hydrogen",
  writer: "argon",
  "document-specialist": "argon",
  researcher: "argon",
  communication: "argon",
  "communication-report": "argon",
  "build-fixer": "hydrogen_low",
  cleanup: "hydrogen_low",
  deslop: "hydrogen_low",
  summarizer: "hydrogen_low",
  classifier: "hydrogen_low",
  triage: "hydrogen_low",
  translator: "hydrogen_low",
  formatter: "hydrogen_low",
  explore: "hydrogen_low",
  spark: "hydrogen_low",
  "communication-relay": "hydrogen_low",
});
const GEMINI_DEFAULT_PURPOSE_PROFILE = "hydrogen";

function resolveGeminiProfileForPurpose(name) {
  const key = String(name ?? "")
    .trim()
    .toLowerCase();
  return GEMINI_PROFILE_BY_PURPOSE[key] || GEMINI_DEFAULT_PURPOSE_PROFILE;
}

// 프로필 이름 → agy display name. 사용자 파일(~/.gemini/triflux-profiles.json)이
// 우선하고, 없으면 DEFAULT_GEMINI_PROFILES 로 떨어진다. 이미 모델명이면 그대로 돌려준다.
function resolveGeminiModel(profileOrModel, opts = {}) {
  const raw = String(profileOrModel ?? "").trim();
  if (!raw) return DEFAULT_GEMINI_PROFILES.model;
  if (/^gemini[\s-]/i.test(raw)) return raw;
  const profilesPath =
    opts.profilesPath ||
    process.env.GEMINI_PROFILES_PATH ||
    join(modelFamilyPaths(opts).home, ".gemini", "triflux-profiles.json");
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(profilesPath, "utf8"));
  } catch {
    cfg = null;
  }
  const name = normalizeGeminiProfileName(raw);
  const modelValue = (entry) =>
    typeof entry === "string"
      ? entry
      : typeof entry?.model === "string"
        ? entry.model
        : entry?.model?.name || entry?.name;
  for (const bucket of [
    cfg?.profiles,
    cfg?.model?.profiles,
    cfg?.modelProfiles,
    cfg?.models,
  ]) {
    // 옛 Flash 이름은 정규화한 이름으로만 찾는다. 원래 이름으로 찾으면 남은 Flash 항목이 돌아온다.
    const entry = bucket?.[name];
    const value = modelValue(entry);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (name !== "default" && DEFAULT_GEMINI_PROFILES.profiles[name])
    return DEFAULT_GEMINI_PROFILES.profiles[name].model;
  const fallback =
    cfg?.defaultModel ||
    cfg?.default_profile ||
    cfg?.defaultProfile ||
    (typeof cfg?.model === "string" ? cfg.model : cfg?.model?.default);
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  const defaultProfile = normalizeGeminiProfileName(
    (opts.env || process.env).TFX_GEMINI_DEFAULT_PROFILE,
  );
  return (
    modelValue(cfg?.profiles?.[defaultProfile]) ||
    DEFAULT_GEMINI_PROFILES.profiles[defaultProfile]?.model ||
    DEFAULT_GEMINI_PROFILES.model
  );
}

function ensureGeminiProfiles(opts = {}) {
  const geminiDir =
    opts.geminiDir || join(modelFamilyPaths(opts).home, ".gemini");
  const profilesPath =
    opts.profilesPath ||
    process.env.GEMINI_PROFILES_PATH ||
    join(geminiDir, "triflux-profiles.json");
  try {
    let cfg;
    let created = !existsSync(profilesPath);
    if (!created) {
      try {
        cfg = JSON.parse(readFileSync(profilesPath, "utf8"));
      } catch {
        copyFileSync(profilesPath, `${profilesPath}.bak.${Date.now()}`);
        created = true;
      }
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    if (
      !cfg.profiles ||
      typeof cfg.profiles !== "object" ||
      Array.isArray(cfg.profiles)
    )
      cfg.profiles = {};
    const { profiles } = resolveModelFamilies("agy", {
      ...opts,
      home: opts.home || dirname(geminiDir),
    });
    let added = 0;
    for (const [name, { model }] of Object.entries(profiles)) {
      if (!cfg.profiles[name]) added++;
      cfg.profiles[name] = { model };
    }
    if (
      !cfg.model ||
      /^Gemini \d+(?:\.\d+)* (?:Flash|Argon) \(/.test(cfg.model)
    )
      cfg.model = profiles.argon.model;
    const changed = writeModelFile(
      profilesPath,
      `${JSON.stringify(cfg, null, 2)}\n`,
    );
    return {
      ok: true,
      created,
      changed,
      added,
      count: Object.keys(cfg.profiles).length,
      message: null,
    };
  } catch (error) {
    return {
      ok: false,
      created: false,
      changed: false,
      added: 0,
      count: 0,
      message: error.message,
    };
  }
}

export {
  DEFAULT_GEMINI_PROFILES,
  ensureGeminiProfiles,
  resolveGeminiModel,
  resolveGeminiProfileForPurpose,
};
