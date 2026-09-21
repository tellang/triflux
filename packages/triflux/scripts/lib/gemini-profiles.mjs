import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 모델명 SSOT. 값은 `agy models` 가 출력하는 display name 형식이다
// (`--model` 인자가 이 문자열을 받는다). 옛 `gemini-*-preview` ID 형식이 아님.
// 카탈로그 확인: agy 1.1.27 `agy models` (2026-09-07). 운영 정책은 3.8 Flash 한 세대만
// 쓰고 effort(Low/Medium/High)로 차등한다. Pro 와 이전 세대 Flash 는 기본 프로필에서 뺐다.
const DEFAULT_GEMINI_PROFILES = {
  model: "Gemini 3.8 Flash (Medium)",
  profiles: {
    flash38_low: {
      model: "Gemini 3.8 Flash (Low)",
      hint: "3.8 Flash (Low) — 경량·저비용",
    },
    flash38: {
      model: "Gemini 3.8 Flash (Medium)",
      hint: "3.8 Flash (Medium) — 기본, 비용·속도 균형",
    },
    flash38_high: {
      model: "Gemini 3.8 Flash (High)",
      hint: "3.8 Flash (High) — 코드/추론 강화",
    },
  },
};

// 1회 마이그레이션 테이블: 옛 ID 형식 모델값 → agy display name.
// null = 카탈로그에서 빠진 모델(2.5 계열, 3 Flash) → 해당 프로필 제거 대상.
const LEGACY_MODEL_MIGRATION = {
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro (High)",
  "gemini-3-flash-preview": null,
  "Gemini 3 Flash": null,
  "gemini-2.5-pro": null,
  "gemini-2.5-flash": null,
  "gemini-2.5-flash-lite": null,
};
// 과거 setup 이 자동 생성했던 프로필 이름. 정책상 더 쓰지 않으므로 제거한다.
// 사용자가 직접 이름 붙인 프로필은 건드리지 않는다.
const LEGACY_PROFILE_NAMES = [
  "pro25", "flash25", "lite25", "flash3",
  "pro31", "pro31_low", "flash35", "flash35_high", "flash35_low",
];
// 과거 setup 이 자동 생성한 기본 model 값. 사용자가 고른 값이 아니므로 새 기본으로 올린다.
const LEGACY_DEFAULT_MODELS = new Set(["Gemini 3.5 Flash (Medium)"]);

// ── 용도별 effort (SSOT) ──
// 한 세대(3.8 Flash)만 쓰고 역할에 따라 effort 를 나눈다. 키는 tfx 에이전트/역할 이름
// (agent-map.json 의 에이전트, tfx multi --assign 의 role). bash(tfx-route.sh)와
// node(execution-mode, gemini-adapter, cli-agy)가 모두 이 표를 읽는다.
//   High   : 판단이 결과를 좌우하는 역할 (검토, 설계, 디버깅, 분석)
//   Medium : 생성/작성/실행 (기본값)
//   Low    : 분류, 요약, 추출, 번역처럼 짧고 기계적인 작업
const GEMINI_PROFILE_BY_PURPOSE = Object.freeze({
  designer: "flash38_high",
  reviewer: "flash38_high",
  "code-reviewer": "flash38_high",
  "security-reviewer": "flash38_high",
  "quality-reviewer": "flash38_high",
  critic: "flash38_high",
  architect: "flash38_high",
  verifier: "flash38_high",
  analyst: "flash38_high",
  debugger: "flash38_high",
  planner: "flash38_high",
  scientist: "flash38_high",
  "test-engineer": "flash38_high",
  writer: "flash38",
  executor: "flash38",
  worker: "flash38",
  "document-specialist": "flash38",
  researcher: "flash38",
  antigravity: "flash38",
  agy: "flash38",
  gemini: "flash38",
  summarizer: "flash38_low",
  classifier: "flash38_low",
  triage: "flash38_low",
  translator: "flash38_low",
  formatter: "flash38_low",
  explore: "flash38_low",
});
const GEMINI_DEFAULT_PURPOSE_PROFILE = "flash38";

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
    join(homedir(), ".gemini", "triflux-profiles.json");
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(profilesPath, "utf8"));
  } catch {
    cfg = null;
  }
  const entry = cfg?.profiles?.[raw];
  const fromFile = typeof entry === "string" ? entry : entry?.model;
  if (typeof fromFile === "string" && fromFile.trim()) return fromFile.trim();
  const fromDefault = DEFAULT_GEMINI_PROFILES.profiles[raw];
  if (fromDefault) return fromDefault.model;
  if (typeof cfg?.model === "string" && cfg.model.trim()) return cfg.model.trim();
  return DEFAULT_GEMINI_PROFILES.model;
}

const DEFAULT_PROFILE_COUNT = Object.keys(
  DEFAULT_GEMINI_PROFILES.profiles,
).length;

function ensureGeminiProfiles({
  geminiDir = join(homedir(), ".gemini"),
  profilesPath = join(geminiDir, "triflux-profiles.json"),
} = {}) {
  try {
    if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });

    if (!existsSync(profilesPath)) {
      writeFileSync(
        profilesPath,
        JSON.stringify(DEFAULT_GEMINI_PROFILES, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      return {
        ok: true,
        created: true,
        added: DEFAULT_PROFILE_COUNT,
        count: DEFAULT_PROFILE_COUNT,
        message: null,
      };
    }

    let cfg;
    try {
      cfg = JSON.parse(readFileSync(profilesPath, "utf8"));
    } catch {
      try {
        copyFileSync(profilesPath, profilesPath + `.bak.${Date.now()}`);
      } catch {}
      writeFileSync(
        profilesPath,
        JSON.stringify(DEFAULT_GEMINI_PROFILES, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      return {
        ok: true,
        created: true,
        added: DEFAULT_PROFILE_COUNT,
        count: DEFAULT_PROFILE_COUNT,
        message: null,
      };
    }

    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    if (
      !cfg.profiles ||
      typeof cfg.profiles !== "object" ||
      Array.isArray(cfg.profiles)
    )
      cfg.profiles = {};

    // ── 1회 마이그레이션: deprecated 2.5 프로필 prune + 옛 ID 형식 → display name ──
    // merge-only 로직만으로는 기존 사용자 파일에 남은 stale 프로필/옛 모델 ID 가
    // 정리되지 않으므로, 신규 default 를 채우기 전에 마이그레이션을 먼저 적용한다.
    let migrated = false;
    for (const legacy of LEGACY_PROFILE_NAMES) {
      if (cfg.profiles[legacy]) {
        delete cfg.profiles[legacy];
        migrated = true;
      }
    }
    for (const [pname, pval] of Object.entries(cfg.profiles)) {
      const mid = typeof pval === "string" ? pval : pval?.model;
      if (mid && Object.hasOwn(LEGACY_MODEL_MIGRATION, mid)) {
        const repl = LEGACY_MODEL_MIGRATION[mid];
        if (repl === null) {
          delete cfg.profiles[pname];
        } else if (typeof pval === "string") {
          cfg.profiles[pname] = repl;
        } else {
          cfg.profiles[pname].model = repl;
        }
        migrated = true;
      }
    }
    if (
      typeof cfg.model === "string" &&
      (Object.hasOwn(LEGACY_MODEL_MIGRATION, cfg.model) ||
        LEGACY_DEFAULT_MODELS.has(cfg.model))
    ) {
      // 옛 ID 형식/이전 세대 자동 생성 기본값은 새 기본(DEFAULT)으로 정규화한다.
      cfg.model = DEFAULT_GEMINI_PROFILES.model;
      migrated = true;
    }

    let added = 0;
    for (const [name, value] of Object.entries(
      DEFAULT_GEMINI_PROFILES.profiles,
    )) {
      if (!cfg.profiles[name]) {
        cfg.profiles[name] = value;
        added++;
      }
    }
    if (!cfg.model) cfg.model = DEFAULT_GEMINI_PROFILES.model;

    if (added > 0 || migrated) {
      if (migrated) {
        try {
          copyFileSync(profilesPath, profilesPath + `.bak.${Date.now()}`);
        } catch {}
      }
      writeFileSync(profilesPath, JSON.stringify(cfg, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    return {
      ok: true,
      created: false,
      added,
      count: Object.keys(cfg.profiles).length,
      message: null,
    };
  } catch (error) {
    return {
      ok: false,
      created: false,
      added: 0,
      count: 0,
      message: error.message,
    };
  }
}

export {
  DEFAULT_GEMINI_PROFILES,
  GEMINI_DEFAULT_PURPOSE_PROFILE,
  GEMINI_PROFILE_BY_PURPOSE,
  ensureGeminiProfiles,
  resolveGeminiModel,
  resolveGeminiProfileForPurpose,
};
