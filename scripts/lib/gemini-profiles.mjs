import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_GEMINI_PROFILES = {
  model: "gemini-3.1-pro-preview",
  profiles: {
    pro31: { model: "gemini-3.1-pro-preview", hint: "3.1 Pro — 플래그십 (1M ctx, 멀티모달)" },
    flash3: { model: "gemini-3-flash-preview", hint: "3.0 Flash — 빠른 응답, 비용 효율" },
    pro25: { model: "gemini-2.5-pro", hint: "2.5 Pro — 안정 (추론 강화)" },
    flash25: { model: "gemini-2.5-flash", hint: "2.5 Flash — 경량 범용" },
    lite25: { model: "gemini-2.5-flash-lite", hint: "2.5 Flash Lite — 최경량" },
  },
};

const DEFAULT_PROFILE_COUNT = Object.keys(DEFAULT_GEMINI_PROFILES.profiles).length;

function ensureGeminiProfiles({
  geminiDir = join(homedir(), ".gemini"),
  profilesPath = join(geminiDir, "triflux-profiles.json"),
} = {}) {
  try {
    if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });

    if (!existsSync(profilesPath)) {
      writeFileSync(profilesPath, JSON.stringify(DEFAULT_GEMINI_PROFILES, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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
      try { copyFileSync(profilesPath, profilesPath + `.bak.${Date.now()}`); } catch {}
      writeFileSync(profilesPath, JSON.stringify(DEFAULT_GEMINI_PROFILES, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      return {
        ok: true,
        created: true,
        added: DEFAULT_PROFILE_COUNT,
        count: DEFAULT_PROFILE_COUNT,
        message: null,
      };
    }

    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    if (!cfg.profiles || typeof cfg.profiles !== "object" || Array.isArray(cfg.profiles)) cfg.profiles = {};

    let added = 0;
    for (const [name, value] of Object.entries(DEFAULT_GEMINI_PROFILES.profiles)) {
      if (!cfg.profiles[name]) {
        cfg.profiles[name] = value;
        added++;
      }
    }
    if (!cfg.model) cfg.model = DEFAULT_GEMINI_PROFILES.model;

    if (added > 0) {
      writeFileSync(profilesPath, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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
