#!/usr/bin/env node

// triflux 설치 및 업데이트 설정 스크립트
// - tfx-route.sh를 ~/.claude/scripts/에 동기화
// - hud-qos-status.mjs를 ~/.claude/hud/에 동기화
// - skills/를 ~/.claude/skills/에 동기화

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, delimiter, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { ensureAgyHooks } from "./ensure-agy-hooks.mjs";
import { ensureCodexHooks } from "./ensure-codex-hooks.mjs";
import { cleanupLegacyHooks } from "./lib/legacy-hook-cleanup.mjs";
import { cleanupLegacyMcp, cleanupTfxHub } from "./lib/legacy-mcp-cleanup.mjs";
import {
  MACHINE_PROFILE_KEYS,
  parseMachineProfileContent,
  resolveMachineProfilePath,
  resolveTrifluxHome,
} from "./lib/machine-profile.mjs";
import { parseFrontmatter } from "./lib/skill-template.mjs";
import { cleanupTmpFiles } from "./tmp-cleanup.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// home 해석은 scripts/lib/machine-profile.mjs 가 정본이다. Windows 의 os.homedir()
// 가 process.env.HOME swap 을 무시해 fixture 격리한 자식 프로세스가 실제 홈을
// 건드리던 문제(#193 회귀)까지 그 모듈이 담고 있다.
const _TFX_HOME = resolveTrifluxHome();
const CLAUDE_DIR = join(_TFX_HOME, ".claude");
const CODEX_DIR = join(_TFX_HOME, ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");
const SETUP_MARKER_PATH = join(CLAUDE_DIR, "cache", "tfx-setup-marker.json");

// machine profile 판독은 공용 리더로 이관했다. 기존 import 표면을 유지하려고
// 같은 이름으로 다시 내보낸다.
export { parseMachineProfileContent, resolveMachineProfilePath };

function commandAvailableOnPath(command, { env = process.env, platform } = {}) {
  const selectedPlatform = platform || process.platform;
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }
  const pathSeparator = selectedPlatform === "win32" ? ";" : delimiter;
  const extensions =
    selectedPlatform === "win32"
      ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const directory of String(env.PATH || "").split(pathSeparator)) {
    if (!directory) continue;
    for (const extension of extensions) {
      if (existsSync(join(directory, `${command}${extension}`))) return true;
      if (
        selectedPlatform === "win32" &&
        existsSync(join(directory, `${command}${extension.toLowerCase()}`))
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseSetupBoolean(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${key} 값은 0 또는 1이어야 합니다. (현재: ${raw})`);
}

function isEnabledEnvironmentFlag(value) {
  if (value === undefined || value === null || value === "") return false;
  return !/^(0|false|no|off)$/iu.test(String(value));
}

function parseSetupNonNegativeInteger(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${key} 값은 0 이상의 정수여야 합니다. (현재: ${raw})`);
  }
  return Number(raw);
}

function parseSetupPositiveInteger(env, key, fallback) {
  const value = parseSetupNonNegativeInteger(env, key, fallback);
  if (value < 1) {
    throw new Error(`${key} 값은 1 이상의 정수여야 합니다. (현재: ${value})`);
  }
  return value;
}

function parseSetupStallKill(env, fallback) {
  const raw = env.TFX_SETUP_STALL_KILL;
  if (raw === undefined || raw === "") return fallback;
  if (["kill", "classify", "intervene"].includes(raw)) return raw;
  throw new Error(
    `TFX_SETUP_STALL_KILL 값은 kill, classify, intervene 중 하나여야 합니다. (현재: ${raw})`,
  );
}

function timeoutBackendAvailable({
  platform,
  env,
  commandAvailable,
  timeoutCommandAvailable,
}) {
  if (typeof timeoutCommandAvailable === "function") {
    return Boolean(timeoutCommandAvailable());
  }
  if (existsSync("/usr/bin/timeout")) return true;
  if (commandAvailable("gtimeout", { platform, env })) return true;
  if (platform !== "win32" && commandAvailable("timeout", { platform, env })) {
    return true;
  }
  return false;
}

function deriveTimeoutPolicy(hardCeilingSec, stallKill) {
  if (hardCeilingSec === 0 && stallKill === "classify") return "visible";
  if (hardCeilingSec === 21600 && stallKill === "kill") return "unattended";
  return "custom";
}

export function buildMachineProfileDefaults({
  platform,
  env = process.env,
  interactive,
  commandAvailable,
}) {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`지원하지 않는 machine profile OS: ${platform}`);
  }
  const visibleDefaults = interactive && Boolean(env.TMUX);
  const detectedCodex = commandAvailable("codex", { platform, env });
  const detectedAntigravity =
    commandAvailable("agy", { platform, env }) ||
    commandAvailable("antigravity", { platform, env });
  const useCodex = parseSetupBoolean(env, "TFX_SETUP_USE_CODEX", detectedCodex);
  const useAntigravity = parseSetupBoolean(
    env,
    "TFX_SETUP_USE_ANTIGRAVITY",
    detectedAntigravity,
  );
  const hardCeilingSec = parseSetupNonNegativeInteger(
    env,
    "TFX_SETUP_HARD_CEILING_SEC",
    visibleDefaults ? 0 : 21600,
  );
  const stallThreshold = parseSetupPositiveInteger(
    env,
    "TFX_SETUP_STALL_THRESHOLD",
    1200,
  );
  const stallKill = parseSetupStallKill(
    env,
    visibleDefaults ? "classify" : "kill",
  );

  return {
    TFX_MACHINE_PROFILE_VERSION: "1",
    TFX_MACHINE_OS: platform,
    TFX_MULTIPLEXER_POLICY: platform === "win32" ? "psmux" : "tmux",
    TFX_DISABLE_CODEX: useCodex ? "0" : "1",
    TFX_DISABLE_ANTIGRAVITY: useAntigravity ? "0" : "1",
    TFX_TIMEOUT_POLICY: deriveTimeoutPolicy(hardCeilingSec, stallKill),
    TFX_HARD_CEILING_SEC: String(hardCeilingSec),
    TFX_STALL_THRESHOLD: String(stallThreshold),
    TFX_STALL_KILL: stallKill,
  };
}

async function promptMachineProfile(defaults, { input, output }) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input, output });

  const askBoolean = async (question, defaultValue) => {
    while (true) {
      const suffix = defaultValue ? "Y/n" : "y/N";
      const answer = (await rl.question(`${question} [${suffix}] `))
        .trim()
        .toLowerCase();
      if (!answer) return defaultValue;
      if (["y", "yes", "1"].includes(answer)) return true;
      if (["n", "no", "0"].includes(answer)) return false;
      output.write("  y 또는 n으로 입력하세요.\n");
    }
  };

  const askInteger = async (question, defaultValue, { allowZero }) => {
    while (true) {
      const answer = (
        await rl.question(`${question} [${defaultValue}] `)
      ).trim();
      if (!answer) return defaultValue;
      if (/^(0|[1-9][0-9]*)$/u.test(answer)) {
        const value = Number(answer);
        if (allowZero || value > 0) return value;
      }
      output.write(
        allowZero
          ? "  0 이상의 정수를 입력하세요.\n"
          : "  1 이상의 정수를 입력하세요.\n",
      );
    }
  };

  const useCodex = await askBoolean(
    "Codex를 이 머신에서 사용합니까?",
    defaults.TFX_DISABLE_CODEX === "0",
  );
  const useAntigravity = await askBoolean(
    "Antigravity를 이 머신에서 사용합니까?",
    defaults.TFX_DISABLE_ANTIGRAVITY === "0",
  );
  const hardCeilingSec = await askInteger(
    "Hard ceiling 초 (0=비활성)",
    Number(defaults.TFX_HARD_CEILING_SEC),
    { allowZero: true },
  );
  const stallThreshold = await askInteger(
    "무출력 stall 판단 초",
    Number(defaults.TFX_STALL_THRESHOLD),
    { allowZero: false },
  );
  let stallKill;
  while (true) {
    const answer = (
      await rl.question(
        `Stall 동작 (kill/classify/intervene) [${defaults.TFX_STALL_KILL}] `,
      )
    )
      .trim()
      .toLowerCase();
    stallKill = answer || defaults.TFX_STALL_KILL;
    if (["kill", "classify", "intervene"].includes(stallKill)) break;
    output.write("  kill, classify, intervene 중 하나를 입력하세요.\n");
  }
  rl.close();

  return {
    ...defaults,
    TFX_DISABLE_CODEX: useCodex ? "0" : "1",
    TFX_DISABLE_ANTIGRAVITY: useAntigravity ? "0" : "1",
    TFX_TIMEOUT_POLICY: deriveTimeoutPolicy(hardCeilingSec, stallKill),
    TFX_HARD_CEILING_SEC: String(hardCeilingSec),
    TFX_STALL_THRESHOLD: String(stallThreshold),
    TFX_STALL_KILL: stallKill,
  };
}

function serializeMachineProfile(profile) {
  return `${[
    "# Triflux machine profile v1 — generated by scripts/setup.mjs",
    "# Parsed as allowlisted literals; never sourced as shell code.",
    ...MACHINE_PROFILE_KEYS.map((key) => `${key}=${profile[key]}`),
  ].join("\n")}\n`;
}

export function writeMachineProfileAtomic(
  profilePath,
  profile,
  {
    platform = process.platform,
    pid = process.pid,
    now = Date.now,
    mkdir = mkdirSync,
    write = writeFileSync,
    chmod = chmodSync,
    rename = renameSync,
    remove = unlinkSync,
  } = {},
) {
  mkdir(dirname(profilePath), { recursive: true });
  const tempPath = `${profilePath}.${pid}.${now()}.tmp`;
  write(tempPath, serializeMachineProfile(profile), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    if (platform !== "win32") chmod(tempPath, 0o600);
    rename(tempPath, profilePath);
  } catch (error) {
    try {
      remove(tempPath);
    } catch {}
    throw error;
  }
}

export async function ensureMachineProfile({
  platform = process.platform,
  env = process.env,
  home = _TFX_HOME,
  force = false,
  interactive,
  nonInteractive = false,
  input = process.stdin,
  output = process.stdout,
  commandAvailable = commandAvailableOnPath,
  timeoutCommandAvailable,
} = {}) {
  const profilePath = resolveMachineProfilePath({ platform, env, home });
  const implicitTestRun =
    !env.TFX_MACHINE_PROFILE_PATH &&
    !env.TRIFLUX_TEST_HOME &&
    (env.NODE_ENV === "test" ||
      env.TFX_TEST === "1" ||
      Boolean(env.TEST_LOCK_PID) ||
      Boolean(env.NODE_TEST_CONTEXT) ||
      Boolean(env.NODE_TEST_WORKER_ID));
  if (implicitTestRun) {
    return {
      changed: false,
      skipped: true,
      path: profilePath,
      profile: {},
      warnings: [],
      interactive: false,
    };
  }
  if (existsSync(profilePath) && !force) {
    const parsed = parseMachineProfileContent(
      readFileSync(profilePath, "utf8"),
    );
    return {
      changed: false,
      path: profilePath,
      profile: parsed.values,
      warnings: parsed.warnings,
      interactive: false,
    };
  }

  const canPrompt =
    interactive ??
    (!nonInteractive &&
      !isEnabledEnvironmentFlag(env.CI) &&
      !isEnabledEnvironmentFlag(env.DOCKER) &&
      env.npm_lifecycle_event !== "postinstall" &&
      Boolean(input?.isTTY) &&
      Boolean(output?.isTTY));
  const defaults = buildMachineProfileDefaults({
    platform,
    env,
    interactive: canPrompt,
    commandAvailable,
  });
  const profile = canPrompt
    ? await promptMachineProfile(defaults, { input, output })
    : defaults;
  const warnings = [];
  if (
    Number(profile.TFX_HARD_CEILING_SEC) > 0 &&
    !timeoutBackendAvailable({
      platform,
      env,
      commandAvailable,
      timeoutCommandAvailable,
    })
  ) {
    warnings.push(
      "hard ceiling이 요청됐지만 timeout/gtimeout이 없어 비활성 상태입니다. macOS: brew install coreutils",
    );
  }
  if (!canPrompt) {
    warnings.push(
      "non-interactive 설치: CLI 사용 여부는 자동감지/TFX_SETUP_* 값, timeout은 unattended-safe 기본값을 사용했습니다.",
    );
  }
  if (
    profile.TFX_HARD_CEILING_SEC === "0" &&
    profile.TFX_STALL_KILL === "classify"
  ) {
    warnings.push(
      "hard ceiling과 stall kill이 모두 꺼져 headless/CI 경로도 무제한 실행될 수 있습니다.",
    );
  }
  writeMachineProfileAtomic(profilePath, profile);
  return {
    changed: true,
    path: profilePath,
    profile,
    warnings,
    interactive: canPrompt,
  };
}

// ── 로컬 개발 모드 감지 ──

/**
 * PLUGIN_ROOT에 .git 디렉토리가 존재하면 dev mode (git clone 직접 사용)로 판정.
 * @param {string} [root] - 검사할 루트 경로 (기본: PLUGIN_ROOT)
 * @returns {boolean}
 */
function detectDevMode(root = PLUGIN_ROOT) {
  return existsSync(join(root, ".git"));
}

const BREADCRUMB_PATH = join(CLAUDE_DIR, "scripts", ".tfx-pkg-root");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const HUD_PATH = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");

const REQUIRED_CODEX_PROFILES = [
  // GPT-6 Astra: max/ultra are explicit exception lanes, not role defaults.
  {
    name: "gpt6_astra_ultra",
    lines: ['model = "gpt-6-astra"', 'model_reasoning_effort = "ultra"'],
  },
  {
    name: "gpt6_astra_max",
    lines: ['model = "gpt-6-astra"', 'model_reasoning_effort = "max"'],
  },
  {
    name: "gpt6_astra_xhigh",
    lines: ['model = "gpt-6-astra"', 'model_reasoning_effort = "xhigh"'],
  },
  // GPT-6.1 Sol: implementation, review, and verification role defaults.
  {
    name: "gpt61_sol_high",
    lines: ['model = "gpt-6.1-sol"', 'model_reasoning_effort = "high"'],
  },
  {
    name: "gpt61_sol_med",
    lines: ['model = "gpt-6.1-sol"', 'model_reasoning_effort = "medium"'],
  },
  // GPT-6 Luna: high for focused lanes, low for latency-first lanes.
  {
    name: "gpt6_luna_high",
    lines: ['model = "gpt-6-luna"', 'model_reasoning_effort = "high"'],
  },
  {
    name: "gpt6_luna_low",
    lines: ['model = "gpt-6-luna"', 'model_reasoning_effort = "low"'],
  },
];

// Codex 0.134 마이그레이션: triflux 가 과거에 inline [profiles.*] 로 썼던 구형 프로필.
// config.toml 에서 제거 대상 (retired 모델 — 별도 파일로 만들지 않는다).
const LEGACY_CODEX_PROFILE_NAMES = [
  "gpt55_xhigh",
  "gpt55_high",
  "gpt55_med",
  "gpt55_low",
  "codex53_high",
  "codex53_xhigh",
  "codex53_med",
  "spark53_low",
  "spark53_med",
  "gpt54_xhigh",
  "gpt54_high",
  "gpt54_low",
  "mini54_low",
  "mini54_med",
  "mini54_high",
];

const HUD_SYNC_EXCLUDES = new Set(["omc-hud.mjs", "omc-hud.mjs.bak"]);
const SETUP_USER_STATE_FILES = new Set(["hosts.json"]);
const WORKER_PACKAGE_SPECS = [
  {
    packageName: "@triflux/core",
    workspacePath: ["packages", "core"],
    workspaceSibling: "core",
    modulePath: ["@triflux", "core"],
  },
  {
    packageName: "@triflux/remote",
    workspacePath: ["packages", "remote"],
    workspaceSibling: "remote",
    modulePath: ["@triflux", "remote"],
  },
];

function isSetupUserStateFile(fileName) {
  return SETUP_USER_STATE_FILES.has(fileName);
}

/**
 * scripts/lib/*.mjs 및 *.sh 자동 스캔.
 * 수동 리스트 대신 glob으로 탐색하여 lib 파일 추가 시 sync 누락 방지.
 */
function scanLibFiles(pluginRoot, claudeDir) {
  const libDir = join(pluginRoot, "scripts", "lib");
  if (!existsSync(libDir)) return [];
  return readdirSync(libDir)
    .sort()
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".sh"))
    .map((f) => ({
      src: join(libDir, f),
      dst: join(claudeDir, "scripts", "lib", f),
      label: `lib/${f}`,
    }));
}

/**
 * hub/workers/**\/*.mjs + hub/ 루트의 worker 의존성 파일을 자동 스캔.
 * 서브디렉토리의 파일이 sync 에서 빠지지 않도록 재귀로 탐색한다.
 */
export function scanHubWorkerFiles(pluginRoot, claudeDir) {
  const results = [];
  const hubRoot = join(pluginRoot, "hub");
  if (!existsSync(hubRoot)) return results;

  // hub/workers/**/*.mjs 전체 (서브디렉토리 포함)
  const workersDir = join(hubRoot, "workers");
  if (existsSync(workersDir)) {
    const walkWorkers = (currentDir) => {
      const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
        (l, r) => l.name.localeCompare(r.name),
      );
      for (const entry of entries) {
        const absPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walkWorkers(absPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
        const rel = relative(workersDir, absPath).replace(/\\/g, "/");
        results.push({
          src: absPath,
          dst: join(claudeDir, "scripts", "hub", "workers", rel),
          label: `hub/workers/${rel}`,
        });
      }
    };
    walkWorkers(workersDir);
  }

  // hub/ 루트: worker가 import하는 의존성 (cli-adapter-base, platform 등)
  const hubRootDeps = ["cli-adapter-base.mjs", "platform.mjs"];
  for (const f of hubRootDeps) {
    if (existsSync(join(hubRoot, f))) {
      results.push({
        src: join(hubRoot, f),
        dst: join(claudeDir, "scripts", "hub", f),
        label: `hub/${f}`,
      });
    }
  }

  return results;
}

function scanHudFiles(pluginRoot, claudeDir) {
  const hudRoot = join(pluginRoot, "hud");
  if (!existsSync(hudRoot)) return [];

  const walk = (currentDir) => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );

    return entries.flatMap((entry) => {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        return walk(absolutePath);
      }

      if (
        !entry.isFile() ||
        HUD_SYNC_EXCLUDES.has(entry.name) ||
        !entry.name.endsWith(".mjs")
      ) {
        return [];
      }

      const hudRelativePath = relative(hudRoot, absolutePath);
      const normalizedRelativePath = hudRelativePath.replace(/\\/g, "/");

      return [
        {
          src: absolutePath,
          dst: join(claudeDir, "hud", hudRelativePath),
          label:
            normalizedRelativePath === "hud-qos-status.mjs"
              ? "hud-qos-status.mjs"
              : `hud/${normalizedRelativePath}`,
        },
      ];
    });
  };

  return walk(hudRoot);
}

// ── 파일 동기화 ──

const SYNC_MAP = [
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-route.sh"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-route.sh"),
    label: "tfx-route.sh",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-route-post.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-route-post.mjs"),
    label: "tfx-route-post.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-route-worker.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-route-worker.mjs"),
    label: "tfx-route-worker.mjs",
  },
  ...scanHubWorkerFiles(PLUGIN_ROOT, CLAUDE_DIR),
  // lib 는 hud 보다 먼저 복사한다. hud/cli-policy.mjs 가 ../scripts/lib/machine-profile.mjs
  // 를 정적 import 하므로, 동기화가 중간에 끊겨도 소비자만 있고 리더가 없는
  // 설치본이 남지 않게 한다. hooks/ 는 플러그인 루트에서 직접 import 되는 경로라
  // 이 복사 목록의 대상이 아니다.
  ...scanLibFiles(PLUGIN_ROOT, CLAUDE_DIR),
  // hud/providers/cto.mjs 가 ../../hub/lib/cto-env.mjs 를 정적 import 한다(ADR-0018).
  // 의존성 없는 env 판독 모듈이라 이 파일 하나만 hud 보다 먼저 복사한다.
  {
    src: join(PLUGIN_ROOT, "hub", "lib", "cto-env.mjs"),
    dst: join(CLAUDE_DIR, "hub", "lib", "cto-env.mjs"),
    label: "hub/lib/cto-env.mjs",
  },
  ...scanHudFiles(PLUGIN_ROOT, CLAUDE_DIR),
  {
    src: join(PLUGIN_ROOT, "hub", "team", "agent-map.json"),
    dst: join(CLAUDE_DIR, "hub", "team", "agent-map.json"),
    label: "hub/team/agent-map.json",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "remote-spawn.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "remote-spawn.mjs"),
    label: "remote-spawn.mjs",
  },
];

function getVersion(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/VERSION\s*=\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function shouldSyncTextFile(src, dst) {
  if (!existsSync(dst)) return true;
  try {
    return readFileSync(src, "utf8") !== readFileSync(dst, "utf8");
  } catch {
    return true;
  }
}

function findFirstExistingDir(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isWorkerPackageCopyCandidate(source) {
  const name = source.replace(/\\/g, "/").split("/").pop();
  return name !== "node_modules" && name !== ".git" && name !== ".DS_Store";
}

function getWorkerPackageSyncEntries({
  pluginRoot = PLUGIN_ROOT,
  workerNodeModules = join(CLAUDE_DIR, "scripts", "node_modules"),
} = {}) {
  const entries = [];

  for (const spec of WORKER_PACKAGE_SPECS) {
    const src = findFirstExistingDir([
      join(pluginRoot, ...spec.workspacePath),
      join(pluginRoot, "..", spec.workspaceSibling),
      join(pluginRoot, "node_modules", ...spec.modulePath),
      join(pluginRoot, "..", ...spec.modulePath),
      join(pluginRoot, "..", "..", ...spec.modulePath),
    ]);

    if (!src) continue;

    const dst = join(workerNodeModules, ...spec.modulePath);
    if (resolve(src) === resolve(dst)) continue;

    entries.push({
      src,
      dst,
      label: `${spec.packageName} worker package`,
    });
  }

  return entries;
}

function syncWorkerPackages(options = {}) {
  let count = 0;

  for (const { src, dst } of getWorkerPackageSyncEntries(options)) {
    mkdirSync(dirname(dst), { recursive: true });
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, {
      recursive: true,
      filter: isWorkerPackageCopyCandidate,
    });
    count++;
  }

  return count;
}

function getPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"))
      .version;
  } catch {
    return null;
  }
}

function readMarker() {
  if (!existsSync(SETUP_MARKER_PATH)) return null;

  try {
    return JSON.parse(readFileSync(SETUP_MARKER_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(marker) {
  const markerDir = dirname(SETUP_MARKER_PATH);
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    SETUP_MARKER_PATH,
    JSON.stringify(marker, null, 2) + "\n",
    "utf8",
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _normalizeErrorMessage(error, fallback = "unknown error") {
  const isMeaningful = (value) => {
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return normalized !== "undefined" && normalized !== "null";
  };

  if (error instanceof Error && isMeaningful(error.message)) {
    return error.message.trim();
  }
  if (isMeaningful(error)) return error.trim();
  if (error && typeof error === "object") {
    const candidate = /** @type {{ message?: unknown }} */ (error).message;
    if (isMeaningful(candidate)) return candidate.trim();
  }
  return fallback;
}

function hasProfileSection(tomlContent, profileName) {
  const section = `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*$`;
  return new RegExp(section, "m").test(tomlContent);
}

function replaceProfileSection(tomlContent, profileName, lines) {
  const header = `[profiles.${profileName}]`;
  const sectionRe = new RegExp(
    `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*\\n?(?:(?!\\[)[^\\n]*\\n?)*`,
    "m",
  );
  const replacement = `${header}\n${lines.join("\n")}\n`;
  return tomlContent.replace(sectionRe, replacement);
}

// Codex 0.134+ 마이그레이션: config.toml 의 inline [profiles.NAME] 테이블을 제거한다.
// (프로필은 별도 파일 ~/.codex/NAME.config.toml 로 이동했고, inline 테이블은 0.134 에서
//  `--profile NAME` 사용 시 거부되므로 잔존 inline 을 정리해야 한다.)
function removeProfileSection(tomlContent, profileName) {
  const sectionRe = new RegExp(
    `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*\\n?(?:(?!\\[)[^\\n]*\\n?)*`,
    "m",
  );
  return tomlContent.replace(sectionRe, "");
}

// config.toml 에 inline 으로 정의된 모든 [profiles.NAME] 의 NAME 목록을 반환한다.
function listInlineProfileNames(tomlContent) {
  const names = [];
  const re = /^\[profiles\.([\w-]+)\]\s*$/gm;
  let match;
  while ((match = re.exec(tomlContent)) !== null) {
    names.push(match[1]);
  }
  return names;
}

// inline [profiles.NAME] 테이블의 본문(key = value 라인들)을 추출한다.
// 커스텀 프로필을 별도 파일로 이관할 때 내용을 보존하기 위해 사용한다.
function extractProfileLines(tomlContent, profileName) {
  const re = new RegExp(
    `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*\\n((?:(?!\\[)[^\\n]*\\n?)*)`,
    "m",
  );
  const match = tomlContent.match(re);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Legacy aliases were removed from the packaged skill surface, so setup must
// not recreate them. Existing local aliases remain protected from cleanup for
// the v10 migration window.
const SKILL_ALIASES = [];
const LEGACY_ALIAS_TOMBSTONES = new Set([
  "tfx-autopilot",
  "tfx-persist",
  "tfx-fullcycle",
]);
// 위 tombstone 은 설치본을 cleanup 에서 *보호*한다. 기능째 지운 스킬(스킬 표면
// 축소로 제거한 tfx-ralph, tfx-qa 등)은 여기에 넣지 않는다 — 넣으면 낡은 설치본이
// 영구히 남는다. 패키지에 없으면 cleanupStaleSkills 가 설치본을 지운다.

// ── 폐기 예정 스킬 목록 ──

const DEPRECATED_SKILLS = ["tfx-codex-route", "tfx-gemini-route"];
const LOCAL_DEV_SKILL_MARKER = ".triflux-local-skill";
const MANAGED_CODEX_SKILL_MARKER = ".triflux-managed-skill";
// ADR-0020 제거 직전(612b1e91^)과 이번 제거 직전 원본의 SKILL.md 단독/전체 트리 지문.
const REMOVED_SKILL_HASHES = {
  "tfx-ralph": [
    "4a4145a6242a76c05104dfbaa154607deee220944d4d26f4612f07973762d7ac",
    "982126ae9b3dc39ef28f06fa39e08352c82ed478527ae01eaf9786abe1e98829",
  ],
  "tfx-forge": [
    "b966faf22a89f59f6f59f629b0088b01373e2b3fdfd5b47b6c6773f7d129304a",
    "b9b10dd358848f7201b2526f452e8d0d939356578ca93611c581e0fee6f59f8a",
  ],
  "tfx-find": [
    "8e4837fa1ec5d51c1297c98c76bae0fdb7f4d52196a7c38f17463ad7b235ec34",
    "f5174a7330eefe0255356f4e5b5519120e4d8a69eeb3f9cca3a5b7c46b99d31c",
  ],
  "tfx-index": [
    "2531f5a016169e3f87091c8b2032a8a1efa843df54f230603fd0a242682d857e",
    "26b9b94802961d982e695b22af93264ed87d7a39b57e80957c97811ed13779de",
  ],
  "tfx-goal-clarify": [
    "1932752fee5a1d2b4934960b95135ac02550d114eaf2421e3d943315d3943183",
    "926f16e40213dc97bb4bea34923854df72d9259bec34eb8373fd8aed01ee4b98",
  ],
  "tfx-hooks": [
    "9a24a86b246b53a121f548e44c858e56f3ba4de49d1f7572e64bf95d1318a02d",
    "b3bb55a9be027498e25f9e1f317d228c0fb08007e0827cd97682acc9c661b7a2",
  ],
  "tfx-hub": [
    "eb71c0767620c342ebf5add9a6fabf271a03456237ae77a959fedb30080ae47a",
    "46401764a1cda1e20a21b39678e31b2416aca7ce72e9dda0933673881d007ee0",
  ],
  "tfx-analysis": [
    "24cd2746d0cfa2382a643900401874c083bcf1c1b67aa0420681233c634daa13",
    "8c345dce0ea557635a5163c7d1810bc20ae3ca69074d4107bc2726335799589e",
  ],
  "tfx-prune": [
    "04f20d1206fc038c72f2e79f890eaff94c988f6c129db7b0e53ae249731e6138",
    "0a9e8fa5f6469f756ff7cc97fa4ee8ba29509a7fa2472bb2f6e522ea62e22de6",
  ],
  "tfx-qa": [
    "2bec88749d08849650830055c4cec9622bad91f93246b04e5d4fb58f3ad1a036",
    "f5f9c6e036d5a965931ab9a6c6b23c41886cd370edf90e46f19d119516e05d1a",
  ],
  "tfx-plan": [
    "af4427146af67849cc89d36787115d9bfc3b643a38208def9014234b05875e00",
    "bf854e64db158d3fc4faa5995921e357304ef559fad43a3b60b8258e3f685f27",
  ],
  "tfx-interview": [
    "c98438dc65cc6902934804e51e739c6e356053c1d3e823e5a4cbfdf677474ca9",
    "5281bfac1ab926215cef40f6ac28305fb3525a9f5266b7d3e00b6fe12f41cac2",
  ],
  "tfx-profile": [
    "294b440c8d71290263054c5143f1ceddd995da7271e39e14bc96f7a73002dd25",
    "82c6397a124d39f637e103f0f02d0ac4a6cbe171a45ad62671463e35507368eb",
  ],
  "merge-worktree": [
    "306bd5b6288505ff69fa9ed7037354891b75919d8ef1c8cbec0b4ebe55c17870",
    "b3ca6e3f7caa290bcbaf83cb4a30e1db2269d32726c56e32431905b2e25c9b6d",
  ],
  "star-prompt": [
    "b8c845284d33fae16ea8f3dc5f3d6e8c2e656c7ceb49bb464a9252ff745c900c",
    "b5ff7ca412dab7152d1661bcafa9735d12fa64f0e10c674eb9e6f0ecb535a1b7",
  ],
};
const REMOVED_SKILL_NAMES = Object.freeze(Object.keys(REMOVED_SKILL_HASHES));

// ── 구형 Codex 모델 (마이그레이션 안내 대상) ──

const LEGACY_CODEX_MODELS = ["o4-mini", "o3", "codex-mini-latest"];

/**
 * 별칭 스킬 디렉토리를 동기화한다.
 * 소스 스킬의 SKILL.md와 하위 파일을 별칭 디렉토리에 복사하면서
 * SKILL.md 내부의 소스 이름 참조를 별칭으로 치환한다.
 * @param {string} srcDir - 소스 스킬 디렉토리
 * @param {string} dstDir - 대상(별칭) 디렉토리
 * @param {{ alias: string, source: string }} meta - 별칭 메타 정보
 * @returns {number} 동기화된 파일 수
 */
function syncAliasedSkillDir(srcDir, dstDir, { alias, source }) {
  if (!existsSync(srcDir)) return 0;
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

  let count = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (isSetupUserStateFile(entry.name)) continue;

    if (entry.isDirectory()) {
      count += syncAliasedSkillDir(srcPath, dstPath, { alias, source });
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;

    const srcContent = readFileSync(srcPath, "utf8");
    const aliased = srcContent.replaceAll(source, alias);
    const existing = existsSync(dstPath) ? readFileSync(dstPath, "utf8") : null;
    if (aliased !== existing) {
      writeFileSync(dstPath, aliased, "utf8");
      count++;
    }
  }
  return count;
}

/**
 * SKILL.md frontmatter 의 `platform:` 목록(process.platform 값)을 읽는다.
 * SKILL.md의 `platform` 필드가 없거나 비어 있으면
 * 모든 플랫폼에 설치한다.
 * @param {string} skillDir - SKILL.md 가 든 스킬 디렉토리
 * @returns {string[]}
 */
function readSkillPlatforms(skillDir) {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return [];
  const raw = parseFrontmatter(readFileSync(skillMd, "utf8")).data.platform;
  // 블록 목록(`- win32`)은 배열로, 인라인(`[win32]`)은 문자열로 들어온다.
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.replace(/^\[|\]$/g, "").split(",")
      : [];
  return values
    .map((value) =>
      String(value)
        .trim()
        .replace(/^["']|["']$/g, ""),
    )
    .filter(Boolean);
}

function isSkillSupportedOnPlatform(skillDir, platform = process.platform) {
  const platforms = readSkillPlatforms(skillDir);
  return platforms.length === 0 || platforms.includes(platform);
}

function skillTreeHash(skillDir, skillOnly = false) {
  if (!existsSync(join(skillDir, "SKILL.md"))) return null;
  const hash = createHash("sha256");
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      if (skillOnly && entry.name !== "SKILL.md") continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!visit(join(dir, entry.name), `${name}/`)) return false;
      } else if (entry.isFile()) {
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(join(dir, entry.name)));
        hash.update("\0");
      } else {
        return false;
      }
    }
    return true;
  }
  return visit(skillDir) ? hash.digest("hex") : null;
}

function cleanupStaleSkills(
  installedDir,
  pkgDir,
  { platform = process.platform } = {},
) {
  const removed = [];
  const preserved = [];
  if (!existsSync(installedDir)) return { count: 0, removed, preserved };

  const pkgNames = new Set();
  if (existsSync(pkgDir)) {
    for (const n of readdirSync(pkgDir)) {
      if (isSkillSupportedOnPlatform(join(pkgDir, n), platform))
        pkgNames.add(n);
    }
  }
  for (const { alias } of SKILL_ALIASES) pkgNames.add(alias);
  for (const alias of LEGACY_ALIAS_TOMBSTONES) pkgNames.add(alias);
  for (const dep of DEPRECATED_SKILLS) pkgNames.add(dep);

  for (const name of readdirSync(installedDir)) {
    if (
      !Object.hasOwn(REMOVED_SKILL_HASHES, name) &&
      !existsSync(join(pkgDir, name))
    )
      continue;
    if (pkgNames.has(name)) continue;

    const skillPath = join(installedDir, name);
    if (isLocalDevSkillDir(skillPath)) {
      preserved.push(name);
      continue;
    }
    const managed = existsSync(join(skillPath, MANAGED_CODEX_SKILL_MARKER));
    const sourcePath = join(pkgDir, name);
    const hash = managed ? null : skillTreeHash(skillPath);
    const originals = [...(REMOVED_SKILL_HASHES[name] ?? [])];
    if (existsSync(sourcePath)) {
      originals.push(
        skillTreeHash(sourcePath),
        skillTreeHash(sourcePath, true),
      );
    }
    if (!managed && (!hash || !originals.includes(hash))) {
      preserved.push(name);
      continue;
    }
    try {
      rmSync(skillPath, { recursive: true, force: true });
      removed.push(name);
    } catch {
      preserved.push(name);
    }
  }
  return { count: removed.length, removed, preserved };
}

function isLocalDevSkillDir(skillPath) {
  return existsSync(join(skillPath, LOCAL_DEV_SKILL_MARKER));
}

function skillTreeMatches(srcDir, dstDir) {
  if (!existsSync(srcDir) || !existsSync(dstDir)) return false;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (!skillTreeMatches(srcPath, dstPath)) return false;
      continue;
    }
    if (!existsSync(dstPath)) return false;
    if (!readFileSync(srcPath).equals(readFileSync(dstPath))) return false;
  }
  return true;
}

// Codex 탐색 경로에 백업을 두면 별도 스킬로 등록된다.
function syncCodexHarnessAdapter({
  sourceDir = join(PLUGIN_ROOT, "adapters", "codex", "skills", "tfx-harness"),
  destinationDir = join(CODEX_DIR, "skills", "tfx-harness"),
  stagingRoot = null,
  platform = process.platform,
} = {}) {
  const sourceSkill = join(sourceDir, "SKILL.md");
  if (!existsSync(sourceSkill)) {
    return {
      ok: false,
      action: "blocked",
      reason: "codex_harness_adapter_source_missing",
      sourceDir,
      destinationDir,
    };
  }

  const managed = existsSync(join(destinationDir, MANAGED_CODEX_SKILL_MARKER));
  // Claude 스킬 동기화와 같은 frontmatter `platform:` 규칙. 비대상 플랫폼에는
  // 설치하지 않고, 우리가 깔아 둔(managed) 사본만 지운다.
  if (!isSkillSupportedOnPlatform(sourceDir, platform)) {
    if (managed) {
      rmSync(destinationDir, { recursive: true, force: true });
      return { ok: true, action: "removed", sourceDir, destinationDir };
    }
    return {
      ok: true,
      action: "unsupported",
      reason: "unsupported_platform",
      sourceDir,
      destinationDir,
    };
  }
  const current = skillTreeMatches(sourceDir, destinationDir);
  if (current && managed) {
    return { ok: true, action: "noop", sourceDir, destinationDir };
  }

  if (existsSync(destinationDir) && !managed) {
    return {
      ok: true,
      action: "skipped",
      reason: "user_owned_codex_skill",
      sourceDir,
      destinationDir,
    };
  }

  const destinationParent = dirname(destinationDir);
  const destinationName = basename(destinationDir);
  const replacementRoot =
    stagingRoot ||
    join(dirname(destinationParent), "backups", "triflux", "codex-skills");
  const tempDir = join(
    replacementRoot,
    `${destinationName}.triflux-tmp-${process.pid}-${Date.now()}`,
  );
  mkdirSync(destinationParent, { recursive: true });
  mkdirSync(replacementRoot, { recursive: true });

  let previousDir = null;
  try {
    cpSync(sourceDir, tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, MANAGED_CODEX_SKILL_MARKER),
      "managed by triflux\n",
    );
    if (existsSync(destinationDir)) {
      previousDir = join(
        replacementRoot,
        `${destinationName}.triflux-previous-${Date.now()}`,
      );
      renameSync(destinationDir, previousDir);
    }
    try {
      renameSync(tempDir, destinationDir);
    } catch (error) {
      if (
        previousDir &&
        existsSync(previousDir) &&
        !existsSync(destinationDir)
      ) {
        renameSync(previousDir, destinationDir);
      }
      throw error;
    }
    if (previousDir) {
      try {
        rmSync(previousDir, { recursive: true, force: true });
      } catch {
        // 복구본은 Codex 탐색 경로 밖에 둔다.
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return { ok: true, action: "synced", sourceDir, destinationDir };
}

function syncCodexManagedSkills({
  pluginRoot = PLUGIN_ROOT,
  codexDir = CODEX_DIR,
} = {}) {
  const liveAdapter = join(
    pluginRoot,
    "adapters",
    "codex",
    "skills",
    "tfx-live",
  );
  const leadSkill = join(pluginRoot, "skills", "tfx-lead");
  return [
    [
      "tfx-harness",
      join(pluginRoot, "adapters", "codex", "skills", "tfx-harness"),
    ],
    [
      "tfx-live",
      existsSync(liveAdapter)
        ? liveAdapter
        : join(pluginRoot, "skills", "tfx-live"),
    ],
    ...(existsSync(leadSkill) ? [["tfx-lead", leadSkill]] : []),
  ].map(([name, sourceDir]) => ({
    name,
    ...syncCodexHarnessAdapter({
      sourceDir,
      destinationDir: join(codexDir, "skills", name),
    }),
  }));
}

export function syncSkills({
  pluginRoot = PLUGIN_ROOT,
  claudeDir = CLAUDE_DIR,
  codexDir = CODEX_DIR,
  platform = process.platform,
} = {}) {
  const source = join(pluginRoot, "skills");
  const destination = join(claudeDir, "skills");
  const result = { ok: true, changed: 0, total: 0, warnings: [] };
  function syncDirectory(src, dst) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (isSetupUserStateFile(entry.name)) continue;
      const from = join(src, entry.name);
      const to = join(dst, entry.name);
      if (entry.isDirectory()) syncDirectory(from, to);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        shouldSyncTextFile(from, to)
      ) {
        copyFileSync(from, to);
        result.changed++;
      }
    }
  }
  if (existsSync(source)) {
    for (const name of readdirSync(source)) {
      const skill = join(source, name);
      if (
        !existsSync(join(skill, "SKILL.md")) ||
        !isSkillSupportedOnPlatform(skill, platform)
      )
        continue;
      syncDirectory(skill, join(destination, name));
      result.total++;
    }
    for (const { alias, source: name } of SKILL_ALIASES) {
      result.changed += syncAliasedSkillDir(
        join(source, name),
        join(destination, alias),
        { alias, source: name },
      );
    }
  }
  for (const installed of [destination, join(codexDir, "skills")]) {
    const stale = cleanupStaleSkills(installed, source, { platform });
    result.changed += stale.count;
    for (const name of stale.preserved)
      result.warnings.push(`구형 스킬 ${name}: 사용자 사본 보존`);
  }
  for (const skill of syncCodexManagedSkills({ pluginRoot, codexDir })) {
    if (skill.action === "synced") result.changed++;
    if (!skill.ok) {
      result.ok = false;
      result.warnings.push(`Codex ${skill.name}: ${skill.reason}`);
    } else if (skill.action === "skipped")
      result.warnings.push(`Codex ${skill.name}: 사용자 스킬 보존`);
  }
  return result;
}

function isProtectedCodexConfigMutationEnv(env = process.env) {
  return (
    env.NODE_ENV === "test" ||
    env.CI === "true" ||
    env.TFX_TEST === "1" ||
    Boolean(env.TRIFLUX_TEST_HOME)
  );
}

function isProtectedSetupEnv(env = process.env) {
  return (
    env.NODE_ENV === "test" ||
    env.CI === "true" ||
    env.TFX_TEST === "1" ||
    Boolean(env.TRIFLUX_TEST_HOME) ||
    Boolean(env.TEST_LOCK_PID) ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    Boolean(env.NODE_TEST_WORKER_ID)
  );
}

export function ensureTrifluxMods({
  install = false,
  env = process.env,
  execFileSyncFn = execFileSync,
  log = console.log,
  warn = console.warn,
} = {}) {
  if (isProtectedSetupEnv(env) || env.npm_lifecycle_event === "postinstall") {
    return { ok: true, skipped: true, reason: "protected-env" };
  }
  const run = (args) =>
    execFileSyncFn("claude", args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      windowsHide: true,
      shell: process.platform === "win32",
    });
  let version;
  try {
    version = String(run(["--version"]))
      .trim()
      .match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/u);
  } catch {
    return { ok: true, skipped: true, reason: "claude-unavailable" };
  }
  const [major, minor, patch] = (version?.slice(1) || []).map(Number);
  if (
    !(
      major > 2 ||
      (major === 2 && (minor > 1 || (minor === 1 && patch >= 287)))
    )
  ) {
    return { ok: true, skipped: true, reason: "unsupported-version" };
  }
  try {
    const marketplaces = JSON.parse(
      run(["plugin", "marketplace", "list", "--json"]),
    );
    const plugins = JSON.parse(run(["plugin", "list", "--json"]));
    const installed = plugins.some(
      (plugin) => plugin.id === "triflux-mods@triflux",
    );
    if (!marketplaces.some((marketplace) => marketplace.name === "triflux")) {
      run(["plugin", "marketplace", "add", "tellang/triflux"]);
    }
    if (!installed) {
      if (install) {
        run(["plugin", "install", "triflux-mods@triflux"]);
        log("mods 설치 완료: triflux-mods@triflux");
      } else {
        log("mods 설치: tfx setup --mods");
      }
    }
    return { ok: true, installed: installed || install };
  } catch (error) {
    warn(`[setup] mods 설정 실패: ${_normalizeErrorMessage(error)}`);
    return { ok: false, reason: "setup-failed" };
  }
}

// 예전에 배포했다가 그만둔 설치 파일. 내용에 배포 표식이 있을 때만 지운다.
const RETIRED_INSTALL_FILES = [
  [
    join(CLAUDE_DIR, "scripts", "tfx-batch-stats.mjs"),
    "tfx-batch-stats.mjs v1.0",
  ],
  [join(CLAUDE_DIR, "agents", "slim-wrapper.md"), "name: slim-wrapper"],
  [join(CLAUDE_DIR, "scripts", "notion-read.mjs"), "notion-read.mjs v"],
  [
    join(
      CLAUDE_DIR,
      "scripts",
      "hub",
      "workers",
      "codex-app-server-worker.mjs",
    ),
    "hub/workers/codex-app-server-worker.mjs",
  ],
  [
    join(CLAUDE_DIR, "scripts", "hub", "workers", "delegator-mcp.mjs"),
    "hub/workers/delegator-mcp.mjs",
  ],
  [
    join(CLAUDE_DIR, "scripts", "hub", "workers", "lib", "jsonrpc-stdio.mjs"),
    "hub/workers/lib/jsonrpc-stdio.mjs",
  ],
  [
    join(CLAUDE_DIR, "scripts", "hub", "account-broker.mjs"),
    "// hub/account-broker.mjs",
  ],
  [join(CLAUDE_DIR, "scripts", "hub-ensure.mjs"), "[hub-ensure]"],
  [join(CLAUDE_DIR, "scripts", "hub-watchdog.mjs"), "[hub-watchdog]"],
];

function removeRetiredInstallFiles(files = RETIRED_INSTALL_FILES) {
  const removed = [];
  for (const [file, marker] of files) {
    try {
      if (readFileSync(file, "utf8").includes(marker)) {
        unlinkSync(file);
        removed.push(file);
      }
    } catch {
      // 없거나 읽을 수 없으면 건드리지 않는다.
    }
  }
  return removed;
}

// Top-level config.toml keys that must exist with these defaults.
// Only injected when the key is completely absent — existing user values are
// never overwritten, regardless of what value was set.
const REQUIRED_TOP_LEVEL_SETTINGS = [
  { key: "model", value: '"gpt-6-astra"' },
  { key: "model_reasoning_effort", value: '"high"' },
  { key: "service_tier", value: '"fast"' },
];

function ensureCodexProfiles() {
  try {
    if (
      process.env.TFX_CODEX_CONFIG_SYNC !== "1" &&
      isProtectedCodexConfigMutationEnv()
    ) {
      return { ok: true, changed: 0, reason: "protected-env" };
    }

    if (!existsSync(CODEX_DIR)) mkdirSync(CODEX_DIR, { recursive: true });

    const original = existsSync(CODEX_CONFIG_PATH)
      ? readFileSync(CODEX_CONFIG_PATH, "utf8")
      : "";

    // Safety guard: if the file exists but is suspiciously small (< 100 bytes)
    // skip all writes to avoid perpetuating a corrupted state.
    if (original.length > 0 && original.length < 100) {
      process.stderr.write(
        `[tfx-setup] config.toml 크기 이상 (${original.length} bytes) — 쓰기 스킵. 수동 확인 필요: ${CODEX_CONFIG_PATH}\n`,
      );
      return { ok: false, changed: 0, message: "config too small, skipped" };
    }

    let updated = original;
    let changed = 0;

    // ── 1. top-level 필수 설정 주입 (없을 때만, 기존 값 보존) ──
    // 파일 상단 [profiles.*] / [mcp_servers.*] 이전 영역만 검사한다.
    // 프로필 섹션 내부의 동명 키(예: model = "gpt-5.3-codex")는 무시한다.
    // 이미 존재하는 키는 절대 덮어쓰지 않는다.
    for (const { key, value } of REQUIRED_TOP_LEVEL_SETTINGS) {
      // top-level 영역 = 첫 번째 [profiles.*] / [mcp_servers.*] 헤더 이전
      const firstSectionIdx = updated.search(/^\[(?:profiles|mcp_servers)\./m);
      const topLevelRegion =
        firstSectionIdx === -1 ? updated : updated.slice(0, firstSectionIdx);
      const topLevelKeyRe = new RegExp(`^${key}\\s*=`, "m");
      if (!topLevelKeyRe.test(topLevelRegion)) {
        // firstSectionIdx already computed above for this iteration
        const line = `${key} = ${value}\n`;
        if (firstSectionIdx === -1) {
          // 섹션이 없으면 파일 맨 앞에 추가
          updated = line + updated;
        } else {
          updated =
            updated.slice(0, firstSectionIdx) +
            line +
            updated.slice(firstSectionIdx);
        }
        changed++;
      }
    }

    // ── 2. 필수 프로필 보장 (Codex 0.134+: 별도 파일 포맷) ──
    // Codex 0.134.0 부터 `--profile X` 는 별도 파일 ~/.codex/X.config.toml (top-level
    // 키)을 읽고, config.toml 의 inline [profiles.X] 테이블은 거부한다. 따라서
    // (a) 각 프로필을 별도 파일로 쓰고 (b) config.toml 의 inline 테이블을 제거한다.
    // ref: developers.openai.com/codex/config-advanced#profiles
    for (const profile of REQUIRED_CODEX_PROFILES) {
      const profilePath = join(CODEX_DIR, `${profile.name}.config.toml`);
      const desiredContent = `${profile.lines.join("\n")}\n`;
      const existingContent = existsSync(profilePath)
        ? readFileSync(profilePath, "utf8")
        : null;
      if (existingContent !== desiredContent) {
        writeFileSync(profilePath, desiredContent, "utf8");
        changed++;
      }
    }
    // config.toml 의 모든 inline [profiles.*] 마이그레이션 (Codex 0.134 는 inline 거부).
    //   - 관리 gpt6_*: 위에서 canonical 별도 파일을 썼으므로 inline 만 제거.
    //   - 구형 retired (codex53/spark53/gpt54/mini54): inline 제거, 재생성 안 함.
    //   - 그 외 사용자 커스텀: 본문을 보존해 별도 파일로 이관한 뒤 inline 제거.
    //     (별도 파일이 이미 있으면 덮어쓰지 않는다 — 사용자 수정 보존.)
    const managedProfileNames = new Set(
      REQUIRED_CODEX_PROFILES.map((p) => p.name),
    );
    const retiredProfileNames = new Set(LEGACY_CODEX_PROFILE_NAMES);
    for (const name of listInlineProfileNames(updated)) {
      if (!managedProfileNames.has(name) && !retiredProfileNames.has(name)) {
        const customPath = join(CODEX_DIR, `${name}.config.toml`);
        if (!existsSync(customPath)) {
          const lines = extractProfileLines(updated, name);
          if (lines.length > 0) {
            writeFileSync(customPath, `${lines.join("\n")}\n`, "utf8");
          }
        }
      }
      updated = removeProfileSection(updated, name);
      changed++;
    }

    // headless 모드에서 승인 없이 실행하려면 sandbox 설정 필수
    // Codex 0.117.0+: config.toml 설정과 CLI 플래그 중복 시 에러
    if (process.platform === "win32" && !updated.includes("[windows]")) {
      if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
      updated += '\n[windows]\nsandbox = "elevated"\n';
      changed++;
    }

    if (updated !== original) {
      writeFileSync(CODEX_CONFIG_PATH, updated, "utf8");
    }

    return { ok: true, changed };
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message.trim()
        : "unknown error";
    return { ok: false, changed: 0, message };
  }
}

function createCommandIo() {
  const stdout = [];
  const stderr = [];

  return {
    log(message = "") {
      stdout.push(`${message}\n`);
    },
    writeStdout(message = "") {
      stdout.push(message);
    },
    writeStderr(message = "") {
      stderr.push(message);
    },
    result(code = 0) {
      return { code, stdout: stdout.join(""), stderr: stderr.join("") };
    },
  };
}

function getSetupArgv(stdinData) {
  return Array.isArray(stdinData?.argv) ? stdinData.argv : [];
}

const STABLE_NODE_COMMAND_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/home/linuxbrew/.linuxbrew/bin/node",
]);

function quoteShellCommandArg(value) {
  const normalized = String(value).replace(/\\/g, "/");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(normalized)) return normalized;
  return `"${normalized.replace(/(["\\$`])/gu, "\\$1")}"`;
}

function resolveStableNodeCommand({ existsSyncFn = existsSync } = {}) {
  if (process.platform !== "win32") {
    for (const candidate of STABLE_NODE_COMMAND_CANDIDATES) {
      try {
        if (existsSyncFn(candidate)) return candidate;
      } catch {
        /* ignore candidate probe errors */
      }
    }
  }
  return "node";
}

function buildNodeScriptCommand(scriptPath) {
  return `${quoteShellCommandArg(resolveStableNodeCommand())} ${quoteShellCommandArg(scriptPath)}`;
}

function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("settings.json은 객체여야 합니다.");
  return settings;
}

export function persistSettings(settings, settingsPath = SETTINGS_PATH) {
  const target = existsSync(settingsPath)
    ? realpathSync(settingsPath)
    : settingsPath;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tfx-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: existsSync(target) ? statSync(target).mode : 0o600,
    });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function applyStatusLine(
  settings,
  { hudPath = HUD_PATH, warn = console.warn } = {},
) {
  if (!existsSync(hudPath)) return false;
  const current = settings.statusLine;
  const desiredCommand = buildNodeScriptCommand(hudPath);
  if (current?.command === desiredCommand) return false;
  if (current != null) {
    const tokens = String(current.command || "").match(
      /^(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))$/u,
    );
    const node = tokens?.[1] ?? tokens?.[2] ?? tokens?.[3] ?? "";
    const script = tokens?.[4] ?? tokens?.[5] ?? tokens?.[6];
    if (
      current.type !== "command" ||
      !/(?:^|[/\\])node(?:\.exe)?$/u.test(node) ||
      script !== hudPath.replace(/\\/g, "/")
    ) {
      warn(
        "기존 statusLine 유지: Triflux HUD를 쓰려면 settings.json에서 직접 선택하세요.",
      );
      return false;
    }
  }
  settings.statusLine = {
    ...current,
    type: "command",
    command: desiredCommand,
  };
  return true;
}

function applyAgentTeams(settings) {
  if (!settings.env) settings.env = {};
  let changed = false;

  if (settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
    settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    changed = true;
  }
  if (!settings.teammateMode) {
    settings.teammateMode = "auto";
    changed = true;
  }
  return changed;
}

function applyRemoteControl(settings) {
  if (settings.remoteControlAtStartup === true) return false;
  if (process.env.TFX_REMOTE_CONTROL !== "1" && !detectDevMode()) return false;
  settings.remoteControlAtStartup = true;
  return true;
}

// ── 제거된 CTO 트레이 잔여 프로세스 (ADR-0022) ──
// 이전 버전은 `node hub/tray.mjs` 와 그 자식 `swift hub/mac-tray.swift` 를 detached 로
// 띄웠다. 파일을 지워도 이미 뜬 프로세스는 남으므로 업그레이드 setup 에서 한 번 거둔다.
// 트레이는 시작 프로그램·작업 스케줄러·LaunchAgent 에 등록된 적이 없어 지울 항목은 없다.
const LEGACY_TRAY_PS_FIELDS = "uid=,pid=,lstart=,command=";
const LEGACY_TRAY_PS_OPTIONS = {
  encoding: "utf8",
  timeout: 2000,
  maxBuffer: 4 * 1024 * 1024,
  // lstart 표기를 로캘과 무관하게 고정한다(재조회 비교용).
  env: { ...process.env, LC_ALL: "C" },
};
// `uid pid <lstart: 요일 월 일 시:분:초 연도> command`
const LEGACY_TRAY_PS_LINE_RE =
  /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/u;
// node 에서 다음 인자를 값으로 받는 옵션 — 그 값은 실행 대상이 아니다.
const NODE_VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--input-type",
  "--conditions",
  "-C",
  "--title",
]);
// 스크립트 대신 코드를 실행하는 옵션 — 트레이 실행이 아니다.
const NODE_EVAL_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);

function parseLegacyTrayPsLine(line) {
  const match = String(line).match(LEGACY_TRAY_PS_LINE_RE);
  if (!match) return null;
  return {
    pid: Number.parseInt(match[2], 10),
    uid: Number.parseInt(match[1], 10),
    startedAt: match[3],
    command: match[4].trim(),
  };
}

// 실제 실행 대상(entrypoint). 경로를 인자로만 받은 프로세스는 대상이 아니다.
function legacyTrayEntrypoint(argv) {
  const runtime = basename(argv[0] || "");
  if (runtime === "node") {
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (NODE_EVAL_OPTIONS.has(arg)) return null;
      if (NODE_VALUE_OPTIONS.has(arg)) {
        i += 1;
        continue;
      }
      if (arg === "--") return argv[i + 1] ?? null;
      if (arg.startsWith("-")) continue;
      return arg;
    }
    return null;
  }
  if (runtime === "swift" || runtime === "swift-frontend") {
    const interpret = argv.indexOf("-interpret");
    if (interpret !== -1) return argv[interpret + 1] ?? null;
    // swift-frontend 는 -interpret 일 때만 스크립트를 실행한다.
    if (runtime === "swift-frontend") return null;
    return argv.slice(1).find((arg) => !arg.startsWith("-")) ?? null;
  }
  return null;
}

// `.../triflux/.../hub/tray.mjs` 또는 `.../hub/mac-tray.swift` — triflux 설치 위치로 보이는 경로.
function isLegacyTrayScriptPath(path, runtime) {
  if (typeof path !== "string" || !path) return false;
  const segments = path.split(/[/\\]+/u);
  const file = segments.at(-1);
  const expected = runtime === "node" ? "tray.mjs" : "mac-tray.swift";
  if (file !== expected || segments.at(-2) !== "hub") return false;
  return segments.slice(0, -2).includes("triflux");
}

function collectLegacyTrayProcesses(
  psOutput = "",
  { currentPid = process.pid, currentUid = process.getuid?.() } = {},
) {
  // 현재 사용자를 알 수 없으면 아무것도 고르지 않는다.
  if (!Number.isInteger(currentUid)) return [];
  return String(psOutput)
    .split(/\r?\n/u)
    .flatMap((line) => {
      const proc = parseLegacyTrayPsLine(line);
      if (!proc || !Number.isFinite(proc.pid)) return [];
      if (proc.pid === Number(currentPid) || proc.uid !== currentUid) return [];
      const argv = proc.command.split(/\s+/u);
      const runtime = basename(argv[0] || "");
      const entry = legacyTrayEntrypoint(argv);
      if (!isLegacyTrayScriptPath(entry, runtime)) return [];
      return [proc];
    });
}

// PID 재사용 방지: 보내기 직전에 다시 조회해 uid·시작 시각·command 가 같을 때만 같은 프로세스로 본다.
function isSameLegacyTrayProcess(proc, execFileSyncFn) {
  try {
    const output = execFileSyncFn(
      "ps",
      ["-o", LEGACY_TRAY_PS_FIELDS, "-p", String(proc.pid)],
      LEGACY_TRAY_PS_OPTIONS,
    );
    const current = String(output)
      .split(/\r?\n/u)
      .map(parseLegacyTrayPsLine)
      .find((entry) => entry?.pid === proc.pid);
    return (
      !!current &&
      current.uid === proc.uid &&
      current.startedAt === proc.startedAt &&
      current.command === proc.command
    );
  } catch {
    return false;
  }
}

function reapLegacyTrayProcesses({
  platform = process.platform,
  currentPid = process.pid,
  currentUid = process.getuid?.(),
  execFileSyncFn = execFileSync,
  killFn = process.kill,
} = {}) {
  // Windows 트레이는 수동 `tfx tray` 로만 떴고 ps 가 없으므로 건너뛴다.
  if (platform === "win32") return [];
  let output = "";
  try {
    output = execFileSyncFn(
      "ps",
      ["-axo", LEGACY_TRAY_PS_FIELDS],
      LEGACY_TRAY_PS_OPTIONS,
    );
  } catch {
    return [];
  }
  const reaped = [];
  for (const proc of collectLegacyTrayProcesses(output, {
    currentPid,
    currentUid,
  })) {
    if (!isSameLegacyTrayProcess(proc, execFileSyncFn)) continue;
    try {
      killFn(proc.pid, "SIGTERM");
      reaped.push(proc);
    } catch {}
  }
  return reaped;
}

function ensureCriticalSetup() {
  const settings = loadSettings();
  let settingsChanged = false;

  try {
    if (applyStatusLine(settings)) settingsChanged = true;
  } catch {}
  try {
    if (applyAgentTeams(settings)) settingsChanged = true;
  } catch {}
  try {
    if (applyRemoteControl(settings)) settingsChanged = true;
  } catch {}

  if (settingsChanged) {
    try {
      persistSettings(settings);
    } catch {}
  }

  try {
    const pkgRootForward = PLUGIN_ROOT.replace(/\\/g, "/");
    const currentBreadcrumb = existsSync(BREADCRUMB_PATH)
      ? readFileSync(BREADCRUMB_PATH, "utf8").trim()
      : "";
    if (currentBreadcrumb !== pkgRootForward) {
      const breadcrumbDir = dirname(BREADCRUMB_PATH);
      if (!existsSync(breadcrumbDir)) {
        mkdirSync(breadcrumbDir, { recursive: true });
      }
      writeFileSync(BREADCRUMB_PATH, pkgRootForward + "\n", "utf8");
    }
  } catch {}

  try {
    ensureCodexProfiles();
  } catch (error) {
    process.stderr.write(
      `[tfx-setup] ensureCodexProfiles 실패: ${error?.message || error}\n`,
    );
  }
  try {
    ensureCodexHooks();
  } catch (error) {
    process.stderr.write(
      `[tfx-setup] ensureCodexHooks 실패: ${error?.message || error}\n`,
    );
  }
  try {
    ensureAgyHooks();
  } catch (error) {
    process.stderr.write(
      `[tfx-setup] ensureAgyHooks 실패: ${error?.message || error}\n`,
    );
  }
}

export {
  BREADCRUMB_PATH,
  CLAUDE_DIR,
  cleanupStaleSkills,
  collectLegacyTrayProcesses,
  DEPRECATED_SKILLS,
  detectDevMode,
  ensureAgyHooks,
  ensureCodexHooks,
  ensureCodexProfiles,
  extractProfileLines,
  getVersion,
  getWorkerPackageSyncEntries,
  hasProfileSection,
  isLocalDevSkillDir,
  isSetupUserStateFile,
  isSkillSupportedOnPlatform,
  LEGACY_CODEX_MODELS,
  LEGACY_CODEX_PROFILE_NAMES,
  LOCAL_DEV_SKILL_MARKER,
  listInlineProfileNames,
  PLUGIN_ROOT,
  REMOVED_SKILL_NAMES,
  REQUIRED_CODEX_PROFILES,
  REQUIRED_TOP_LEVEL_SETTINGS,
  readMarker,
  reapLegacyTrayProcesses,
  removeProfileSection,
  replaceProfileSection,
  SETUP_MARKER_PATH,
  SETUP_USER_STATE_FILES,
  SKILL_ALIASES,
  SYNC_MAP,
  scanHudFiles,
  syncAliasedSkillDir,
  syncCodexHarnessAdapter,
  syncCodexManagedSkills,
  syncWorkerPackages,
  writeMarker,
};

export async function runCritical(stdinData) {
  const io = createCommandIo();
  const cleanup = cleanupLegacyHooks({ settingsPath: SETTINGS_PATH });
  if (!cleanup.ok) {
    io.writeStderr(`[tfx-setup] 이전 hook 정리 실패: ${cleanup.error}\n`);
    return io.result(1);
  }
  const argv = getSetupArgv(stdinData);
  const isSync = argv.includes("--sync");
  const isDev = detectDevMode();

  // version check remains part of the critical path for in-process callers.
  getPackageVersion();
  readMarker();

  if (isDev) {
    io.log("  [dev] 로컬 개발 모드 감지");
  }

  if (isSync) {
    io.log("  [sync] 명시적 재동기화 실행");
  }

  try {
    ensureCriticalSetup();
  } catch (error) {
    io.writeStderr(`[tfx-setup] settings.json 읽기 실패: ${error.message}\n`);
    return io.result(1);
  }
  return io.result(0);
}

export async function runDeferred(stdinData) {
  const io = createCommandIo();
  const cleanup = cleanupLegacyHooks({ settingsPath: SETTINGS_PATH });
  if (!cleanup.ok) {
    io.writeStderr(`[tfx-setup] 이전 hook 정리 실패: ${cleanup.error}\n`);
    return io.result(1);
  }
  const argv = getSetupArgv(stdinData);
  const isSync = argv.includes("--sync");
  const isForce = argv.includes("--force");
  const machineProfileOnly = argv.includes("--machine-profile-only");
  const reconfigureMachineProfile =
    machineProfileOnly || argv.includes("--machine-profile");
  const nonInteractiveProfile = argv.includes("--non-interactive");
  const isDev = detectDevMode();

  if (isDev) {
    io.log("  [dev] \uB85C\uCEEC \uAC1C\uBC1C \uBAA8\uB4DC \uAC10\uC9C0");
  }

  if (isSync) {
    io.log("  [sync] \uBA85\uC2DC\uC801 \uC7AC\uB3D9\uAE30\uD654 \uC2E4\uD589");
  }

  let machineProfileResult;
  try {
    machineProfileResult = await ensureMachineProfile({
      force: reconfigureMachineProfile,
      nonInteractive: nonInteractiveProfile,
    });
  } catch (error) {
    io.writeStderr(
      `[tfx-setup] machine profile 실패: ${error?.message || error}\n`,
    );
    return io.result(1);
  }
  if (machineProfileResult.changed || reconfigureMachineProfile) {
    const action = machineProfileResult.changed ? "saved" : "unchanged";
    io.log(
      `  machine profile ${action}: ${machineProfileResult.path} (${machineProfileResult.profile.TFX_MACHINE_OS}/${machineProfileResult.profile.TFX_MULTIPLEXER_POLICY})`,
    );
  }
  for (const warning of machineProfileResult.warnings) {
    io.log(`  \x1b[33m⚠\x1b[0m ${warning}`);
  }
  if (machineProfileOnly) return io.result(0);

  const mcpCleanup = cleanupLegacyMcp({
    home: _TFX_HOME,
    repoRoot: process.env.INIT_CWD || process.cwd(),
  });
  // 이주가 막혀도 설치는 계속한다. 남은 항목은 경고로 알린다.
  for (const warning of mcpCleanup.warnings) io.log(`  ⚠ ${warning}`);

  // 제거된 허브의 MCP 항목, 프로세스, 예약 작업을 정리한다. 개발 체크아웃의 스냅샷은 건드리지 않는다.
  const hubCleanup = cleanupTfxHub({
    home: _TFX_HOME,
    pluginRoot: isDev ? undefined : PLUGIN_ROOT,
  });
  for (const warning of hubCleanup.warnings) io.log(`  ⚠ ${warning}`);
  if (hubCleanup.changed) io.log("  허브 설정과 실행 흔적 정리");

  const pkgVersion = getPackageVersion();
  const marker = readMarker();
  const skillSync = syncSkills();
  for (const warning of skillSync.warnings) io.log(`  ⚠ ${warning}`);
  if (!skillSync.ok) return io.result(1);
  ensureTrifluxMods({
    install: argv.includes("--mods"),
    log: (message) => io.log(message),
    warn: (message) => io.log(`  ⚠ ${message}`),
  });
  if (pkgVersion && marker?.version === pkgVersion && !isForce) {
    io.log(`setup: skip (v${pkgVersion} already synced)`);
    return io.result(0);
  }

  let synced = skillSync.changed;

  for (const { src, dst } of SYNC_MAP) {
    if (!existsSync(src)) continue;

    const dstDir = dirname(dst);
    if (!existsSync(dstDir)) {
      mkdirSync(dstDir, { recursive: true });
    }

    if (!existsSync(dst)) {
      copyFileSync(src, dst);
      try {
        chmodSync(dst, 0o755);
      } catch {}
      synced++;
    } else {
      if (shouldSyncTextFile(src, dst)) {
        copyFileSync(src, dst);
        try {
          chmodSync(dst, 0o755);
        } catch {}
        synced++;
      }
    }
  }

  // ── Worker 의존성 동기화 (MCP SDK + transitive deps) ──

  const workerNodeModules = join(CLAUDE_DIR, "scripts", "node_modules");
  const mcpSdkPath = join(workerNodeModules, "@modelcontextprotocol", "sdk");
  const srcNodeModules = join(PLUGIN_ROOT, "node_modules");

  if (!existsSync(mcpSdkPath) && existsSync(srcNodeModules)) {
    try {
      for (const entry of readdirSync(srcNodeModules)) {
        const src = join(srcNodeModules, entry);
        const dst = join(workerNodeModules, entry);
        if (existsSync(dst)) continue;

        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true });
      }
      synced++;
    } catch {
      // best effort: 의존성 복사 실패 시 exec fallback으로 동작
    }
  }

  try {
    synced += syncWorkerPackages({ workerNodeModules });
  } catch (error) {
    io.log(
      `  \x1b[33m⚠\x1b[0m worker package sync skipped: ${_normalizeErrorMessage(error)}`,
    );
  }

  // ── 패키지 루트 breadcrumb 기록 ──
  // tfx-route.sh가 hub/bridge.mjs를 찾을 수 있도록
  // 패키지 루트 경로를 ~/.claude/scripts/.tfx-pkg-root에 기록한다.
  // dev mode에서는 항상 최신 경로를 기록 (--sync 시 강제 갱신).
  {
    const pkgRootForward = PLUGIN_ROOT.replace(/\\/g, "/");
    const currentBreadcrumb = existsSync(BREADCRUMB_PATH)
      ? readFileSync(BREADCRUMB_PATH, "utf8").trim()
      : "";
    if (currentBreadcrumb !== pkgRootForward || isSync) {
      const breadcrumbDir = dirname(BREADCRUMB_PATH);
      if (!existsSync(breadcrumbDir))
        mkdirSync(breadcrumbDir, { recursive: true });
      writeFileSync(BREADCRUMB_PATH, pkgRootForward + "\n", "utf8");
      synced++;
    }
  }

  for (const file of removeRetiredInstallFiles()) {
    io.log(`  \x1b[32m✓\x1b[0m 더 쓰지 않는 설치 파일 제거: ${file}`);
  }

  const settings = loadSettings();
  let settingsChanged = false;
  for (const apply of [applyStatusLine, applyAgentTeams, applyRemoteControl]) {
    if (apply(settings)) {
      settingsChanged = true;
      synced++;
    }
  }
  if (settingsChanged) persistSettings(settings);

  // ── HUD 캐시 pre-warm (백그라운드) ──

  const preWarmHudPath = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
  if (existsSync(preWarmHudPath)) {
    const refreshFlags = [
      ["--refresh-claude-usage"],
      ["--refresh-codex-rate-limits"],
      ["--refresh-gemini-session"],
    ];
    for (const args of refreshFlags) {
      try {
        const child = spawn(process.execPath, [preWarmHudPath, ...args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      } catch {
        /* pre-warm 실패 무시 */
      }
    }
    io.log("  \x1b[32m✓\x1b[0m HUD cache pre-warm (background)");
  }

  const reapedTrays = reapLegacyTrayProcesses();
  if (reapedTrays.length > 0) {
    io.log(
      `  \x1b[32m✓\x1b[0m 제거된 CTO 트레이 프로세스 ${reapedTrays.length}개 종료`,
    );
    synced++;
  }

  // ── psmux 자동 설치 (Windows tmux-compatible mux) ──

  if (process.platform === "win32") {
    try {
      execFileSync("where", ["psmux"], { stdio: "ignore" });
    } catch {
      // psmux 미설치 — winget으로 자동 설치 시도
      io.log("  psmux 미설치 — winget으로 설치 중...");
      try {
        execFileSync(
          "winget",
          [
            "install",
            "--id",
            "psmux",
            "--accept-package-agreements",
            "--accept-source-agreements",
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 60000,
          },
        );
        io.log("  \x1b[32m✓\x1b[0m psmux 설치 완료");
        synced++;
      } catch {
        io.log(
          "  \x1b[33m⚠\x1b[0m psmux 자동 설치 실패 — 수동 설치: winget install psmux",
        );
      }
    }
  }

  // ── HUD 에러 캐시 자동 클리어 (업데이트/재설치 시) ──

  const cacheDir = join(CLAUDE_DIR, "cache");
  const staleFiles = [
    "claude-usage-cache.json",
    ".claude-refresh-lock",
    "codex-rate-limits-cache.json",
  ];

  for (const name of staleFiles) {
    const fp = join(cacheDir, name);
    if (!existsSync(fp)) continue;
    try {
      const content = readFileSync(fp, "utf8");
      const parsed = JSON.parse(content);
      // 에러 상태이거나 락 파일이면 삭제 → 새 세션에서 fresh start
      if (parsed.error || name.startsWith(".")) {
        unlinkSync(fp);
        synced++;
      }
    } catch {
      // 파싱 실패 파일도 삭제
      try {
        unlinkSync(fp);
      } catch {}
    }
  }

  // ── Windows bash PATH 자동 설정 ──
  // Codex/Antigravity가 cmd에는 있지만 bash에서 못 찾는 문제 해결

  if (process.platform === "win32") {
    const npmBin = join(process.env.APPDATA || "", "npm");
    if (existsSync(npmBin)) {
      const bashrcPath = join(homedir(), ".bashrc");
      const pathExport = 'export PATH="$PATH:$APPDATA/npm"';
      let needsUpdate = true;

      if (existsSync(bashrcPath)) {
        const content = readFileSync(bashrcPath, "utf8");
        if (
          content.includes("APPDATA/npm") ||
          content.includes("APPDATA\\npm")
        ) {
          needsUpdate = false;
        }
      }

      if (needsUpdate) {
        const line = `\n# triflux: Codex/Antigravity CLI를 bash에서 사용하기 위한 PATH 설정\n${pathExport}\n`;
        try {
          writeFileSync(
            bashrcPath,
            (existsSync(bashrcPath) ? readFileSync(bashrcPath, "utf8") : "") +
              line,
            "utf8",
          );
          synced++;
        } catch {}
      }
    }
  }

  // ── Codex 프로필 자동 보정 ──

  const codexProfilesResult = ensureCodexProfiles();
  if (codexProfilesResult.ok && codexProfilesResult.changed > 0) {
    synced++;
  }

  try {
    const codexHooksResult = ensureCodexHooks();
    if (
      !codexHooksResult?.skipped &&
      (codexHooksResult?.changedHooks || codexHooksResult?.changedConfig)
    ) {
      io.log("  \x1b[32m✓\x1b[0m Codex hooks: registered session sync hooks");
      synced++;
    }
  } catch (error) {
    io.log(
      `  \x1b[33m⚠\x1b[0m Codex hooks 등록 실패: ${error.message || error}`,
    );
  }

  try {
    const agyHooksResult = ensureAgyHooks();
    if (!agyHooksResult?.skipped && agyHooksResult?.changed) {
      io.log(
        "  \x1b[32m✓\x1b[0m Antigravity hooks: registered session sync hook",
      );
      synced++;
    }
  } catch (error) {
    io.log(
      `  \x1b[33m⚠\x1b[0m Antigravity hooks 등록 실패: ${error.message || error}`,
    );
  }

  // ── MCP 인벤토리 백그라운드 갱신 ──

  const mcpCheck = join(PLUGIN_ROOT, "scripts", "mcp-check.mjs");
  if (existsSync(mcpCheck)) {
    const child = spawn(process.execPath, [mcpCheck], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref(); // 부모 프로세스와 분리 — 비동기 실행
  }

  // ── /tmp 임시 파일 자동 정리 (setup 지연 방지: fire-and-forget) ──
  cleanupTmpFiles().catch(() => {});

  // ── npm 글로벌 패키지 동기화 ──
  // dev mode가 아닌 경우(npm install로 설치), 글로벌 triflux 패키지 버전을 확인하고
  // 로컬 버전과 다르면 업데이트를 안내한다. dev mode에서는 git 기반이므로 skip.
  if (pkgVersion && !isDev) {
    try {
      const globalVer = execFileSync(
        "npm",
        ["list", "-g", "triflux", "--json", "--depth=0"],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const parsed = JSON.parse(globalVer);
      const installedVer = parsed?.dependencies?.triflux?.version;
      if (installedVer && installedVer !== pkgVersion) {
        const tag = pkgVersion.includes("alpha") ? "alpha" : "latest";
        io.log(
          `  npm: triflux global ${installedVer} → ${pkgVersion} (npm i -g triflux@${tag})`,
        );
      }
    } catch {
      // npm list 실패 = 글로벌 미설치. 안내만 출력.
      if (pkgVersion.includes("alpha")) {
        io.log(
          "  npm: triflux global 미설치 (npm i -g triflux@alpha 로 설치 가능)",
        );
      }
    }
  }

  if (pkgVersion) {
    writeMarker({ version: pkgVersion, timestamp: Date.now() });
  }

  // ── postinstall 배너 (npm install 시에만 출력) ──

  if (process.env.npm_lifecycle_event === "postinstall") {
    const G = "\x1b[32m";
    const C = "\x1b[36m";
    const Y = "\x1b[33m";
    const D = "\x1b[2m";
    const B = "\x1b[1m";
    const R = "\x1b[0m";

    const ver = (() => {
      return pkgVersion || "?";
    })();

    io.log(`
${B}╔═══════════════════════════════════════════════╗${R}
${B}║${R}  ${C}triflux${R} ${D}v${ver}${R} ${B}— Setup Complete${R}             ${B}║${R}
${B}╚═══════════════════════════════════════════════╝${R}

  ${G}✓${R} tfx-route.sh     → ~/.claude/scripts/
  ${G}✓${R} hud-qos-status   → ~/.claude/hud/
  ${G}✓${R} ${synced > 0 ? synced + " files synced" : "all files up to date"}
  ${D}HUD statusLine: 기존 설정을 보존하며 미설정 시 등록${R}

${B}Commands:${R}
  ${C}triflux${R} setup     파일 동기화 + HUD 설정
  ${C}triflux${R} doctor    CLI 진단 (Codex/Antigravity 확인)
  ${C}triflux${R} list      설치된 스킬 목록
  ${C}triflux${R} update    최신 안정 버전으로 업데이트
  ${C}triflux${R} update --dev  dev 채널로 업데이트 (${D}dev 별칭 지원${R})

${B}Shortcuts:${R}
  ${C}tfx${R}                 triflux 축약
  ${C}tfx-setup${R}            triflux setup
  ${C}tfx-doctor${R}           triflux doctor

${B}Skills (Claude Code):${R}
  ${C}/tfx-auto${R} "작업"                 자동 분류 + 병렬 실행
  ${C}/tfx-auto${R} "작업" --mode deep     계획 + 검증 포함
  ${C}/tfx-auto${R} "작업" --cli codex     Codex 전용 lane
  ${C}/tfx-auto${R} "작업" --cli antigravity    Antigravity 전용 lane
  ${C}/tfx-setup${R}           HUD 설정 + 진단

${Y}!${R} 세션 재시작 후 스킬이 활성화됩니다
${D}https://github.com/tellang/triflux${R}
`);
  }

  return io.result(0);
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

// 저장소 체크아웃의 npm ci/install 이 실제 HOME 을 바꾸지 않게, postinstall 은
// node_modules 아래 설치본에서만 setup 한다.
const isCheckoutPostinstall =
  process.env.npm_lifecycle_event === "postinstall" &&
  !PLUGIN_ROOT.split(/[\\/]/).includes("node_modules");

if (isMain && isCheckoutPostinstall) {
  console.log(
    "[tfx-setup] 저장소 체크아웃의 postinstall 은 건너뜀. 필요하면 node scripts/setup.mjs 를 직접 실행한다.",
  );
} else if (isMain) {
  const result = await runDeferred({ argv: process.argv.slice(2) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
