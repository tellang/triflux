// triflux machine profile 공용 리더 (dep-free)
//
// machine profile 은 이 머신에서 어떤 CLI 실행을 허용했는지 기록한 정책 파일이다.
// 지금까지 판독 로직이 scripts/setup.mjs(JS)와 scripts/tfx-route.sh(bash) 두 벌로
// 갈라져 있었다. 이 모듈이 JS 쪽 단일 정본이고, bash 판독과 같은 의미를 유지한다.
//
// 신뢰 경계: 파일을 source 하거나 eval 하지 않는다. allowlist key 와 안전한
// literal 값만 읽으므로 셸 표현식은 실행되지 않는다.
//
// 부수효과: 모듈 로드 시 파일을 읽지 않고 환경도 바꾸지 않는다. hub/lib/cto-env.mjs
// 처럼 순수 함수만 노출하므로 HUD, hook, hub 어느 소비자에서도 안전하게 import 한다.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MACHINE_PROFILE_FILENAME = "machine-profile.env";

export const MACHINE_PROFILE_KEYS = Object.freeze([
  "TFX_MACHINE_PROFILE_VERSION",
  "TFX_MACHINE_OS",
  "TFX_MULTIPLEXER_POLICY",
  "TFX_DISABLE_CODEX",
  "TFX_DISABLE_ANTIGRAVITY",
  "TFX_TIMEOUT_POLICY",
  "TFX_HARD_CEILING_SEC",
  "TFX_STALL_THRESHOLD",
  "TFX_STALL_KILL",
]);

export const MACHINE_PROFILE_KEY_SET = new Set(MACHINE_PROFILE_KEYS);

export const MACHINE_PROFILE_VALUE_RE = /^[A-Za-z0-9_.-]+$/u;

// CLI 이름과 disable 키의 대응. 이 두 개가 TFX_DISABLE_* SSOT 의 전부다.
const CLI_DISABLE_KEYS = Object.freeze({
  codex: "TFX_DISABLE_CODEX",
  antigravity: "TFX_DISABLE_ANTIGRAVITY",
});

// 호출자가 쓰는 CLI 표기를 정책 키 두 개로 접는다. agy 와 gemini 는 antigravity
// 레인의 다른 이름이므로 같은 정책을 적용한다.
const CLI_ALIASES = Object.freeze({
  codex: "codex",
  antigravity: "antigravity",
  agy: "antigravity",
  gemini: "antigravity",
});

/**
 * setup.mjs 가 쓰던 home 해석과 같은 결과를 낸다.
 *
 * Windows 의 os.homedir() 는 USERPROFILE 만 보고 process.env.HOME swap 을 무시해서,
 * fixture 로 격리한 자식 프로세스가 실제 홈의 설정을 건드릴 수 있다 (#193 회귀).
 * 우선순위: TRIFLUX_TEST_HOME, 그다음 win32 면 USERPROFILE, HOME 순, 마지막이 homedir().
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {string}
 */
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

/**
 * machine profile 파일 경로를 해석한다. TFX_MACHINE_PROFILE_PATH 가 있으면
 * 그것만 쓰고, 없으면 OS 별 user-state 경로를 만든다.
 *
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string}
 */
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

/**
 * KEY=VALUE 본문을 allowlist 기준으로 파싱한다. 허용되지 않은 key 와 안전하지
 * 않은 literal 은 값으로 인정하지 않고 warnings 에만 남긴다.
 *
 * @param {string} content
 * @returns {{ values: Record<string, string>, warnings: string[] }}
 */
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

/**
 * machine profile 파일을 읽는다. 파일이 없거나 읽기에 실패해도 예외를 던지지
 * 않는다. HUD 같은 소비자가 프로파일 부재로 죽으면 안 되기 때문이다.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, home?: string }} [options]
 * @returns {{ path: string, exists: boolean, values: Record<string, string>, warnings: string[] }}
 */
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

// env 에 키가 존재하는지 판정한다. bash 의 `${VAR+x}` 와 같은 의미라서 값이 빈
// 문자열이어도 "존재"로 본다. 다만 값이 undefined 인 항목은 child_process 가
// 자식에게 넘기지 않으므로 부재로 취급한다.
function hasEnvKey(env, key) {
  if (!env) return false;
  if (!Object.hasOwn(env, key)) return false;
  return env[key] !== undefined;
}

// env 원값은 셸이 준 임의 문자열이라 줄바꿈이나 제어문자가 섞일 수 있다. 경고
// 문장은 세션 문맥 한 줄에 그대로 실리므로 공백으로 접고 길이를 자른다.
function describeUnsafeValue(value) {
  const folded = String(value ?? "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  return folded.length > 40 ? `${folded.slice(0, 40)}...` : folded;
}

/**
 * CLI 실행 허용 정책을 해석한다. 우선순위는 scripts/tfx-route.sh 와 같다:
 * 런타임 env 에 키가 있으면 그 값, 없으면 machine profile, 둘 다 없으면 "0".
 *
 * 값 해석도 bash 와 같다. 정확히 "1" 이면 차단이고, "0" 과 빈 문자열은 허용이다.
 * tfx-route.sh 는 그 밖의 값에서 exit 하지만, 여기서는 허용으로 두고 경고만
 * 남긴다. HUD 나 hook 같은 소비자가 오타 하나로 죽으면 안 되기 때문이다.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ profile?: ReturnType<typeof readMachineProfile>, platform?: string, home?: string }} [opts]
 */
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
    source: { codex: source.codex, antigravity: source.antigravity },
    profilePath: profile?.exists ? profile.path : null,
    warnings,
  };
}

/**
 * CLI 표기를 정책 키 이름으로 정규화한다. 모르는 이름은 null 이다.
 *
 * @param {string} cli
 * @returns {"codex"|"antigravity"|null}
 */
export function normalizeCliName(cli) {
  const key = String(cli ?? "")
    .trim()
    .toLowerCase();
  return CLI_ALIASES[key] || null;
}

/**
 * 세션 문맥 주입용 한 줄. 형식은 고정이며 소비자가 파싱하지 않고 그대로 보여준다.
 *
 * @param {ReturnType<typeof resolveCliPolicy>} policy
 * @returns {string}
 */
export function formatCliPolicyLine(policy) {
  const codex = policy?.codexDisabled ? "off" : "on";
  const antigravity = policy?.antigravityDisabled ? "off" : "on";
  const codexSource = policy?.source?.codex || "default";
  const antigravitySource = policy?.source?.antigravity || "default";
  return `cli-policy: codex=${codex} antigravity=${antigravity} (SSOT: TFX_DISABLE_*; codex<-${codexSource}, antigravity<-${antigravitySource})`;
}

/**
 * 차단된 CLI 실행 요청에 쓸 오류를 만든다. throw 는 호출자가 한다. 정책상 허용된
 * CLI 이거나 모르는 이름이면 null 을 준다.
 *
 * 메시지에 원인과 해제 방법을 모두 넣는다. tfx-route.sh 의 exit 78 정책과 같은
 * 정신이며, 조용한 강등을 금지한다.
 *
 * @param {string} cli
 * @param {ReturnType<typeof resolveCliPolicy>} policy
 * @returns {Error|null}
 */
export function buildDisabledCliError(cli, policy) {
  const name = normalizeCliName(cli);
  if (!name) return null;
  const isDisabled =
    name === "codex" ? policy?.codexDisabled : policy?.antigravityDisabled;
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
