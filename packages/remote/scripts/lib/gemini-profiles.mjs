import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FLASH_FAMILY_PROFILES,
  modelFamilyPaths,
  resolveModelFamilies,
  writeModelFile,
} from "./model-family-resolver.mjs";

const DEFAULT_GEMINI_PROFILES = {
  model: FLASH_FAMILY_PROFILES.flash.model,
  profiles: Object.fromEntries(
    Object.entries(FLASH_FAMILY_PROFILES).map(([name, { model }]) => [
      name,
      { model },
    ]),
  ),
};

export function normalizeGeminiProfileName(name) {
  const raw = String(name ?? "").trim();
  return raw.replace(/^flash\d*(?=_(?:low|high)$|$)/, "flash");
}

// ── 용도별 effort (SSOT) ──
// Flash 가족 안에서 역할에 따라 effort 를 나눈다. 키는 tfx 에이전트/역할 이름
// (agent-map.json 의 에이전트, tfx multi --assign 의 role). bash(tfx-route.sh)와
// 실행 모드(execution-mode)가 이 표를 읽는다.
//   High   : 판단이 결과를 좌우하는 역할 (검토, 설계, 디버깅, 분석)
//   Medium : 생성/작성/실행 (기본값)
//   Low    : 분류, 요약, 추출, 번역처럼 짧고 기계적인 작업
const GEMINI_PROFILE_BY_PURPOSE = Object.freeze({
  designer: "flash_high",
  reviewer: "flash_high",
  "code-reviewer": "flash_high",
  "security-reviewer": "flash_high",
  "quality-reviewer": "flash_high",
  critic: "flash_high",
  architect: "flash_high",
  verifier: "flash_high",
  analyst: "flash_high",
  debugger: "flash_high",
  planner: "flash_high",
  scientist: "flash_high",
  "test-engineer": "flash_high",
  writer: "flash",
  executor: "flash",
  worker: "flash",
  "document-specialist": "flash",
  researcher: "flash",
  antigravity: "flash",
  agy: "flash",
  gemini: "flash",
  summarizer: "flash_low",
  classifier: "flash_low",
  triage: "flash_low",
  translator: "flash_low",
  formatter: "flash_low",
  explore: "flash_low",
});
const GEMINI_DEFAULT_PURPOSE_PROFILE = "flash";

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
    const entry = bucket?.[name] || bucket?.[raw];
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
    if (!cfg.model || /^Gemini \d+(?:\.\d+)* Flash \(/.test(cfg.model))
      cfg.model = profiles.flash.model;
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
