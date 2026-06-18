import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 모델명 SSOT. 값은 agy 1.0.x `agy models` 가 출력하는 display name 형식이다
// (`--model` 인자가 이 문자열을 받는다). 옛 `gemini-*-preview` ID 형식이 아님.
const DEFAULT_GEMINI_PROFILES = {
  model: "Gemini 3.5 Flash (Medium)",
  profiles: {
    flash35: {
      model: "Gemini 3.5 Flash (Medium)",
      hint: "3.5 Flash (Medium) — 기본, 비용·속도 균형",
    },
    flash35_high: {
      model: "Gemini 3.5 Flash (High)",
      hint: "3.5 Flash (High) — 코드/추론 강화",
    },
    pro31: {
      model: "Gemini 3.1 Pro (High)",
      hint: "3.1 Pro (High) — 플래그십 (긴 컨텍스트/복잡 추론)",
    },
    flash3: {
      model: "Gemini 3 Flash",
      hint: "3.0 Flash — 레거시 호환",
    },
  },
};

// 1회 마이그레이션 테이블: 옛 ID 형식 모델값 → agy display name.
// null = deprecated(2.5 계열) → 해당 프로필 제거 대상.
const LEGACY_MODEL_MIGRATION = {
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro (High)",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-2.5-pro": null,
  "gemini-2.5-flash": null,
  "gemini-2.5-flash-lite": null,
};
const LEGACY_PROFILE_NAMES = ["pro25", "flash25", "lite25"];

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
      Object.hasOwn(LEGACY_MODEL_MIGRATION, cfg.model)
    ) {
      // 옛 ID 형식 기본값은 구버전 자동 생성값이므로 새 기본(DEFAULT)으로 정규화한다.
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

export { DEFAULT_GEMINI_PROFILES, ensureGeminiProfiles };
