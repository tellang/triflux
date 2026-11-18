// triflux machine profile 공용 리더 (scripts/tfx-route.sh bash 판독과 의미 일치)
// 신뢰 경계: 파일을 source 하거나 eval 하지 않고 allowlist key 와 안전한 literal 값만 읽는다.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MACHINE_PROFILE_FILENAME = "machine-profile.env";

export const MACHINE_PROFILE_KEYS = Object.freeze([
  "TFX_MACHINE_PROFILE_VERSION",
  "TFX_MACHINE_OS",
  "TFX_MULTIPLEXER_POLICY",
  "TFX_DISABLE_CODEX",
  "TFX_DISABLE_ANTIGRAVITY",
  "TFX_DISABLE_CLAUDE",
  "TFX_TIMEOUT_POLICY",
  "TFX_HARD_CEILING_SEC",
  "TFX_STALL_THRESHOLD",
  "TFX_STALL_KILL",
]);

const MACHINE_PROFILE_KEY_SET = new Set(MACHINE_PROFILE_KEYS);

const MACHINE_PROFILE_VALUE_RE = /^[A-Za-z0-9_.-]+$/u;

const CLI_DISABLE_KEYS = Object.freeze({
  codex: "TFX_DISABLE_CODEX",
  antigravity: "TFX_DISABLE_ANTIGRAVITY",
  claude: "TFX_DISABLE_CLAUDE",
});

// agy 와 gemini 는 antigravity 레인의 별칭이므로 같은 정책을 적용한다.
const CLI_ALIASES = Object.freeze({
  codex: "codex",
  antigravity: "antigravity",
  agy: "antigravity",
  gemini: "antigravity",
  claude: "claude",
});

// Windows os.homedir() 는 process.env.HOME swap 을 무시하므로 env 를 우선한다 (#193 회귀).
export function resolveTrifluxHome({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env?.TRIFLUX_TEST_HOME) return env.TRIFLUX_TEST_HOME;
  if (platform === "win32") {
    return env?.USERPROFILE || env?.HOME || homedir();
  }
  return env?.HOME || homedir();
}

export function resolveMachineProfilePath({
  platform = process.platform,
  env = process.env,
  home,
} = {}) {
  if (env?.TFX_MACHINE_PROFILE_PATH) {
    return resolve(env.TFX_MACHINE_PROFILE_PATH);
  }
  const resolvedHome = home ?? resolveTrifluxHome({ env, platform });
  if (platform === "win32") {
    const appData = env?.APPDATA || join(resolvedHome, "AppData", "Roaming");
    return join(appData, "triflux", MACHINE_PROFILE_FILENAME);
  }
  const configRoot = env?.XDG_CONFIG_HOME || join(resolvedHome, ".config");
  return join(configRoot, "triflux", MACHINE_PROFILE_FILENAME);
}

export function parseMachineProfileContent(content) {
  const values = {};
  const warnings = [];
  const lines = String(content || "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      warnings.push(`line ${index + 1}: KEY=VALUE 형식이 아님`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!MACHINE_PROFILE_KEY_SET.has(key)) {
      warnings.push(`line ${index + 1}: 허용되지 않은 key ${key}`);
      continue;
    }
    if (!value || !MACHINE_PROFILE_VALUE_RE.test(value)) {
      warnings.push(`line ${index + 1}: ${key} 값이 안전한 literal이 아님`);
      continue;
    }
    values[key] = value;
  }
  return { values, warnings };
}

// HUD 등 소비자가 프로파일 부재로 중단되지 않도록 읽기 실패 시 예외를 던지지 않는다.
export function readMachineProfile({
  env = process.env,
  platform = process.platform,
  home,
} = {}) {
  const path = resolveMachineProfilePath({ platform, env, home });
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    const warnings =
      error?.code === "ENOENT"
        ? []
        : [`machine profile 읽기 실패: ${error?.message || String(error)}`];
    return { path, exists: false, values: {}, warnings };
  }
  const parsed = parseMachineProfileContent(content);
  return {
    path,
    exists: true,
    values: parsed.values,
    warnings: parsed.warnings,
  };
}

// bash ${VAR+x} 와 같게 빈 문자열도 존재로 보되, child_process 가 넘기지 않는 undefined 는 제외한다.
function hasEnvKey(env, key) {
  if (!env) return false;
  if (!Object.hasOwn(env, key)) return false;
  return env[key] !== undefined;
}

// 셸 원값의 줄바꿈과 제어문자가 한 줄 경고 문맥을 깨지 않게 공백으로 접는다.
function describeUnsafeValue(value) {
  const folded = String(value ?? "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  return folded.length > 40 ? `${folded.slice(0, 40)}...` : folded;
}

// tfx-route.sh 는 오타 값에서 exit 하지만, HUD 나 hook 소비자가 중단되지 않게 허용으로 두고 경고만 남긴다.
export function resolveCliPolicy(env = process.env, opts = {}) {
  const profile =
    opts.profile ??
    readMachineProfile({
      env,
      platform: opts.platform ?? process.platform,
      home: opts.home,
    });
  const warnings = [...(profile?.warnings || [])];
  const disabled = {};
  const source = {};

  for (const cli of Object.keys(CLI_DISABLE_KEYS)) {
    const key = CLI_DISABLE_KEYS[cli];
    let raw;
    if (hasEnvKey(env, key)) {
      raw = env[key];
      source[cli] = "env";
    } else if (Object.hasOwn(profile?.values || {}, key)) {
      raw = profile.values[key];
      source[cli] = "profile";
    } else {
      raw = "0";
      source[cli] = "default";
    }

    const normalized = String(raw ?? "").trim();
    if (normalized === "1") {
      disabled[cli] = true;
    } else if (normalized === "0" || normalized === "") {
      disabled[cli] = false;
    } else {
      disabled[cli] = false;
      warnings.push(
        `${key} 값은 0 또는 1이어야 함 (현재: ${describeUnsafeValue(normalized)}, source: ${source[cli]}). 허용으로 둔다.`,
      );
    }
  }

  return {
    codexDisabled: disabled.codex,
    antigravityDisabled: disabled.antigravity,
    claudeDisabled: disabled.claude,
    source: {
      codex: source.codex,
      antigravity: source.antigravity,
      claude: source.claude,
    },
    profilePath: profile?.exists ? profile.path : null,
    warnings,
  };
}

export function normalizeCliName(cli) {
  const key = String(cli ?? "")
    .trim()
    .toLowerCase();
  return CLI_ALIASES[key] || null;
}

// tfx-route.sh exit 78 정책과 같게 조용한 강등을 금지하고 원인과 해제 방법을 함께 담는다.
export function buildDisabledCliError(cli, policy) {
  const name = normalizeCliName(cli);
  if (!name) return null;
  const isDisabled =
    name === "codex"
      ? policy?.codexDisabled
      : name === "claude"
        ? policy?.claudeDisabled
        : policy?.antigravityDisabled;
  if (!isDisabled) return null;

  const key = CLI_DISABLE_KEYS[name];
  const source = policy?.source?.[name] || "profile";
  const error = new Error(
    `${key}=1 (source: ${source}): ${name} 실행이 machine profile 정책으로 차단됨. ` +
      `이번 실행만 허용하려면 ${key}=0, 영구 변경은 node scripts/setup.mjs --machine-profile-only 로 프로파일을 다시 캡처한다. ` +
      "Claude native 로 조용히 강등하지 않는다.",
  );
  error.code = "TFX_CLI_DISABLED";
  error.cli = name;
  return error;
}
