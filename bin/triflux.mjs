#!/usr/bin/env node
// triflux CLI — setup, doctor, version
import { copyFileSync, existsSync, readFileSync, readSync, writeFileSync, mkdirSync, chmodSync, readdirSync, unlinkSync, statSync, openSync, closeSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir, tmpdir } from "os";
import { execSync, execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { setTimeout as delay } from "node:timers/promises";
import { loadDelegatorSchemaBundle } from "../hub/delegator/tool-definitions.mjs";
import { detectMultiplexer, getSessionAttachedCount, killSession, listSessions, tmuxExec } from "../hub/team/session.mjs";
import { forceCleanupTeam } from "../hub/team/nativeProxy.mjs";
import { cleanupStaleOmcTeams, inspectStaleOmcTeams } from "../hub/team/staleState.mjs";
import { getPipelineStateDbPath } from "../hub/pipeline/state.mjs";
import { ensureGeminiProfiles } from "../scripts/lib/gemini-profiles.mjs";
import {
  addRegistryServer,
  inspectRegistry,
  inspectRegistryStatus,
  removeRegistryServer,
  removeServerFromTargets,
  syncRegistryTargets,
} from "../scripts/lib/mcp-guard-engine.mjs";
import {
  SYNC_MAP, SKILL_ALIASES, REQUIRED_CODEX_PROFILES, LEGACY_CODEX_MODELS,
  syncAliasedSkillDir, hasProfileSection, replaceProfileSection,
  ensureCodexProfiles, getVersion, cleanupStaleSkills, DEPRECATED_SKILLS,
  extractManagedHookFilename, getManagedRegistryHooks, ensureHooksInSettings,
} from "../scripts/setup.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

// 이 배열에 포함된 버전에서만 star prompt를 표시한다 (빈 배열 = 모든 버전에서 표시)
const STAR_PROMPT_VERSIONS = [];


// ── 색상 체계 (triflux brand: amber/orange accent) ──
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const AMBER = "\x1b[38;5;214m";
const BLUE = "\x1b[38;5;39m";
const WHITE_BRIGHT = "\x1b[97m";
const GRAY = "\x1b[38;5;245m";
const GREEN_BRIGHT = "\x1b[38;5;82m";
const RED_BRIGHT = "\x1b[38;5;196m";

// ── 브랜드 요소 ──
const BRAND = `${AMBER}${BOLD}triflux${RESET}`;
const VER = `${DIM}v${PKG.version}${RESET}`;
const LINE = `${GRAY}${"─".repeat(48)}${RESET}`;
const DOT = `${GRAY}·${RESET}`;
const STALE_TEAM_MAX_AGE_SEC = 3600;
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_ARG_ERROR = 2;
const EXIT_CLI_MISSING = 3;
const EXIT_HUB_ERROR = 4;
const EXIT_CONFIG_ERROR = 5;

const RAW_ARGS = process.argv.slice(2);
const JSON_OUTPUT = RAW_ARGS.includes("--json");
const NORMALIZED_ARGS = RAW_ARGS.filter((arg) => arg !== "--json");

const CLI_COMMAND_SCHEMAS = Object.freeze({
  setup: {
    usage: "tfx setup [--dry-run]",
    description: "파일 동기화 + HUD/MCP 설정",
    options: [
      { name: "--dry-run", type: "boolean", description: "실제 변경 없이 예정 작업을 JSON으로 출력" },
    ],
  },
  doctor: {
    usage: "tfx doctor [--fix] [--reset] [--json]",
    description: "설치 상태 진단 및 자동 복구",
    options: [
      { name: "--fix", type: "boolean", description: "파일/캐시 자동 복구 후 재진단" },
      { name: "--reset", type: "boolean", description: "캐시 초기화 후 재생성" },
      { name: "--json", type: "boolean", description: "구조화된 진단 결과 JSON 출력" },
    ],
  },
  version: {
    usage: "tfx version [--json]",
    description: "triflux 및 동기화된 스크립트 버전 표시",
    options: [
      { name: "--json", type: "boolean", description: "버전 정보를 JSON으로 출력" },
    ],
  },
  list: {
    usage: "tfx list [--json]",
    description: "패키지 스킬과 사용자 스킬 목록 표시",
    options: [
      { name: "--json", type: "boolean", description: "스킬 목록을 JSON으로 출력" },
    ],
  },
  schema: {
    usage: "tfx schema [command-or-tool]",
    description: "CLI 커맨드 파라미터와 Hub delegator schema 번들 출력",
    options: [
      { name: "command-or-tool", type: "string", description: "예: doctor, setup, delegate, delegate-reply, status" },
    ],
  },
  hooks: {
    usage: "tfx hooks <scan|diff|apply|restore|status|set-priority|toggle>",
    description: "훅 우선순위 관리 — 오케스트레이터 적용/복원, 우선순위 조정",
    subcommands: {
      scan: "현재 settings.json 훅 스캔",
      diff: "오케스트레이터 적용 시 변경점 미리보기",
      apply: "오케스트레이터 적용 (settings.json 통합)",
      restore: "원래 settings.json 훅 복원",
      status: "오케스트레이터 적용 상태 확인",
      "set-priority": "특정 훅 우선순위 변경: hooks set-priority <hookId> <priority>",
      toggle: "특정 훅 활성/비활성 토글: hooks toggle <hookId>",
    },
  },
  mcp: {
    usage: "tfx mcp <list|sync|add|remove> [--json]",
    description: "MCP registry 상태 확인 및 중앙 동기화",
    subcommands: {
      list: {
        usage: "tfx mcp list [--json]",
        options: [{ name: "--json", type: "boolean", description: "registry + 실제 설정 상태를 JSON으로 출력" }],
      },
      sync: {
        usage: "tfx mcp sync [--json]",
        options: [{ name: "--json", type: "boolean", description: "동기화 결과를 JSON으로 출력" }],
      },
      add: {
        usage: "tfx mcp add <name> --url <url> [--json]",
        options: [
          { name: "--url", type: "string", description: "등록할 MCP URL" },
          { name: "--json", type: "boolean", description: "등록 결과를 JSON으로 출력" },
        ],
      },
      remove: {
        usage: "tfx mcp remove <name> [--json]",
        options: [{ name: "--json", type: "boolean", description: "제거 결과를 JSON으로 출력" }],
      },
    },
  },
  hub: {
    usage: "tfx hub <start|stop|status> [--port N] [--json]",
    description: "tfx-hub 프로세스 제어",
    subcommands: {
      start: { usage: "tfx hub start [--port N]" },
      stop: { usage: "tfx hub stop" },
      status: {
        usage: "tfx hub status [--json]",
        options: [{ name: "--json", type: "boolean", description: "허브 상태를 JSON으로 출력" }],
      },
    },
  },
  multi: {
    usage: "tfx multi [--dashboard-layout lite|single|split-2col|split-3col|auto] <subcommand|task>",
    description: "멀티-CLI 팀 모드",
    options: [
      { name: "--dashboard", type: "boolean", description: "headless dashboard viewer 표시 (기본값: 켜짐)" },
      { name: "--no-dashboard", type: "boolean", description: "headless dashboard viewer 비활성화" },
      { name: "--dashboard-layout", type: "string", description: "dashboard viewer 레이아웃 선택: lite|single|split-2col|split-3col|auto" },
    ],
    subcommands: {
      status: {
        usage: "tfx multi status [--json]",
        options: [{ name: "--json", type: "boolean", description: "팀 상태를 JSON으로 출력" }],
      },
    },
  },
});

// ── 유틸리티 ──
// ok/warn/fail/info/section 의 console.log는 디버그 로그가 아닌 의도된 CLI 출력입니다.

function ok(msg) { console.log(`  ${GREEN_BRIGHT}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED_BRIGHT}✗${RESET} ${msg}`); }
function info(msg) { console.log(`    ${GRAY}${msg}${RESET}`); }
function section(title) { console.log(`\n  ${AMBER}▸${RESET} ${BOLD}${title}${RESET}`); }
function stripAnsi(value) { return String(value ?? "").replace(ANSI_PATTERN, ""); }
function printJson(payload) { process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); }

function withConsoleSilenced(enabled, fn) {
  if (!enabled) return fn();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function createCliError(message, {
  exitCode = EXIT_ERROR,
  reason = "error",
  fix = null,
  cause = null,
} = {}) {
  const error = new Error(message);
  error.exitCode = exitCode;
  error.reason = reason;
  error.fix = fix;
  if (cause) error.cause = cause;
  return error;
}

function inferExitCode(error) {
  if (Number.isInteger(error?.exitCode)) return error.exitCode;
  if (error?.code === "ENOENT") return EXIT_CLI_MISSING;
  return EXIT_ERROR;
}

function inferReason(error, exitCode) {
  if (typeof error?.reason === "string" && error.reason) return error.reason;
  if (exitCode === EXIT_ARG_ERROR) return "argError";
  if (exitCode === EXIT_CLI_MISSING) return "cliMissing";
  if (exitCode === EXIT_HUB_ERROR) return "hubError";
  if (exitCode === EXIT_CONFIG_ERROR) return "configError";
  return "error";
}

function inferFix(error, exitCode) {
  if (typeof error?.fix === "string" && error.fix) return error.fix;
  if (exitCode === EXIT_ARG_ERROR) return "tfx --help";
  if (exitCode === EXIT_CLI_MISSING) return "필수 CLI를 설치한 뒤 `tfx doctor`로 상태를 다시 확인하세요.";
  if (exitCode === EXIT_HUB_ERROR) return "`tfx hub start`로 허브를 다시 시작하거나 설치 상태를 확인하세요.";
  if (exitCode === EXIT_CONFIG_ERROR) return "설정 파일 JSON/TOML 문법을 수정한 뒤 다시 실행하세요.";
  return null;
}

function handleFatalError(error, { json = false } = {}) {
  const exitCode = inferExitCode(error);
  const message = stripAnsi(error?.message || "알 수 없는 오류");
  const reason = inferReason(error, exitCode);
  const fix = inferFix(error, exitCode);

  if (json) {
    printJson({
      error: {
        code: exitCode,
        message,
        reason,
        ...(fix ? { fix } : {}),
      },
    });
  } else {
    console.error(message);
    if (fix) console.error(`fix: ${fix}`);
  }
  process.exit(exitCode);
}

function which(cmd) {
  try {
    const result = process.platform === "win32"
      ? execFileSync("where", [cmd], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
      : execFileSync("which", [cmd], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
    return result.trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function whichInShell(cmd, shell) {
  const shellArgs = {
    bash: ["bash", ["-c", `source ~/.bashrc 2>/dev/null && command -v "${cmd}" 2>/dev/null`]],
    cmd: ["cmd", ["/c", "where", cmd]],
    pwsh: ["pwsh", ["-NoProfile", "-c", `(Get-Command '${cmd.replace(/'/g, "''")}' -EA SilentlyContinue).Source`]],
  };
  const entry = shellArgs[shell];
  if (!entry) return null;
  try {
    const result = execFileSync(entry[0], entry[1], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return result.split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function isDevUpdateRequested(argv = process.argv) {
  return argv.includes("--dev") || argv.includes("@dev") || argv.includes("dev");
}

function checkShellAvailable(shell) {
  const cmds = { bash: "bash --version", cmd: "cmd /c echo ok", pwsh: "pwsh -NoProfile -c echo ok" };
  try {
    execSync(cmds[shell], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    return true;
  } catch { return false; }
}


function parseSessionCreated(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed / 1000);
  }

  const normalized = value.replace(/^(\d{2})-(\d{2})-(\d{2})(\s+)/, "20$1-$2-$3$4");
  const reparsed = Date.parse(normalized);
  if (Number.isFinite(reparsed)) {
    return Math.floor(reparsed / 1000);
  }

  return null;
}

function formatElapsedAge(ageSec) {
  if (!Number.isFinite(ageSec) || ageSec < 0) return "알 수 없음";
  if (ageSec < 60) return `${ageSec}초`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}분`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}시간`;
  return `${Math.floor(ageSec / 86400)}일`;
}

function readTeamSessionCreatedMap() {
  const createdMap = new Map();

  try {
    const output = tmuxExec('list-sessions -F "#{session_name} #{session_created}"');
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const firstSpace = trimmed.indexOf(" ");
      if (firstSpace === -1) continue;

      const sessionName = trimmed.slice(0, firstSpace);
      const createdRaw = trimmed.slice(firstSpace + 1).trim();
      const createdAt = parseSessionCreated(createdRaw);
      createdMap.set(sessionName, {
        createdAt,
        createdRaw,
      });
    }
  } catch {
    // session_created 포맷을 읽지 못하면 stale 판정만 완화한다.
  }

  return createdMap;
}

function inspectTeamSessions() {
  const mux = detectMultiplexer();
  if (!mux) {
    return { mux: null, sessions: [] };
  }

  const sessionNames = listSessions();
  if (sessionNames.length === 0) {
    return { mux, sessions: [] };
  }

  const createdMap = readTeamSessionCreatedMap();
  const nowSec = Math.floor(Date.now() / 1000);
  const sessions = sessionNames.map((sessionName) => {
    const createdInfo = createdMap.get(sessionName) || { createdAt: null, createdRaw: "" };
    const attachedCount = getSessionAttachedCount(sessionName);
    const ageSec = createdInfo.createdAt == null ? null : Math.max(0, nowSec - createdInfo.createdAt);
    const stale = ageSec != null && ageSec >= STALE_TEAM_MAX_AGE_SEC && attachedCount === 0;

    return {
      sessionName,
      attachedCount,
      ageSec,
      createdAt: createdInfo.createdAt,
      createdRaw: createdInfo.createdRaw,
      stale,
    };
  });

  return { mux, sessions };
}

async function cleanupStaleTeamSessions(staleSessions) {
  let cleaned = 0;
  let failed = 0;

  for (const session of staleSessions) {
    let removed = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      killSession(session.sessionName);
      const stillAlive = listSessions().includes(session.sessionName);
      if (!stillAlive) {
        removed = true;
        cleaned++;
        ok(`stale 세션 정리: ${session.sessionName}`);
        break;
      }

      if (attempt < 3) {
        await delay(1000);
      }
    }

    if (!removed) {
      failed++;
      fail(`세션 정리 실패: ${session.sessionName} — 수동 정리 필요`);
    }
  }

  info(`${cleaned}개 stale 세션 정리 완료`);

  return { cleaned, failed };
}


function previewCodexProfiles() {
  const original = existsSync(CODEX_CONFIG_PATH)
    ? readFileSync(CODEX_CONFIG_PATH, "utf8")
    : "";
  let updated = original;
  const profiles = [];

  for (const profile of REQUIRED_CODEX_PROFILES) {
    const before = updated;
    if (hasProfileSection(updated, profile.name)) {
      updated = replaceProfileSection(updated, profile.name, profile.lines);
    } else {
      if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
      if (updated.trim().length > 0) updated += "\n";
      updated += `[profiles.${profile.name}]\n${profile.lines.join("\n")}\n`;
    }
    if (updated !== before) {
      profiles.push(profile.name);
    }
  }

  const windowsSandbox = process.platform === "win32" && !updated.includes("[windows]");

  return {
    path: CODEX_CONFIG_PATH,
    profiles,
    windowsSandbox,
    change: profiles.length > 0 || windowsSandbox ? (original ? "update" : "create") : "noop",
  };
}

function syncFile(src, dst, label) {
  const dstDir = dirname(dst);
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

  if (!existsSync(src)) {
    fail(`${label}: 소스 파일 없음 (${src})`);
    return false;
  }

  const srcVer = getVersion(src);
  const dstVer = existsSync(dst) ? getVersion(dst) : null;

  if (!existsSync(dst)) {
    copyFileSync(src, dst);
    try { chmodSync(dst, 0o755); } catch {}
    ok(`${label}: 설치됨 ${srcVer ? `(v${srcVer})` : ""}`);
    return true;
  }

  const srcContent = readFileSync(src, "utf8");
  const dstContent = readFileSync(dst, "utf8");
  if (srcContent !== dstContent) {
    copyFileSync(src, dst);
    try { chmodSync(dst, 0o755); } catch {}
    const verInfo = (srcVer && dstVer && srcVer !== dstVer)
      ? `(v${dstVer} → v${srcVer})`
      : srcVer ? `(v${srcVer}, 내용 변경)` : "(내용 변경)";
    ok(`${label}: 업데이트됨 ${verInfo}`);
    return true;
  }

  ok(`${label}: 최신 상태 ${srcVer ? `(v${srcVer})` : ""}`);
  return false;
}

function describeSyncAction(src, dst, label) {
  if (!existsSync(src)) {
    throw createCliError(`${label}: 소스 파일 없음 (${src})`, {
      exitCode: EXIT_CONFIG_ERROR,
      reason: "configError",
      fix: "패키지 파일이 손상되지 않았는지 확인한 뒤 triflux를 다시 설치하세요.",
    });
  }

  const srcVer = getVersion(src);
  const dstExists = existsSync(dst);
  const change = !dstExists
    ? "create"
    : readFileSync(src, "utf8") !== readFileSync(dst, "utf8")
      ? "update"
      : "noop";

  return {
    type: "sync",
    label,
    from: src,
    to: dst,
    change,
    version: srcVer,
  };
}

// ── 크로스 셸 진단 ──

function checkCliCrossShell(cmd, installHint) {
  const shells = process.platform === "win32" ? ["bash", "cmd", "pwsh"] : ["bash"];
  let anyFound = false;
  let bashMissing = false;
  const shellResults = [];

  for (const shell of shells) {
    if (!checkShellAvailable(shell)) {
      info(`${shell}: ${DIM}셸 없음 (건너뜀)${RESET}`);
      shellResults.push({ shell, status: "unavailable", path: null });
      continue;
    }
    const p = whichInShell(cmd, shell);
    if (p) {
      ok(`${shell}:  ${p}`);
      anyFound = true;
      shellResults.push({ shell, status: "ok", path: p });
    } else {
      fail(`${shell}:  미발견`);
      if (shell === "bash") bashMissing = true;
      shellResults.push({ shell, status: "missing", path: null, fix: installHint });
    }
  }

  if (!anyFound) {
    info(`미설치 (선택사항) — ${installHint}`);
    info("없으면 Claude 네이티브 에이전트로 fallback");
    return {
      issues: 1,
      anyFound,
      bashMissing,
      shells: shellResults,
      status: "missing",
      fix: installHint,
    };
  }
  if (bashMissing) {
    warn("bash에서 미발견 — tfx-route.sh 실행 불가");
    info('→ ~/.bashrc에 추가: export PATH="$PATH:$APPDATA/npm"');
    return {
      issues: 1,
      anyFound,
      bashMissing,
      shells: shellResults,
      status: "degraded",
      fix: 'bash PATH를 정리한 뒤 `tfx doctor`를 다시 실행하세요.',
    };
  }
  return {
    issues: 0,
    anyFound,
    bashMissing,
    shells: shellResults,
    status: "ok",
    fix: null,
  };
}

// ── 명령어 ──

function listSkillSyncActions() {
  const skillsSrc = join(PKG_ROOT, "skills");
  if (!existsSync(skillsSrc)) return [];

  const actions = [];
  for (const name of readdirSync(skillsSrc).sort()) {
    const src = join(skillsSrc, name, "SKILL.md");
    const dst = join(CLAUDE_DIR, "skills", name, "SKILL.md");
    if (!existsSync(src)) continue;
    actions.push(describeSyncAction(src, dst, `skill:${name}`));
  }
  for (const { alias, source } of SKILL_ALIASES) {
    const src = join(skillsSrc, source, "SKILL.md");
    const dst = join(CLAUDE_DIR, "skills", alias, "SKILL.md");
    if (!existsSync(src)) continue;
    actions.push(describeSyncAction(src, dst, `skill-alias:${alias}`));
  }
  return actions;
}

function previewStatusLineAction() {
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  const hudPath = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (error) {
      throw createCliError(`settings.json 처리 실패: ${error.message}`, {
        exitCode: EXIT_CONFIG_ERROR,
        reason: "configError",
        fix: `${settingsPath}의 JSON 문법을 수정하세요.`,
        cause: error,
      });
    }
  }

  const currentCmd = settings.statusLine?.command || "";
  return {
    type: "statusLine",
    path: settingsPath,
    change: currentCmd.includes("hud-qos-status.mjs") ? "noop" : (currentCmd ? "update" : "create"),
    current: currentCmd || null,
    target: hudPath,
  };
}

function previewMcpRegistrationActions(mcpUrl) {
  const actions = [];

  if (which("codex")) {
    actions.push({
      type: "mcp-register",
      cli: "codex",
      target: "tfx-hub",
      url: mcpUrl,
      change: "check",
    });
  }
  if (which("gemini")) {
    actions.push({
      type: "mcp-register",
      cli: "gemini",
      target: "tfx-hub",
      url: mcpUrl,
      change: "check",
    });
  }

  actions.push({
    type: "mcp-register",
    cli: "claude",
    target: "tfx-hub",
    path: join(process.cwd(), ".claude", "mcp.json"),
    url: mcpUrl,
    change: "check",
  });

  return actions;
}

function buildSetupDryRunPlan() {
  const actions = [
    ...SYNC_MAP.map(({ src, dst, label }) => describeSyncAction(src, dst, label)),
    ...listSkillSyncActions(),
  ];
  const codexProfiles = previewCodexProfiles();
  actions.push({
    type: "codex-profiles",
    path: codexProfiles.path,
    change: codexProfiles.change,
    profiles: codexProfiles.profiles,
    windowsSandbox: codexProfiles.windowsSandbox,
  });

  const defaultHubUrl = `http://127.0.0.1:${process.env.TFX_HUB_PORT || "27888"}/mcp`;
  actions.push(...previewMcpRegistrationActions(defaultHubUrl));
  actions.push(previewStatusLineAction());

  return {
    dry_run: true,
    actions,
  };
}

function cmdSetup(options = {}) {
  const { dryRun = false, overrideVersion } = options;
  if (dryRun) {
    printJson(buildSetupDryRunPlan());
    return;
  }

  console.log(`\n${BOLD}triflux setup${RESET}\n`);

  for (const target of SYNC_MAP) {
    syncFile(target.src, target.dst, target.label);
  }

  // 스킬 동기화 (~/.claude/skills/{name}/SKILL.md)
  const skillsSrc = join(PKG_ROOT, "skills");
  const skillsDst = join(CLAUDE_DIR, "skills");
  if (existsSync(skillsSrc)) {
    let skillCount = 0;
    let skillTotal = 0;
    for (const name of readdirSync(skillsSrc)) {
      const src = join(skillsSrc, name, "SKILL.md");
      const dst = join(skillsDst, name, "SKILL.md");
      if (!existsSync(src)) continue;
      skillTotal++;

      const dstDir = dirname(dst);
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

      if (!existsSync(dst)) {
        copyFileSync(src, dst);
        skillCount++;
      } else {
        const srcContent = readFileSync(src, "utf8");
        const dstContent = readFileSync(dst, "utf8");
        if (srcContent !== dstContent) {
          copyFileSync(src, dst);
          skillCount++;
        }
      }
      // references/ 디렉토리 동기화 (존재하면)
      const refSrc = join(skillsSrc, name, "references");
      const refDst = join(skillsDst, name, "references");
      if (existsSync(refSrc)) {
        mkdirSync(refDst, { recursive: true });
        for (const refFile of readdirSync(refSrc)) {
          const rSrc = join(refSrc, refFile);
          const rDst = join(refDst, refFile);
          if (statSync(rSrc).isFile()) {
            if (!existsSync(rDst) || readFileSync(rSrc, "utf8") !== readFileSync(rDst, "utf8")) {
              copyFileSync(rSrc, rDst);
            }
          }
        }
      }
    }
    for (const { alias, source } of SKILL_ALIASES) {
      const srcDir = join(skillsSrc, source);
      const src = join(srcDir, "SKILL.md");
      if (!existsSync(src)) continue;
      skillTotal++;
      skillCount += syncAliasedSkillDir(srcDir, join(skillsDst, alias), { alias, source });
    }
    if (skillCount > 0) {
      ok(`스킬: ${skillCount}/${skillTotal}개 업데이트됨`);
    } else {
      ok(`스킬: ${skillTotal}개 최신 상태`);
    }
    // Stale 스킬 정리 (패키지에서 제거된 tfx-* 스킬 삭제)
    const staleCleanup = cleanupStaleSkills(skillsDst, skillsSrc);
    if (staleCleanup.count > 0) {
      ok(`구형 스킬 ${staleCleanup.count}개 제거: ${staleCleanup.removed.join(", ")}`);
    }
  }

  // ── psmux 기본 셸 자동 수정 (cmd.exe → PowerShell) ──
  if (process.platform === "win32" && which("psmux")) {
    try {
      const shellOut = execSync("psmux show-options -g default-shell 2>NUL", { encoding: "utf8", timeout: 3000 }).trim();
      if (!/powershell|pwsh/i.test(shellOut)) {
        const pwsh = which("pwsh") ? "pwsh" : (which("powershell.exe") ? "powershell.exe" : "");
        if (pwsh) {
          execSync(`psmux set-option -g default-shell "${pwsh}"`, { timeout: 3000, stdio: "pipe" });
          ok(`psmux 기본 셸 → ${pwsh}`);
        }
      }
    } catch { /* psmux 서버 미실행 — 무시 */ }
  }

  // ── 결과 추적 ──
  const summary = [];

  const codexProfileResult = ensureCodexProfiles();
  if (!codexProfileResult.ok) {
    warn(`Codex profiles 설정 실패: ${codexProfileResult.message}`);
    summary.push({ item: "Codex profiles", status: "⚠️", detail: codexProfileResult.message });
  } else if (codexProfileResult.changed > 0) {
    ok(`Codex profiles: ${codexProfileResult.changed}개 반영됨 (~/.codex/config.toml)`);
    summary.push({ item: "Codex profiles", status: "✅", detail: `${codexProfileResult.changed}개 반영됨` });
  } else {
    ok("Codex profiles: 이미 준비됨");
    summary.push({ item: "Codex profiles", status: "✅", detail: "이미 준비됨" });
  }

  // Gemini 프로필
  const geminiResult = ensureGeminiProfiles();
  if (!geminiResult.ok) {
    warn(`Gemini profiles 설정 실패: ${geminiResult.message}`);
    summary.push({ item: "Gemini profiles", status: "⚠️", detail: geminiResult.message });
  } else if (geminiResult.created) {
    ok(`Gemini profiles: ${geminiResult.count}개 생성됨 (~/.gemini/triflux-profiles.json)`);
    summary.push({ item: "Gemini profiles", status: "✅", detail: `${geminiResult.count}개 생성됨` });
  } else if (geminiResult.added > 0) {
    ok(`Gemini profiles: ${geminiResult.added}개 추가됨`);
    summary.push({ item: "Gemini profiles", status: "✅", detail: `${geminiResult.added}개 추가됨 (총 ${geminiResult.count}개)` });
  } else {
    ok(`Gemini profiles: ${geminiResult.count}개 준비됨`);
    summary.push({ item: "Gemini profiles", status: "✅", detail: `${geminiResult.count}개 준비됨` });
  }

  // hub MCP 사전 등록 (서버 미실행이어도 설정만 등록 — hub start 시 즉시 사용 가능)
  if (existsSync(join(PKG_ROOT, "hub", "server.mjs"))) {
    const defaultHubUrl = `http://127.0.0.1:${process.env.TFX_HUB_PORT || "27888"}/mcp`;
    autoRegisterMcp(defaultHubUrl);
    summary.push({ item: "Hub MCP", status: "✅", detail: "등록됨" });
    console.log("");
  }

  // HUD statusLine 설정
  console.log(`${CYAN}[HUD 설정]${RESET}`);
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  const hudPath = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");

  if (existsSync(hudPath)) {
    try {
      let settings = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      }

      const currentCmd = settings.statusLine?.command || "";
      if (currentCmd.includes("hud-qos-status.mjs")) {
        ok("statusLine 이미 설정됨");
        summary.push({ item: "HUD statusLine", status: "✅", detail: "이미 설정됨" });
      } else {
        const nodePath = process.execPath.replace(/\\/g, "/");
        const hudForward = hudPath.replace(/\\/g, "/");
        const nodeRef = nodePath.includes(" ") ? `"${nodePath}"` : nodePath;
        const hudRef = hudForward.includes(" ") ? `"${hudForward}"` : hudForward;

        if (currentCmd) {
          warn(`기존 statusLine 덮어쓰기: ${currentCmd}`);
        }

        settings.statusLine = {
          type: "command",
          command: `${nodeRef} ${hudRef}`,
        };

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        ok("statusLine 설정 완료 — 세션 재시작 후 HUD 표시");
        summary.push({ item: "HUD statusLine", status: "✅", detail: "설정 완료" });
      }
    } catch (e) {
      throw createCliError(`settings.json 처리 실패: ${e.message}`, {
        exitCode: EXIT_CONFIG_ERROR,
        reason: "configError",
        fix: `${settingsPath}의 JSON 문법을 수정하세요.`,
        cause: e,
      });
    }
  } else {
    warn("HUD 파일 없음 — 먼저 파일 동기화 필요");
    summary.push({ item: "HUD statusLine", status: "⚠️", detail: "HUD 파일 없음" });
  }

  // CLI 존재 확인
  const cliChecks = [
    { name: "codex", install: "npm i -g @openai/codex" },
    { name: "gemini", install: "npm i -g @google/gemini-cli" },
  ];
  for (const { name, install } of cliChecks) {
    if (which(name)) {
      summary.push({ item: `${name} CLI`, status: "✅", detail: "설치됨" });
    } else {
      summary.push({ item: `${name} CLI`, status: "⏭️", detail: `미설치 (${install})` });
    }
  }

  // Star request (버전 게이팅 + 인터랙티브 [y/n])
  const showStar = STAR_PROMPT_VERSIONS.length === 0 || STAR_PROMPT_VERSIONS.includes(PKG.version);
  if (showStar) {
    let ghOk = false;
    try {
      execFileSync("gh", ["auth", "status"], { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      ghOk = true;
    } catch {}

    if (!ghOk) {
      // gh 미설치/미인증 — URL만 표시
      console.log();
      info(`${AMBER}⭐${RESET} 하나가 큰 차이를 만듭니다. ${CYAN}https://github.com/tellang/triflux${RESET}`);
    } else {
      let alreadyStarred = false;
      try {
        execFileSync("gh", ["api", "user/starred/tellang/triflux"], { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
        alreadyStarred = true;
      } catch {}

      if (alreadyStarred) {
        console.log();
        ok(`이미 함께하고 계시군요. ${AMBER}⭐${RESET}`);
      } else {
        // 인터랙티브 confirm
        console.log();
        process.stdout.write(`    ${AMBER}⭐${RESET} 하나가 큰 차이를 만듭니다. Star? ${DIM}[y/N]${RESET} `);
        let answer = "";
        try {
          const buf = Buffer.alloc(128);
          const n = readSync(0, buf, 0, 128);
          answer = buf.toString("utf8", 0, n).trim().toLowerCase();
        } catch {
          // non-interactive stdin — 건너뜀
        }
        if (answer.startsWith("y")) {
          try {
            execFileSync("gh", ["api", "-X", "PUT", "/user/starred/tellang/triflux"], {
              timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
            });
            ok(`함께해 주셔서 감사합니다. ${AMBER}⭐${RESET}`);
          } catch {
            info(`${CYAN}https://github.com/tellang/triflux${RESET}`);
          }
        } else if (answer === "") {
          // 아무 입력 없이 Enter — 조용히 URL만
          console.log(`      ${DIM}https://github.com/tellang/triflux${RESET}`);
        }
      }
    }
  }

  // ── 결과 요약 테이블 ──
  console.log(`\n${BOLD}── 설정 요약 ──${RESET}`);
  const maxItem = Math.max(...summary.map((s) => s.item.length));
  for (const { item, status, detail } of summary) {
    console.log(`  ${status} ${item.padEnd(maxItem)}  ${DIM}${detail}${RESET}`);
  }

  console.log(`\n${DIM}설치 위치: ${CLAUDE_DIR}${RESET}`);
  console.log(`${DIM}버전: v${overrideVersion || PKG.version}${RESET}\n`);
}

function addDoctorCheck(report, entry) {
  report.checks.push(entry);
}

function toHookCoverageName(fileName, fallbackId = "") {
  if (typeof fileName === "string" && fileName.trim()) {
    return basename(fileName).replace(/\.mjs$/i, "");
  }
  return String(fallbackId || "").replace(/^tfx-/, "");
}

function computeHookCoverage(settings, managedHooks) {
  const coverage = {
    total: managedHooks.length,
    registered: 0,
    missing: [],
    duplicates: [],
  };

  const hooksByEvent = settings?.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

  // 이벤트별 orchestrator 존재 여부를 캐시
  const orchestratorByEvent = {};
  for (const [event, entries] of Object.entries(hooksByEvent)) {
    orchestratorByEvent[event] = Array.isArray(entries) && entries.some((entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((hook) =>
        typeof hook?.command === "string" && hook.command.includes("hook-orchestrator"),
      ),
    );
  }

  for (const spec of managedHooks) {
    const eventEntries = Array.isArray(hooksByEvent[spec.event]) ? hooksByEvent[spec.event] : [];

    // orchestrator가 있으면 registry 훅을 체이닝하므로 "registered"로 간주
    if (orchestratorByEvent[spec.event]) {
      coverage.registered++;

      // 동시에 개별 훅도 직접 등록되어 있으면 → 이중 실행 (duplicate)
      const directlyRegistered = eventEntries.some((entry) =>
        Array.isArray(entry?.hooks) &&
        entry.hooks.some((hook) => extractManagedHookFilename(hook?.command) === spec.fileName),
      );
      if (directlyRegistered) {
        coverage.duplicates.push(toHookCoverageName(spec.fileName, spec.id));
      }
      continue;
    }

    // orchestrator 없으면 기존 방식: 개별 훅 직접 등록 확인
    const found = eventEntries.some((entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((hook) => extractManagedHookFilename(hook?.command) === spec.fileName),
    );
    if (found) {
      coverage.registered++;
      continue;
    }
    coverage.missing.push(toHookCoverageName(spec.fileName, spec.id));
  }

  return coverage;
}

function formatPathForDisplay(filePath) {
  const value = String(filePath || "").replace(/\\/g, "/");
  const homePath = homedir().replace(/\\/g, "/");
  return value.startsWith(homePath) ? `~${value.slice(homePath.length)}` : value;
}

function renderTable(headers, rows) {
  if (!rows.length) return;
  const widths = headers.map((header, index) => {
    const cellWidths = rows.map((row) => stripAnsi(String(row[index] ?? "")).length);
    return Math.max(stripAnsi(header).length, ...cellWidths);
  });

  const padCell = (cell, width) => {
    const text = String(cell ?? "");
    return text + " ".repeat(Math.max(0, width - stripAnsi(text).length));
  };
  const formatRow = (row) => row.map((cell, index) => padCell(cell, widths[index])).join("  ");
  console.log(`    ${formatRow(headers)}`);
  console.log(`    ${widths.map((width) => "─".repeat(width)).join("  ")}`);
  for (const row of rows) {
    console.log(`    ${formatRow(row)}`);
  }
}

function getOptionValue(args, optionName) {
  const index = args.indexOf(optionName);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function statusBadge(status) {
  switch (status) {
    case "present":
    case "ok":
    case "removed":
      return `${GREEN_BRIGHT}${status}${RESET}`;
    case "updated":
      return `${AMBER}${status}${RESET}`;
    case "missing":
    case "missing-file":
    case "warning":
      return `${YELLOW}${status}${RESET}`;
    case "mismatch":
    case "invalid":
    case "invalid-config":
      return `${RED_BRIGHT}${status}${RESET}`;
    default:
      return status;
  }
}

function buildMcpStatusRows(statusInfo) {
  const registryRows = statusInfo.rows
    .filter((row) => row.type === "registry")
    .map((row) => {
      let detail = "";
      if (row.status === "present") detail = row.actualUrl || row.expectedUrl;
      else if (row.status === "missing") detail = "registry only";
      else if (row.status === "missing-file") detail = "config missing";
      else if (row.status === "mismatch") detail = `expected ${row.expectedUrl}`;
      else if (row.status === "invalid-config") detail = "parse error";
      else if (row.status === "stdio") detail = "configured as stdio";
      return [row.name, row.label, statusBadge(row.status), formatPathForDisplay(row.filePath), detail];
    });

  const stdioRows = statusInfo.rows
    .filter((row) => row.type === "stdio")
    .map((row) => [
      row.name,
      row.label,
      statusBadge("warning"),
      formatPathForDisplay(row.filePath),
      row.command ? `stdio: ${row.command}` : "stdio MCP",
    ]);

  return [...registryRows, ...stdioRows];
}

function ensureValidRegistryState() {
  const registryState = inspectRegistry();
  if (!registryState.exists) {
    throw createCliError(`MCP registry missing: ${registryState.path}`, {
      exitCode: EXIT_CONFIG_ERROR,
      reason: "configError",
      fix: "config/mcp-registry.json을 복원하거나 `tfx mcp add <name> --url <url>`로 다시 생성하세요.",
    });
  }
  if (!registryState.valid) {
    throw createCliError(`MCP registry invalid: ${registryState.errors.join("; ")}`, {
      exitCode: EXIT_CONFIG_ERROR,
      reason: "configError",
      fix: `${registryState.path}의 JSON 구조를 수정하세요.`,
    });
  }
  return registryState;
}

async function cmdDoctor(options = {}) {
  const { fix = false, reset = false, json = false } = options;
  const report = {
    status: "ok",
    mode: reset ? "reset" : fix ? "fix" : "check",
    checks: [],
    actions: [],
    hook_coverage: { total: 0, registered: 0, missing: [] },
    issue_count: 0,
  };

  return await withConsoleSilenced(json, async () => {
    const modeLabel = reset ? ` ${RED}--reset${RESET}` : fix ? ` ${YELLOW}--fix${RESET}` : "";
    console.log(`\n  ${AMBER}${BOLD}⬡ triflux doctor${RESET} ${VER}${modeLabel}\n`);
    console.log(`  ${LINE}`);

    // ── reset 모드: 캐시 전체 초기화 ──
    if (reset) {
      section("Cache Reset");
      const cacheDir = join(CLAUDE_DIR, "cache");
      const resetFiles = [
        "claude-usage-cache.json",
        ".claude-refresh-lock",
        "codex-rate-limits-cache.json",
        "gemini-quota-cache.json",
        "gemini-project-id.json",
        "gemini-session-cache.json",
        "gemini-rpm-tracker.json",
        "sv-accumulator.json",
        "mcp-inventory.json",
        "cli-issues.jsonl",
        "triflux-update-check.json",
      ];
      let cleared = 0;
      for (const name of resetFiles) {
        const fp = join(cacheDir, name);
        if (existsSync(fp)) {
          try {
            unlinkSync(fp);
            cleared++;
            report.actions.push({ type: "delete", path: fp, status: "ok" });
            ok(`삭제됨: ${name}`);
          } catch (e) {
            report.actions.push({ type: "delete", path: fp, status: "failed", message: e.message });
            fail(`삭제 실패: ${name} — ${e.message}`);
          }
        }
      }
      if (cleared === 0) {
        ok("삭제할 캐시 파일 없음 (이미 깨끗함)");
      } else {
        console.log("");
        ok(`${BOLD}${cleared}개${RESET} 캐시 파일 초기화 완료`);
      }
      console.log("");
      section("Cache Rebuild");
      const mcpCheck = join(PKG_ROOT, "scripts", "mcp-check.mjs");
      if (existsSync(mcpCheck)) {
        try {
          execFileSync(process.execPath, [mcpCheck], { timeout: 15000, stdio: "ignore", windowsHide: true });
          report.actions.push({ type: "rebuild", name: "mcp-inventory", status: "ok" });
          ok("MCP 인벤토리 재생성됨");
        } catch {
          report.actions.push({ type: "rebuild", name: "mcp-inventory", status: "failed" });
          warn("MCP 인벤토리 재생성 실패 — 다음 세션에서 자동 재시도");
        }
      }
      const hudScript = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
      if (existsSync(hudScript)) {
        try {
          execFileSync(process.execPath, [hudScript, "--refresh-claude-usage"], { timeout: 20000, stdio: "ignore", windowsHide: true });
          report.actions.push({ type: "rebuild", name: "claude-usage-cache", status: "ok" });
          ok("Claude 사용량 캐시 재생성됨");
        } catch {
          report.actions.push({ type: "rebuild", name: "claude-usage-cache", status: "failed" });
          warn("Claude 사용량 캐시 재생성 실패 — 다음 API 호출 시 자동 생성");
        }
        try {
          execFileSync(process.execPath, [hudScript, "--refresh-codex-rate-limits"], { timeout: 15000, stdio: "ignore", windowsHide: true });
          report.actions.push({ type: "rebuild", name: "codex-rate-limits-cache", status: "ok" });
          ok("Codex 레이트 리밋 캐시 재생성됨");
        } catch {
          report.actions.push({ type: "rebuild", name: "codex-rate-limits-cache", status: "failed" });
          warn("Codex 레이트 리밋 캐시 재생성 실패");
        }
        try {
          execFileSync(process.execPath, [hudScript, "--refresh-gemini-quota"], { timeout: 15000, stdio: "ignore", windowsHide: true });
          report.actions.push({ type: "rebuild", name: "gemini-quota-cache", status: "ok" });
          ok("Gemini 쿼터 캐시 재생성됨");
        } catch {
          report.actions.push({ type: "rebuild", name: "gemini-quota-cache", status: "failed" });
          warn("Gemini 쿼터 캐시 재생성 실패");
        }
      }
      try {
        const { buildAll } = await import("../scripts/cache-warmup.mjs");
        const warmupSummary = buildAll({ cwd: process.cwd(), force: true });
        if (warmupSummary.ok) {
          report.actions.push({ type: "rebuild", name: "warmup-caches", status: "ok", built: warmupSummary.built });
          ok("Phase 1 웜업 캐시 재생성됨");
        } else {
          report.actions.push({ type: "rebuild", name: "warmup-caches", status: "failed" });
          warn("Phase 1 웜업 캐시 재생성 실패");
        }
      } catch {
        report.actions.push({ type: "rebuild", name: "warmup-caches", status: "failed" });
        warn("Phase 1 웜업 캐시 재생성 실패");
      }
      console.log(`\n  ${LINE}`);
      console.log(`  ${GREEN_BRIGHT}${BOLD}✓ 캐시 초기화 + 재생성 완료${RESET}\n`);
      report.status = report.actions.some((action) => action.status === "failed") ? "issues" : "ok";
      report.issue_count = report.actions.filter((action) => action.status === "failed").length;
      if (json) printJson(report);
      return report;
    }

    // ── fix 모드: 파일 동기화 + 캐시 정리 후 진단 ──
    if (fix) {
    section("Auto Fix");
    for (const target of SYNC_MAP) {
      syncFile(target.src, target.dst, target.label);
    }
    // 스킬 동기화
    const fSkillsSrc = join(PKG_ROOT, "skills");
    const fSkillsDst = join(CLAUDE_DIR, "skills");
    if (existsSync(fSkillsSrc)) {
      let sc = 0, st = 0;
      for (const name of readdirSync(fSkillsSrc)) {
        const src = join(fSkillsSrc, name, "SKILL.md");
        const dst = join(fSkillsDst, name, "SKILL.md");
        if (!existsSync(src)) continue;
        st++;
        const dstDir = dirname(dst);
        if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
        if (!existsSync(dst)) { copyFileSync(src, dst); sc++; }
        else if (readFileSync(src, "utf8") !== readFileSync(dst, "utf8")) { copyFileSync(src, dst); sc++; }
      }
      if (sc > 0) ok(`스킬: ${sc}/${st}개 업데이트됨`);
      else ok(`스킬: ${st}개 최신 상태`);
    }
    const profileFix = ensureCodexProfiles();
    if (!profileFix.ok) {
      warn(`Codex Profiles 자동 복구 실패: ${profileFix.message}`);
    } else if (profileFix.changed > 0) {
      ok(`Codex Profiles: ${profileFix.changed}개 반영됨`);
    } else {
      info("Codex Profiles: 이미 최신 상태");
    }
    // 에러/스테일 캐시 정리
    const fCacheDir = join(CLAUDE_DIR, "cache");
    const staleNames = ["claude-usage-cache.json", ".claude-refresh-lock", "codex-rate-limits-cache.json"];
    let cleaned = 0;
    for (const name of staleNames) {
      const fp = join(fCacheDir, name);
      if (!existsSync(fp)) continue;
      try {
        const parsed = JSON.parse(readFileSync(fp, "utf8"));
        if (parsed.error || name.startsWith(".")) { unlinkSync(fp); cleaned++; ok(`에러 캐시 정리: ${name}`); }
      } catch { try { unlinkSync(fp); cleaned++; ok(`손상된 캐시 정리: ${name}`); } catch {} }
    }
    if (cleaned === 0) info("에러 캐시 없음");
    try {
      const { fixCaches } = await import("../scripts/cache-doctor.mjs");
      const cacheRepair = await fixCaches({ cwd: process.cwd() });
      if (cacheRepair.fixed.length > 0 && cacheRepair.ok) {
        ok(`웜업 캐시 자동 복구: ${cacheRepair.fixed.join(", ")}`);
      } else if (cacheRepair.fixed.length > 0) {
        warn(`웜업 캐시 자동 복구 실패: ${cacheRepair.fixed.join(", ")}`);
      } else {
        info("웜업 캐시: 이미 정상 상태");
      }
    } catch {
      warn("웜업 캐시 자동 복구 실패");
    }
    const registryStateForFix = inspectRegistry();
    if (registryStateForFix.valid) {
      try {
        const mcpSync = syncRegistryTargets({ registry: registryStateForFix.registry });
        const updatedCount = mcpSync.actions.filter((action) => action.status === "updated").length;
        const invalidCount = mcpSync.actions.filter((action) => action.status === "invalid-config").length;
        report.actions.push({ type: "mcp-sync", status: invalidCount > 0 ? "issues" : "ok", actions: mcpSync.actions });
        if (updatedCount > 0) ok(`MCP registry 동기화: ${updatedCount}개 설정 반영됨`);
        else info("MCP registry: 이미 최신 상태");
        if (invalidCount > 0) warn(`MCP registry 동기화 건너뜀: parse error ${invalidCount}개`);
      } catch (error) {
        report.actions.push({ type: "mcp-sync", status: "failed", message: error.message });
        warn(`MCP registry 자동 동기화 실패: ${error.message}`);
      }
    } else if (registryStateForFix.exists) {
      warn("MCP registry invalid — auto sync 건너뜀");
    } else {
      info("MCP registry 없음 — auto sync 건너뜀");
    }
    console.log(`\n  ${LINE}`);
    info("수정 완료 — 아래 진단 결과를 확인하세요");
    console.log("");
  }

    let issues = 0;

    // 1. tfx-route.sh
    section("tfx-route.sh");
    const routeSh = join(CLAUDE_DIR, "scripts", "tfx-route.sh");
    if (existsSync(routeSh)) {
      const ver = getVersion(routeSh);
      addDoctorCheck(report, { name: "tfx-route.sh", status: "ok", path: routeSh, version: ver });
      ok(`설치됨 ${ver ? `${DIM}v${ver}${RESET}` : ""}`);
    } else {
      addDoctorCheck(report, { name: "tfx-route.sh", status: "missing", path: routeSh, fix: "tfx setup" });
      fail("미설치 — tfx setup 실행 필요");
      issues++;
    }

    // 2. HUD
    section("HUD");
    const hud = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
    if (existsSync(hud)) {
      addDoctorCheck(report, { name: "hud-qos-status.mjs", status: "ok", path: hud });
      ok("설치됨");
    } else {
      addDoctorCheck(report, { name: "hud-qos-status.mjs", status: "missing", path: hud, optional: true, fix: "tfx setup" });
      warn(`미설치 ${GRAY}(선택사항)${RESET}`);
    }

    // 3. Codex CLI
    section(`Codex CLI ${WHITE_BRIGHT}●${RESET}`);
    const codexCli = checkCliCrossShell("codex", "npm install -g @openai/codex");
    issues += codexCli.issues;
    addDoctorCheck(report, {
      name: "codex",
      status: codexCli.status,
      shells: codexCli.shells,
      ...(codexCli.fix ? { fix: codexCli.fix } : {}),
    });
    // API 키 검사 제거 — bash exec 기반이므로 API 키 불필요

    // 4. Codex Profiles
    section("Codex Profiles");
    if (existsSync(CODEX_CONFIG_PATH)) {
      const codexConfig = readFileSync(CODEX_CONFIG_PATH, "utf8");
      const missingProfiles = [];
      for (const profile of REQUIRED_CODEX_PROFILES) {
        if (hasProfileSection(codexConfig, profile.name)) {
          ok(`${profile.name}: 정상${profile.proOnly ? ` ${DIM}(Pro 전용)${RESET}` : ""}`);
        } else if (profile.proOnly) {
          info(`${profile.name}: 미설정 ${DIM}(Pro 전용 — Plus/기본에서는 불필요)${RESET}`);
        } else {
          missingProfiles.push(profile.name);
          warn(`${profile.name}: 미설정`);
          issues++;
        }
      }
      addDoctorCheck(report, {
        name: "codex-profiles",
        status: missingProfiles.length === 0 ? "ok" : "missing",
        path: CODEX_CONFIG_PATH,
        missing_profiles: missingProfiles,
        ...(missingProfiles.length > 0 ? { fix: "tfx setup" } : {}),
      });
    } else {
      addDoctorCheck(report, { name: "codex-profiles", status: "missing", path: CODEX_CONFIG_PATH, fix: "tfx setup" });
      warn("config.toml 미존재");
      issues++;
    }

    // Codex 구형 모델 감지
    if (existsSync(CODEX_CONFIG_PATH)) {
      const codexContent = readFileSync(CODEX_CONFIG_PATH, "utf8");
      const legacyFound = LEGACY_CODEX_MODELS.filter(m => codexContent.includes(`"${m}"`));
      if (legacyFound.length > 0) {
        warn(`구형 모델 감지: ${legacyFound.join(", ")}`);
        info("최신 프로필로 마이그레이션: tfx setup 또는 tfx profile");
        addDoctorCheck(report, { name: "codex-legacy-models", status: "issues", models: legacyFound, fix: "tfx setup" });
        issues++;
      }
    }

    // 5. Gemini CLI
    section(`Gemini CLI ${BLUE}●${RESET}`);
    const geminiCli = checkCliCrossShell("gemini", "npm install -g @google/gemini-cli");
    issues += geminiCli.issues;
    addDoctorCheck(report, {
      name: "gemini",
      status: geminiCli.status,
      shells: geminiCli.shells,
      ...(geminiCli.fix ? { fix: geminiCli.fix } : {}),
    });
    // API 키 검사 제거 — bash exec 기반이므로 API 키 불필요

    // Gemini 구형 모델 감지
    const geminiProfilesPath = join(homedir(), ".gemini", "triflux-profiles.json");
    const LEGACY_GEMINI_MODELS = ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.5-pro-preview"];
    if (existsSync(geminiProfilesPath)) {
      try {
        const geminiContent = readFileSync(geminiProfilesPath, "utf8");
        const geminiLegacy = LEGACY_GEMINI_MODELS.filter(m => geminiContent.includes(m));
        if (geminiLegacy.length > 0) {
          warn(`구형 모델 감지: ${geminiLegacy.join(", ")}`);
          info("최신 프로필로 마이그레이션: tfx setup 또는 tfx profile");
          addDoctorCheck(report, { name: "gemini-legacy-models", status: "issues", models: geminiLegacy, fix: "tfx setup" });
          issues++;
        }
      } catch {}
    }

    // 6. Claude Code
    section(`Claude Code ${AMBER}●${RESET}`);
    const claudePath = which("claude");
    if (claudePath) {
      addDoctorCheck(report, { name: "claude", status: "ok", path: claudePath });
      ok("설치됨");
    } else {
      addDoctorCheck(report, { name: "claude", status: "missing", fix: "Claude Code를 설치한 뒤 `tfx doctor`를 다시 실행하세요." });
      fail("미설치 (필수)");
      issues++;
    }

    // 7. psmux (Windows only)
    if (process.platform === "win32") {
      section("psmux (터미널 멀티플렉서)");
      const psmuxPath = which("psmux");
      if (psmuxPath) {
        ok("설치됨");
        // 기본 셸 확인: psmux 세션의 기본 셸이 PowerShell인지 cmd.exe인지
        let shellOk = false;
        try {
          const defaultShell = execSync("psmux show-options -g default-shell 2>NUL", { encoding: "utf8", timeout: 3000 }).trim();
          shellOk = /powershell|pwsh/i.test(defaultShell);
        } catch {
          // show-options 실패 시 pwsh/powershell 존재 여부로 판단
          shellOk = !!which("pwsh") || !!which("powershell.exe");
        }
        if (shellOk) {
          ok("기본 셸: PowerShell");
          addDoctorCheck(report, { name: "psmux", status: "ok", path: psmuxPath, shell: "powershell" });
        } else {
          if (fix) {
            // --fix: PowerShell로 자동 변경
            const pwshBin = which("pwsh") ? "pwsh" : "powershell.exe";
            try {
              execSync(`psmux set-option -g default-shell "${pwshBin}"`, { timeout: 3000, stdio: "pipe" });
              ok(`기본 셸 → ${pwshBin} 으로 변경 완료`);
              addDoctorCheck(report, { name: "psmux", status: "ok", path: psmuxPath, shell: pwshBin, fixed: true });
              report.actions.push("psmux default-shell → " + pwshBin);
            } catch (e) {
              fail(`기본 셸 변경 실패: ${e.message}`);
              addDoctorCheck(report, { name: "psmux", status: "issues", path: psmuxPath, shell: "cmd", fix: `psmux set-option -g default-shell "${pwshBin}"` });
              issues++;
            }
          } else {
            warn("기본 셸이 cmd.exe — headless 명령 실패 가능");
            info(`수정: tfx doctor --fix 또는 psmux set-option -g default-shell "powershell.exe"`);
            addDoctorCheck(report, { name: "psmux", status: "issues", path: psmuxPath, shell: "cmd", fix: "tfx doctor --fix" });
            issues++;
          }
        }
      } else {
        info(`미설치 ${GRAY}(선택 — 멀티모델 병렬 실행에 필요)${RESET}`);
        info(`설치: winget install marlocarlo.psmux`);
        addDoctorCheck(report, { name: "psmux", status: "skipped", detail: "미설치 (선택)", fix: "winget install marlocarlo.psmux" });
      }
    }

  // 8. 스킬 설치 상태
  section("Skills");
  const skillsSrc = join(PKG_ROOT, "skills");
  const skillsDst = join(CLAUDE_DIR, "skills");
  if (existsSync(skillsSrc)) {
    let installed = 0;
    let total = 0;
    const missing = [];
    for (const name of readdirSync(skillsSrc)) {
      if (!existsSync(join(skillsSrc, name, "SKILL.md"))) continue;
      total++;
      if (existsSync(join(skillsDst, name, "SKILL.md"))) {
        installed++;
      } else {
        missing.push(name);
      }
    }
      if (installed === total) {
        addDoctorCheck(report, { name: "skills", status: "ok", installed, total });
        ok(`${installed}/${total}개 설치됨`);
      } else {
        addDoctorCheck(report, { name: "skills", status: "missing", installed, total, missing, fix: "tfx setup" });
        warn(`${installed}/${total}개 설치됨 — 미설치: ${missing.join(", ")}`);
        info("triflux setup으로 동기화 가능");
        issues++;
      }
    } else {
      addDoctorCheck(report, { name: "skills", status: "missing", installed: 0, total: 0, fix: "패키지 skills 디렉토리를 확인하세요." });
    }

    // Stale 스킬 체크
    const staleSkills = [];
    const userSkillsDir = join(CLAUDE_DIR, "skills");
    if (existsSync(userSkillsDir)) {
      const pkgSkillsDir = join(PKG_ROOT, "skills");
      const pkgSkills = new Set();
      if (existsSync(pkgSkillsDir)) {
        for (const n of readdirSync(pkgSkillsDir)) pkgSkills.add(n);
      }
      for (const { alias } of SKILL_ALIASES) pkgSkills.add(alias);

      for (const n of readdirSync(userSkillsDir)) {
        if (!n.startsWith("tfx-")) continue;
        if (!pkgSkills.has(n)) staleSkills.push(n);
      }
    }
    if (staleSkills.length > 0) {
      warn(`구형 스킬 ${staleSkills.length}개 감지: ${staleSkills.join(", ")}`);
      info("제거: tfx setup 또는 tfx update");
      addDoctorCheck(report, { name: "stale-skills", status: "issues", skills: staleSkills, fix: "tfx setup" });
      issues++;
    } else {
      addDoctorCheck(report, { name: "stale-skills", status: "ok" });
    }

    // 9. 플러그인 등록
    section("Plugin");
    const pluginsFile = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
    if (existsSync(pluginsFile)) {
      const content = readFileSync(pluginsFile, "utf8");
      if (content.includes("triflux")) {
        addDoctorCheck(report, { name: "plugin", status: "ok", path: pluginsFile });
        ok("triflux 플러그인 등록됨");
      } else {
        addDoctorCheck(report, { name: "plugin", status: "missing", path: pluginsFile, optional: true, fix: "/plugin marketplace add <repo-url>" });
        warn("triflux 플러그인 미등록 — npm 단독 사용 중");
        info("플러그인 등록: /plugin marketplace add <repo-url>");
      }
    } else {
      addDoctorCheck(report, { name: "plugin", status: "unavailable", optional: true });
      info("플러그인 시스템 감지 안 됨 — npm 단독 사용");
    }

  // 10. MCP 인벤토리
  section("MCP Inventory");
  const mcpCache = join(CLAUDE_DIR, "cache", "mcp-inventory.json");
  if (existsSync(mcpCache)) {
    try {
      const inv = JSON.parse(readFileSync(mcpCache, "utf8"));
      addDoctorCheck(report, {
        name: "mcp-inventory",
        status: "ok",
        path: mcpCache,
        codex_servers: inv.codex?.servers?.length || 0,
        gemini_servers: inv.gemini?.servers?.length || 0,
      });
      ok(`캐시 존재 (${inv.timestamp})`);
      if (inv.codex?.servers?.length) {
        const names = inv.codex.servers.map(s => s.name).join(", ");
        info(`Codex: ${inv.codex.servers.length}개 서버 (${names})`);
      }
      if (inv.gemini?.servers?.length) {
        const names = inv.gemini.servers.map(s => s.name).join(", ");
        info(`Gemini: ${inv.gemini.servers.length}개 서버 (${names})`);
      }
    } catch {
      addDoctorCheck(report, { name: "mcp-inventory", status: "invalid", path: mcpCache, fix: `node ${join(PKG_ROOT, "scripts", "mcp-check.mjs")}` });
      warn("캐시 파일 파싱 실패");
    }
  } else {
    addDoctorCheck(report, { name: "mcp-inventory", status: "missing", path: mcpCache, fix: `node ${join(PKG_ROOT, "scripts", "mcp-check.mjs")}` });
    warn("캐시 없음 — 다음 세션 시작 시 자동 생성");
    info(`수동: node ${join(PKG_ROOT, "scripts", "mcp-check.mjs")}`);
  }

  // 9.5. Phase 1 웜업 캐시
  section("Warmup Cache");
  try {
    const { verifyCaches } = await import("../scripts/cache-doctor.mjs");
    const cacheVerification = verifyCaches({ cwd: process.cwd() });
    const brokenCaches = cacheVerification.results.filter((result) => result.status !== "ok");

    addDoctorCheck(report, {
      name: "warmup-cache",
      status: cacheVerification.ok ? "ok" : "issues",
      files: cacheVerification.results.map((result) => ({
        target: result.target,
        status: result.status,
        path: result.file,
      })),
      ...(cacheVerification.ok ? {} : { fix: "tfx doctor --fix" }),
    });

    if (brokenCaches.length === 0) {
      ok("4개 웜업 캐시 정상");
    } else {
      warn(`${brokenCaches.length}개 웜업 캐시 이슈 발견`);
      for (const entry of brokenCaches) {
        info(`${entry.target}: ${entry.status}`);
      }
      if (!fix) issues += brokenCaches.length;
    }
  } catch (error) {
    addDoctorCheck(report, {
      name: "warmup-cache",
      status: "invalid",
      fix: "node scripts/cache-doctor.mjs --fix",
    });
    warn(`웜업 캐시 검사 실패: ${error.message}`);
    issues++;
  }

  // 11. CLI 이슈 트래커
  section("CLI Issues");
  const issuesFile = join(CLAUDE_DIR, "cache", "cli-issues.jsonl");
  if (existsSync(issuesFile)) {
    try {
      const lines = readFileSync(issuesFile, "utf8").trim().split("\n").filter(Boolean);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const unresolved = entries.filter(e => !e.resolved);

      if (unresolved.length === 0) {
        addDoctorCheck(report, { name: "cli-issues", status: "ok", path: issuesFile, unresolved: 0 });
        ok("미해결 이슈 없음");
      } else {
        // 패턴별 그룹핑
        const groups = {};
        for (const e of unresolved) {
          const key = `${e.cli}:${e.pattern}`;
          if (!groups[key]) groups[key] = { ...e, count: 0 };
          groups[key].count++;
          if (e.ts > groups[key].ts) { groups[key].ts = e.ts; groups[key].snippet = e.snippet; }
        }

        // semver 비교 (lexicographic 비교 버그 방지)
        function semverGte(a, b) {
          const pa = a.split('.').map(Number);
          const pb = b.split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) > (pb[i] || 0)) return true;
            if ((pa[i] || 0) < (pb[i] || 0)) return false;
          }
          return true;
        }

        // 알려진 해결 버전 (패턴별 수정된 triflux 버전)
        const KNOWN_FIXES = {
          "gemini:deprecated_flag": "1.8.9",  // -p → --prompt
        };

        const currentVer = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
        let cleaned = 0;

        for (const [key, g] of Object.entries(groups)) {
          const fixVer = KNOWN_FIXES[key];
          if (fixVer && semverGte(currentVer, fixVer)) {
            // 해결된 이슈 — 자동 정리
            cleaned += g.count;
            continue;
          }
          const age = Date.now() - g.ts;
          const ago = age < 3600000 ? `${Math.round(age / 60000)}분 전` :
            age < 86400000 ? `${Math.round(age / 3600000)}시간 전` :
            `${Math.round(age / 86400000)}일 전`;
          const sev = g.severity === "error" ? `${RED}ERROR${RESET}` : `${YELLOW}WARN${RESET}`;
          warn(`[${sev}] ${g.cli}/${g.pattern} x${g.count} (최근: ${ago})`);
          if (g.snippet) info(`  ${g.snippet.substring(0, 120)}`);
          if (fixVer) info(`  해결: triflux >= v${fixVer} (npm update -g triflux)`);
          issues++;
        }

        // 해결된 이슈 자동 정리
        if (cleaned > 0) {
          const remaining = entries.filter(e => {
            const key = `${e.cli}:${e.pattern}`;
            const fixVer = KNOWN_FIXES[key];
            return !(fixVer && semverGte(currentVer, fixVer));
          });
          writeFileSync(issuesFile, remaining.map(e => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : ""));
          ok(`${cleaned}개 해결된 이슈 자동 정리됨`);
        }
        addDoctorCheck(report, { name: "cli-issues", status: unresolved.length === 0 ? "ok" : "issues", path: issuesFile, unresolved: unresolved.length });
      }
    } catch (e) {
      addDoctorCheck(report, { name: "cli-issues", status: "invalid", path: issuesFile, fix: "cli-issues.jsonl 형식을 확인하세요." });
      warn(`이슈 파일 읽기 실패: ${e.message}`);
    }
  } else {
    addDoctorCheck(report, { name: "cli-issues", status: "ok", path: issuesFile, unresolved: 0 });
    ok("이슈 로그 없음 (정상)");
  }

  // 12. Team Sessions
  section("Team Sessions");
  const teamSessionReport = inspectTeamSessions();
  if (!teamSessionReport.mux) {
    addDoctorCheck(report, { name: "team-sessions", status: "skipped", detail: "tmux/psmux unavailable" });
    info("tmux/psmux 미감지 — 팀 세션 검사 건너뜀");
  } else if (teamSessionReport.sessions.length === 0) {
    addDoctorCheck(report, { name: "team-sessions", status: "ok", multiplexer: teamSessionReport.mux, sessions: 0 });
    ok(`활성 팀 세션 없음 ${DIM}(${teamSessionReport.mux})${RESET}`);
  } else {
    addDoctorCheck(report, {
      name: "team-sessions",
      status: teamSessionReport.sessions.some((session) => session.stale) ? "issues" : "ok",
      multiplexer: teamSessionReport.mux,
      sessions: teamSessionReport.sessions.map((session) => ({
        name: session.sessionName,
        attached: session.attachedCount,
        age_sec: session.ageSec,
        stale: session.stale,
      })),
    });
    info(`multiplexer: ${teamSessionReport.mux}`);

    for (const session of teamSessionReport.sessions) {
      const attachedLabel = session.attachedCount == null ? "?" : `${session.attachedCount}`;
      const ageLabel = formatElapsedAge(session.ageSec);

      if (session.stale) {
        warn(`${session.sessionName}: stale 추정 (attach=${attachedLabel}, 경과=${ageLabel})`);
      } else {
        ok(`${session.sessionName}: 정상 (attach=${attachedLabel}, 경과=${ageLabel})`);
      }

      if (session.createdAt == null) {
        info(`${session.sessionName}: session_created 파싱 실패${session.createdRaw ? ` (${session.createdRaw})` : ""}`);
      }
    }

    const staleSessions = teamSessionReport.sessions.filter((session) => session.stale);
    if (staleSessions.length > 0) {
      if (fix) {
        const cleanupResult = await cleanupStaleTeamSessions(staleSessions);
        issues += cleanupResult.failed;
      } else {
        info("정리: tfx doctor --fix");
        issues += staleSessions.length;
      }
    }
  }

  // 13. OMC stale team 상태
  section("OMC Stale Teams");
  const omcTeamReport = inspectStaleOmcTeams({
    startDir: process.cwd(),
    maxAgeMs: STALE_TEAM_MAX_AGE_SEC * 1000,
    liveSessionNames: teamSessionReport.sessions.map((session) => session.sessionName),
  });
  if (!omcTeamReport.stateRoot && !omcTeamReport.teamsRoot) {
    addDoctorCheck(report, { name: "omc-stale-teams", status: "skipped" });
    info(".omc/state 및 ~/.claude/teams 없음 — 검사 건너뜀");
  } else if (omcTeamReport.entries.length === 0) {
    addDoctorCheck(report, { name: "omc-stale-teams", status: "ok", entries: 0 });
    const roots = [omcTeamReport.stateRoot, omcTeamReport.teamsRoot].filter(Boolean).join(", ");
    ok(`stale team 없음 ${DIM}(${roots})${RESET}`);
  } else {
    addDoctorCheck(report, { name: "omc-stale-teams", status: "issues", entries: omcTeamReport.entries.length, fix: "tfx doctor --fix" });
    warn(`${omcTeamReport.entries.length}개 stale team 발견`);

    for (const entry of omcTeamReport.entries) {
      const ageLabel = formatElapsedAge(entry.ageSec);
      const scopeLabel = entry.scope === "root"
        ? "root-state"
        : entry.scope === "claude_team"
          ? `claude-team:${entry.teamName || entry.sessionId}`
          : entry.sessionId;
      warn(`${scopeLabel}: stale team (경과=${ageLabel}, 프로세스 없음)`);
      if (entry.teamName) info(`팀: ${entry.teamName}`);
      info(`파일: ${entry.stateFile || entry.cleanupPath}`);
    }

    if (fix) {
      const cleanupResult = await cleanupStaleOmcTeams(omcTeamReport.entries);
      for (const result of cleanupResult.results) {
        if (result.ok) {
          const label = result.entry.scope === "root"
            ? "root-state"
            : result.entry.scope === "claude_team"
              ? (result.entry.teamName || result.entry.sessionId)
              : result.entry.sessionId;
          ok(`stale team 정리: ${label}`);
        } else {
          const label = result.entry.scope === "root"
            ? "root-state"
            : result.entry.scope === "claude_team"
              ? (result.entry.teamName || result.entry.sessionId)
              : result.entry.sessionId;
          fail(`stale team 정리 실패: ${label} — ${result.error.message}`);
        }
      }
      issues += cleanupResult.failed;
    } else {
      info("정리: tfx doctor --fix");
      issues += omcTeamReport.entries.length;
    }
  }

  // 12.5. 고아 node.exe 프로세스 정리 (Windows)
  section("Orphan Processes");
  if (process.platform === "win32") {
    try {
      const { cleanupOrphanNodeProcesses } = await import("../hub/lib/process-utils.mjs");
      if (fix) {
        const { killed, remaining } = cleanupOrphanNodeProcesses();
        if (killed > 0) {
          warn(`고아 node.exe ${killed}개 정리 완료 (남은 프로세스: ${remaining})`);
        } else {
          ok(`고아 node.exe 없음 (활성: ${remaining})`);
        }
      } else {
        // --fix 없이는 개수만 보고
        const { execSync: execSyncDoctor } = await import("node:child_process");
        const countStr = execSyncDoctor(
          `powershell -NoProfile -WindowStyle Hidden -Command "(Get-Process node -ErrorAction SilentlyContinue).Count"`,
          { encoding: "utf8", timeout: 5000 },
        ).trim();
        const count = Number.parseInt(countStr, 10) || 0;
        if (count > 20) {
          warn(`node.exe ${count}개 실행 중 (고아 포함 가능). 정리: tfx doctor --fix`);
          issues++;
        } else {
          ok(`node.exe ${count}개 (정상 범위)`);
        }
      }
    } catch (e) {
      info(`고아 프로세스 검사 실패: ${e.message}`);
    }
  } else {
    ok("Windows 전용 검사 — 건너뜀");
  }

  // 14. Stale Teams (Claude teams/ + tasks/ 자동 감지)
  section("Stale Teams");
  const teamsDir = join(CLAUDE_DIR, "teams");
  const tasksDir = join(CLAUDE_DIR, "tasks");
  if (existsSync(teamsDir)) {
    try {
      const teamDirs = readdirSync(teamsDir).filter(d => {
        try { return statSync(join(teamsDir, d)).isDirectory(); } catch { return false; }
      });
      if (teamDirs.length === 0) {
        addDoctorCheck(report, { name: "stale-teams", status: "ok", entries: 0 });
        ok("잔존 팀 없음");
      } else {
        const nowMs = Date.now();
        const staleMaxAgeMs = STALE_TEAM_MAX_AGE_SEC * 1000;
        const staleTeams = [];
        const activeTeams = [];

        for (const d of teamDirs) {
          const teamPath = join(teamsDir, d);
          const configPath = join(teamPath, "config.json");
          let teamConfig = null;
          let configMtimeMs = null;
          let missingConfig = false;

          // config.json 읽기 — createdAt 또는 mtime으로 나이 판정
          try {
            const configStat = statSync(configPath);
            configMtimeMs = configStat.mtimeMs;
            teamConfig = JSON.parse(readFileSync(configPath, "utf8"));
          } catch {
            missingConfig = true;
            // config.json 없으면 표시용 경과 시간만 디렉토리 기준으로 계산
            try { configMtimeMs = statSync(teamPath).mtimeMs; } catch {}
          }

          const createdAtMs = teamConfig?.createdAt ?? configMtimeMs;
          const ageMs = createdAtMs != null ? Math.max(0, nowMs - createdAtMs) : null;
          const ageSec = ageMs != null ? Math.floor(ageMs / 1000) : null;
          const aged = ageMs != null && ageMs >= staleMaxAgeMs;

          // 활성 멤버 확인 — leadSessionId 또는 멤버 agentId로 프로세스 검색
          let hasActiveMember = false;
          if (teamConfig?.members?.length > 0) {
            const searchTokens = [];
            if (teamConfig.leadSessionId) searchTokens.push(teamConfig.leadSessionId.toLowerCase());
            if (teamConfig.name) searchTokens.push(teamConfig.name.toLowerCase());
            for (const member of teamConfig.members) {
              if (member.agentId) searchTokens.push(member.agentId.split("@")[0].toLowerCase());
            }

            // tmux 세션 이름과 매칭
            const liveSessionNames = teamSessionReport.sessions.map(s => s.sessionName.toLowerCase());
            hasActiveMember = searchTokens.some(token =>
              liveSessionNames.some(name => name.includes(token))
            );

            // 프로세스 명령줄에서 세션 ID 매칭 (tmux 없는 in-process 팀 지원)
            if (!hasActiveMember && teamConfig.leadSessionId) {
              try {
                const sessionToken = teamConfig.leadSessionId.toLowerCase();
                const safeToken = teamConfig.leadSessionId.slice(0, 8).replace(/[^a-zA-Z0-9\-]/g, '');
                // Claude Code 프로세스에서 세션 ID 검색
                if (process.platform === "win32") {
                  const psOut = execSync(
                    `powershell -NoProfile -WindowStyle Hidden -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${safeToken}' } | Select-Object ProcessId | ConvertTo-Json -Compress"`,
                    { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
                  ).trim();
                  if (psOut && psOut !== "null") {
                    const parsed = JSON.parse(psOut);
                    const procs = Array.isArray(parsed) ? parsed : [parsed];
                    hasActiveMember = procs.some(p => p.ProcessId > 0);
                  }
                } else {
                  const psOut = execSync(
                    `ps -ax -o pid=,command= | grep -i '${safeToken}' | grep -v grep`,
                    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
                  ).trim();
                  hasActiveMember = psOut.length > 0;
                }
              } catch {
                // 프로세스 검색 실패 — stale로 간주하지 않음 (보수적)
              }
            }
          }

          const stale = missingConfig || (aged && !hasActiveMember);
          const teamEntry = {
            name: d,
            teamName: teamConfig?.name || d,
            description: teamConfig?.description || null,
            memberCount: teamConfig?.members?.length || 0,
            ageSec,
            stale,
            hasActiveMember,
            missingConfig,
          };

          if (stale) {
            staleTeams.push(teamEntry);
          } else {
            activeTeams.push(teamEntry);
          }
        }

        // 활성 팀 표시
        for (const t of activeTeams) {
          const ageLabel = formatElapsedAge(t.ageSec);
          const memberLabel = `${t.memberCount}명`;
          ok(`${t.name}: 활성 (경과=${ageLabel}, 멤버=${memberLabel})`);
        }

        // stale 팀 표시 및 정리
        if (staleTeams.length === 0 && activeTeams.length > 0) {
          addDoctorCheck(report, { name: "stale-teams", status: "ok", active: activeTeams.length, stale: 0 });
          ok("stale 팀 없음");
        } else if (staleTeams.length > 0) {
          addDoctorCheck(report, { name: "stale-teams", status: "issues", active: activeTeams.length, stale: staleTeams.length, fix: "tfx doctor --fix" });
          warn(`${staleTeams.length}개 stale 팀 발견`);
          for (const t of staleTeams) {
            const ageLabel = formatElapsedAge(t.ageSec);
            const reasonLabel = t.missingConfig ? "config.json 없음" : "활성 프로세스 없음";
            warn(`${t.name}: stale (경과=${ageLabel}, 멤버=${t.memberCount}명, ${reasonLabel})`);
            if (t.description) info(`설명: ${t.description}`);
          }

          if (fix) {
            let cleaned = 0;
            for (const t of staleTeams) {
              try {
                await forceCleanupTeam(t.name);
                cleaned++;
                ok(`stale 팀 정리: ${t.name}`);
              } catch (e) {
                fail(`팀 정리 실패: ${t.name} — ${e.message}`);
              }
            }
            info(`${cleaned}/${staleTeams.length}개 stale 팀 정리 완료`);
          } else {
            info("정리: tfx doctor --fix");
            issues += staleTeams.length;
          }
        }
      }
    } catch (e) {
      addDoctorCheck(report, { name: "stale-teams", status: "invalid", fix: "teams 디렉토리 구조를 확인하세요." });
      warn(`teams 디렉토리 읽기 실패: ${e.message}`);
    }
  } else {
    addDoctorCheck(report, { name: "stale-teams", status: "ok", entries: 0 });
    ok("잔존 팀 없음");
  }

  // ── Docs 동기화 상태 ──
  section("Docs Sync");
  {
    const docsDirs = ["docs/design", "docs/research"];
    const missingDocs = [];
    for (const dir of docsDirs) {
      const src = join(PKG_ROOT, dir);
      const dest = join(CLAUDE_DIR, dir);
      if (existsSync(src)) {
        const srcFiles = readdirSync(src).filter(f => f.endsWith(".md"));
        if (!existsSync(dest)) {
          missingDocs.push({ dir, missing: srcFiles.length, detail: "디렉토리 없음" });
        } else {
          const destFiles = readdirSync(dest).filter(f => f.endsWith(".md"));
          const missing = srcFiles.filter(f => !destFiles.includes(f));
          if (missing.length > 0) missingDocs.push({ dir, missing: missing.length, detail: missing.join(", ") });
        }
      }
    }
    if (missingDocs.length === 0) {
      addDoctorCheck(report, { name: "docs-sync", status: "ok" });
      ok("레퍼런스 문서 동기화 정상");
    } else {
      addDoctorCheck(report, { name: "docs-sync", status: "issues", missingDocs, fix: "tfx setup" });
      warn(`${missingDocs.reduce((s, d) => s + d.missing, 0)}개 레퍼런스 미동기화`);
      for (const d of missingDocs) info(`${d.dir}: ${d.detail}`);
      if (fix) {
        for (const dir of docsDirs) {
          const src = join(PKG_ROOT, dir);
          const dest = join(CLAUDE_DIR, dir);
          if (existsSync(src)) {
            mkdirSync(dest, { recursive: true });
            for (const f of readdirSync(src).filter(f => f.endsWith(".md"))) {
              copyFileSync(join(src, f), join(dest, f));
            }
          }
        }
        ok("레퍼런스 동기화 완료");
      } else {
        issues += missingDocs.length;
      }
    }
  }

  // ── MCP 중앙 레지스트리 ──
  section("MCP Registry");
  {
    const registryState = inspectRegistry();
    if (!registryState.exists) {
      addDoctorCheck(report, {
        name: "mcp-registry",
        status: "missing",
        path: registryState.path,
        fix: "config/mcp-registry.json을 복원하거나 `tfx mcp add <name> --url <url>`를 실행하세요.",
      });
      warn("mcp-registry.json 없음");
      info(`path: ${registryState.path}`);
      issues++;
    } else if (!registryState.valid) {
      addDoctorCheck(report, {
        name: "mcp-registry",
        status: "invalid",
        path: registryState.path,
        errors: registryState.errors,
        fix: "config/mcp-registry.json 구조를 수정하세요.",
      });
      fail("mcp-registry.json invalid");
      for (const entry of registryState.errors) info(entry);
      issues++;
    } else {
      const statusInfo = inspectRegistryStatus(registryState.registry);
      const invalidConfigs = statusInfo.configs.filter((config) => config.parseError);
      const mismatchRows = statusInfo.rows.filter((row) => row.type === "registry" && row.status === "mismatch");
      const missingRows = statusInfo.rows.filter((row) => row.type === "registry" && row.status === "missing");
      const missingFileRows = statusInfo.rows.filter((row) => row.type === "registry" && row.status === "missing-file");
      const stdioRows = statusInfo.rows.filter((row) => row.type === "stdio");
      const hasHardIssues = invalidConfigs.length > 0 || mismatchRows.length > 0;
      const status = hasHardIssues
        ? "issues"
        : stdioRows.length > 0
          ? "warning"
          : "ok";

      addDoctorCheck(report, {
        name: "mcp-registry",
        status,
        path: registryState.path,
        server_count: Object.keys(registryState.registry.servers || {}).length,
        rows: statusInfo.rows,
        invalid_configs: invalidConfigs.map((config) => ({
          file: config.filePath,
          error: config.parseError?.message || "parse error",
        })),
        ...(stdioRows.length > 0 ? { fix: "tfx doctor --fix 또는 tfx mcp sync" } : {}),
      });

      ok(`registry 정상 (${Object.keys(registryState.registry.servers || {}).length}개 server)`);

      if (statusInfo.rows.length > 0) {
        renderTable(
          ["server", "target", "status", "config", "detail"],
          buildMcpStatusRows(statusInfo),
        );
      } else {
        info("등록된 MCP server 없음");
      }

      for (const config of invalidConfigs) {
        fail(`${config.label}: 설정 파싱 실패`);
        info(`${formatPathForDisplay(config.filePath)} — ${config.parseError.message}`);
      }

      for (const row of mismatchRows) {
        warn(`${row.label}: ${row.name} URL 불일치`);
        info(`expected ${row.expectedUrl}`);
        if (row.actualUrl) info(`actual   ${row.actualUrl}`);
      }

      for (const row of missingFileRows) {
        info(`${row.label}: ${row.name} 미배치 (${formatPathForDisplay(row.filePath)})`);
      }

      for (const row of missingRows) {
        info(`${row.label}: ${row.name} 누락`);
      }

      if (stdioRows.length === 0) {
        ok("미등록 stdio MCP 없음");
      } else {
        warn(`${stdioRows.length}개 미등록 stdio MCP 감지`);
        for (const row of stdioRows) {
          info(`${row.label}: ${row.name}${row.command ? ` (${row.command})` : ""}`);
        }
      }

      issues += invalidConfigs.length;
      issues += mismatchRows.length;
      issues += stdioRows.length;
    }
  }

  // ── Route Script 정합성 ──
  section("Route Script Sync");
  {
    const srcRoute = join(PKG_ROOT, "scripts", "tfx-route.sh");
    const destRoute = join(CLAUDE_DIR, "scripts", "tfx-route.sh");
    if (existsSync(srcRoute) && existsSync(destRoute)) {
      const srcHash = readFileSync(srcRoute, "utf8").length;
      const destHash = readFileSync(destRoute, "utf8").length;
      const srcContent = readFileSync(srcRoute, "utf8");
      const destContent = readFileSync(destRoute, "utf8");
      if (srcContent === destContent) {
        addDoctorCheck(report, { name: "route-sync", status: "ok" });
        ok("프로젝트 소스와 설치본 일치");
      } else {
        addDoctorCheck(report, { name: "route-sync", status: "issues", fix: "tfx setup" });
        warn("tfx-route.sh 프로젝트 소스와 설치본 불일치");
        info(`소스: ${srcRoute} (${srcHash}B) / 설치: ${destRoute} (${destHash}B)`);
        if (fix) {
          copyFileSync(srcRoute, destRoute);
          ok("tfx-route.sh 동기화 완료");
        } else {
          issues++;
        }
      }
    } else if (existsSync(srcRoute) && !existsSync(destRoute)) {
      addDoctorCheck(report, { name: "route-sync", status: "missing", fix: "tfx setup" });
      fail("설치본 없음");
      issues++;
    } else {
      addDoctorCheck(report, { name: "route-sync", status: "ok" });
      ok("소스 없음 (npm 패키지 모드)");
    }
  }

  // ── Hook Coverage (hook-registry vs settings.json) ──
  section("Hook Coverage");
  {
    const registryPath = join(PKG_ROOT, "hooks", "hook-registry.json");
    const settingsPath = join(CLAUDE_DIR, "settings.json");
    const managedHooks = getManagedRegistryHooks(registryPath);

    if (managedHooks.length === 0) {
      addDoctorCheck(report, {
        name: "hook-coverage",
        status: "invalid",
        total: 0,
        registered: 0,
        missing: [],
        fix: "hook-registry.json을 확인하세요.",
      });
      warn("hook-registry.json에서 관리 대상 훅을 찾지 못했습니다.");
      issues++;
    } else {
      let settings = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        } catch (error) {
          const unreadableCoverage = {
            total: managedHooks.length,
            registered: 0,
            missing: managedHooks.map((spec) => toHookCoverageName(spec.fileName, spec.id)),
          };
          report.hook_coverage = unreadableCoverage;
          addDoctorCheck(report, {
            name: "hook-coverage",
            status: "invalid",
            total: unreadableCoverage.total,
            registered: unreadableCoverage.registered,
            missing: unreadableCoverage.missing,
            fix: "settings.json 문법을 수정하거나 tfx setup을 다시 실행하세요.",
          });
          fail(`settings.json 파싱 실패: ${error.message}`);
          issues++;
          settings = null;
        }
      }

      if (settings) {
        let coverage = computeHookCoverage(settings, managedHooks);

        if (coverage.missing.length > 0 && fix) {
          const hookFixResult = ensureHooksInSettings({ settingsPath, registryPath });
          if (hookFixResult.ok) {
            if (hookFixResult.changed) {
              ok(`누락 훅 ${hookFixResult.added.length}개 자동 등록됨`);
            } else {
              info("누락 훅 자동 등록: 변경 사항 없음");
            }
            try {
              const fixedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
              coverage = computeHookCoverage(fixedSettings, managedHooks);
            } catch (error) {
              warn(`자동 등록 후 settings.json 재검증 실패: ${error.message}`);
            }
          } else {
            warn(`누락 훅 자동 등록 실패: ${hookFixResult.reason || "unknown_error"}`);
          }
        }

        // 중복 훅 감지 + 자동 수정 (orchestrator와 개별 훅이 동시 등록된 경우)
        if (coverage.duplicates && coverage.duplicates.length > 0) {
          if (fix) {
            try {
              const fixedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
              let removed = 0;
              for (const [event, entries] of Object.entries(fixedSettings.hooks || {})) {
                if (!Array.isArray(entries)) continue;
                const hasOrch = entries.some((e) =>
                  Array.isArray(e?.hooks) &&
                  e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("hook-orchestrator")),
                );
                if (!hasOrch) continue;
                // orchestrator가 아닌 엔트리 제거
                const before = entries.length;
                fixedSettings.hooks[event] = entries.filter((e) =>
                  Array.isArray(e?.hooks) &&
                  e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("hook-orchestrator")),
                );
                removed += before - fixedSettings.hooks[event].length;
              }
              if (removed > 0) {
                writeFileSync(settingsPath, JSON.stringify(fixedSettings, null, 2) + "\n", "utf8");
                ok(`중복 훅 ${removed}개 엔트리 제거됨 (orchestrator가 체이닝)`);
                const rechecked = JSON.parse(readFileSync(settingsPath, "utf8"));
                coverage = computeHookCoverage(rechecked, managedHooks);
              }
            } catch (error) {
              warn(`중복 훅 자동 제거 실패: ${error.message}`);
            }
          } else {
            warn(`중복 훅 ${coverage.duplicates.length}개 감지 (이중 실행됨): ${coverage.duplicates.join(", ")}`);
            warn("tfx doctor --fix 로 자동 제거하세요.");
            issues += coverage.duplicates.length;
          }
        }

        report.hook_coverage = coverage;
        const coverageStatus = coverage.missing.length === 0 && (!coverage.duplicates || coverage.duplicates.length === 0) ? "ok" : "issues";
        addDoctorCheck(report, {
          name: "hook-coverage",
          status: coverageStatus,
          total: coverage.total,
          registered: coverage.registered,
          missing: coverage.missing,
          duplicates: coverage.duplicates || [],
          ...(coverage.missing.length > 0 ? { fix: "tfx doctor --fix 또는 tfx setup" } : {}),
          ...(coverage.duplicates?.length > 0 ? { fix: "tfx doctor --fix 로 중복 훅 제거" } : {}),
        });

        if (coverage.missing.length === 0 && (!coverage.duplicates || coverage.duplicates.length === 0)) {
          ok(`Hook Coverage: ${coverage.registered}/${coverage.total} registered`);
        } else if (coverage.missing.length > 0) {
          fail(`Missing hooks: ${coverage.missing.join(", ")}`);
          issues += coverage.missing.length;
        }
      }
    }
  }

  // 결과
  console.log(`\n  ${LINE}`);
  if (issues === 0) {
    console.log(`  ${GREEN_BRIGHT}${BOLD}✓ 모든 검사 통과${RESET}\n`);
  } else {
    console.log(`  ${YELLOW}${BOLD}⚠ ${issues}개 항목 확인 필요${RESET}\n`);
  }
    report.issue_count = issues;
    report.status = issues === 0 ? "ok" : "issues";
    if (json) printJson(report);
    return report;
  });
}

function cmdUpdate() {
  const isDev = isDevUpdateRequested(NORMALIZED_ARGS);
  const tagLabel = isDev ? ` ${YELLOW}--dev${RESET}` : "";
  console.log(`\n${BOLD}triflux update${RESET}${tagLabel}\n`);

  // 1. 설치 방식 감지
  const pluginsFile = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
  let installMode = "unknown";
  let pluginPath = null;

  // 플러그인 모드 감지
  if (existsSync(pluginsFile)) {
    try {
      const plugins = JSON.parse(readFileSync(pluginsFile, "utf8"));
      for (const [key, entries] of Object.entries(plugins.plugins || {})) {
        if (key.startsWith("triflux")) {
          pluginPath = entries[0]?.installPath;
          installMode = "plugin";
          break;
        }
      }
    } catch {}
  }

  // PKG_ROOT가 플러그인 캐시 내에 있으면 플러그인 모드
  if (installMode === "unknown" && PKG_ROOT.includes(join(".claude", "plugins"))) {
    installMode = "plugin";
    pluginPath = PKG_ROOT;
  }

  // npm global 감지
  if (installMode === "unknown") {
    try {
      const npmList = execSync("npm list -g triflux --depth=0", {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      if (npmList.includes("triflux")) installMode = "npm-global";
    } catch {}
  }

  // npm local 감지
  if (installMode === "unknown") {
    const localPkg = join(process.cwd(), "node_modules", "triflux");
    if (existsSync(localPkg)) installMode = "npm-local";
  }

  // git 저장소 직접 사용
  if (installMode === "unknown" && existsSync(join(PKG_ROOT, ".git"))) {
    installMode = "git-local";
  }

  info(`검색: ${installMode === "plugin" ? "플러그인" : installMode === "npm-global" ? "npm global" : installMode === "npm-local" ? "npm local" : installMode === "git-local" ? "git 로컬 저장소" : "알 수 없음"} 설치 감지`);

  // 2. 설치 방식에 따라 업데이트
  const oldVer = PKG.version;
  let updated = false;
  let stoppedHubInfo = null;

  try {
    switch (installMode) {
      case "plugin": {
        const gitDir = pluginPath || PKG_ROOT;
        const result = execSync("git pull", {
          encoding: "utf8",
          timeout: 30000,
          cwd: gitDir,
          windowsHide: true,
        }).trim();
        ok(`git pull — ${result}`);
        updated = true;
        break;
      }
      case "npm-global": {
        stoppedHubInfo = stopHubForUpdate();
        if (stoppedHubInfo?.pid) {
          info(`실행 중 hub 정지 (PID ${stoppedHubInfo.pid})`);
        }
        const npmCmd = isDev ? "npm install -g triflux@dev" : "npm install -g triflux@latest";
        let result;
        try {
          result = execSync(npmCmd, {
            encoding: "utf8",
            timeout: 90000,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }).trim().split(/\r?\n/)[0];
        } catch {
          // Windows: 자기 자신의 파일 잠금으로 첫 시도 실패 가능 → --force 재시도
          info("첫 시도 실패, --force 재시도 중...");
          result = execSync(`${npmCmd} --force`, {
            encoding: "utf8",
            timeout: 90000,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }).trim().split(/\r?\n/)[0];
        }
        ok(`${npmCmd} — ${result || "완료"}`);
        updated = true;
        break;
      }
      case "npm-local": {
        const npmLocalCmd = isDev ? "npm install triflux@dev" : "npm update triflux";
        const result = execSync(npmLocalCmd, {
          encoding: "utf8",
          timeout: 60000,
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        }).trim().split(/\r?\n/)[0];
        ok(`${isDev ? "npm install triflux@dev" : "npm update triflux"} — ${result || "완료"}`);
        updated = true;
        break;
      }
      case "git-local": {
        const result = execSync("git pull", {
          encoding: "utf8",
          timeout: 30000,
          cwd: PKG_ROOT,
          windowsHide: true,
        }).trim();
        ok(`git pull — ${result}`);
        updated = true;
        break;
      }
      default:
        fail("설치 방식을 감지할 수 없음");
        info("수동 업데이트: cd <triflux-dir> && git pull");
        return;
    }
  } catch (e) {
    if (stoppedHubInfo && startHubAfterUpdate(stoppedHubInfo)) {
      info("업데이트 실패 후 hub 재기동 시도");
    }
    const stderr = e.stderr?.toString().trim();
    fail(`업데이트 실패: ${e.message}${stderr ? `\n  ${stderr.split(/\r?\n/)[0]}` : ""}`);
    return;
  }

  // 3. setup 재실행 (파일 동기화, 프로파일, HUD, CLI 확인)
  if (updated) {
    console.log("");
    // 업데이트 후 새 버전 읽기
    let newVer = oldVer;
    try {
      const newPkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
      newVer = newPkg.version;
    } catch {}

    if (newVer !== oldVer) {
      ok(`버전: v${oldVer} → v${newVer}`);
    } else {
      ok(`버전: v${oldVer} (이미 최신)`);
    }

    // ── Post-update: 캐시 갱신 (삭제 → 재생성) ──
    console.log(`\n${CYAN}── 캐시 갱신 ──${RESET}`);
    {
      const cacheDir = join(CLAUDE_DIR, "cache");
      // stale 캐시 삭제
      for (const name of ["tfx-preflight.json", "mcp-inventory.json"]) {
        const p = join(cacheDir, name);
        if (existsSync(p)) { try { unlinkSync(p); } catch {} }
      }
      // tmpdir 상태 파일 정리
      for (const name of ["tfx-multi-state.json"]) {
        const p = join(tmpdir(), name);
        if (existsSync(p)) { try { unlinkSync(p); } catch {} }
      }

      // preflight 캐시 재생성
      const preflightScript = join(PKG_ROOT, "scripts", "preflight-cache.mjs");
      if (existsSync(preflightScript)) {
        try {
          execSync(`node "${preflightScript}"`, { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: "pipe" });
          ok("preflight 캐시 재생성 완료");
        } catch (e) {
          warn(`preflight 캐시 재생성 실패: ${e.message?.split(/\r?\n/)[0] || "unknown"}`);
        }
      }

      // MCP 인벤토리 캐시 재생성
      const mcpCheckScript = join(PKG_ROOT, "scripts", "mcp-check.mjs");
      if (existsSync(mcpCheckScript)) {
        try {
          execSync(`node "${mcpCheckScript}"`, { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: "pipe" });
          ok("MCP 인벤토리 캐시 재생성 완료");
        } catch (e) {
          warn(`MCP 인벤토리 재생성 실패: ${e.message?.split(/\r?\n/)[0] || "unknown"}`);
        }
      }
    }

    // ── Post-update: 핵심 파일 무결성 검증 ──
    console.log(`\n${CYAN}── 무결성 검증 ──${RESET}`);
    {
      const criticalFiles = [
        { path: join(PKG_ROOT, "hooks", "hook-orchestrator.mjs"), label: "hook-orchestrator" },
        { path: join(PKG_ROOT, "hooks", "hook-registry.json"), label: "hook-registry" },
        { path: join(PKG_ROOT, "hooks", "safety-guard.mjs"), label: "safety-guard" },
        { path: join(PKG_ROOT, "scripts", "keyword-detector.mjs"), label: "keyword-detector" },
        { path: join(PKG_ROOT, "scripts", "setup.mjs"), label: "setup" },
        { path: join(PKG_ROOT, "bin", "triflux.mjs"), label: "triflux CLI" },
      ];
      let missing = 0;
      for (const { path: fp, label } of criticalFiles) {
        if (!existsSync(fp)) {
          fail(`누락: ${label} (${formatPathForDisplay(fp)})`);
          missing++;
        }
      }
      if (missing > 0) {
        fail(`핵심 파일 ${missing}개 누락 — npm install -g triflux@latest 재설치 필요`);
      } else {
        ok(`핵심 파일 ${criticalFiles.length}개 확인 완료`);
      }
    }

    // ── Post-update: 설정 동기화 ──
    console.log(`\n${CYAN}── 설정 동기화 ──${RESET}`);
    cmdSetup({ fromUpdate: true, overrideVersion: newVer });

    // ── Post-update: 훅 오케스트레이터 적용 ──
    {
      const hookMgrPath = join(PKG_ROOT, "hooks", "hook-manager.mjs");
      if (existsSync(hookMgrPath)) {
        try {
          const result = execSync(`node "${hookMgrPath}" apply`, {
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
          }).trim();
          const parsed = JSON.parse(result);
          if (parsed?.status === "applied") {
            ok(`훅 오케스트레이터 적용 (${parsed.events?.length || 0}개 이벤트)`);
          }
        } catch (e) {
          warn(`훅 오케스트레이터 적용 실패: ${e.message?.split(/\r?\n/)[0] || "unknown"}`);
          warn("tfx hooks apply 로 수동 적용하세요.");
        }
      } else {
        fail("hook-manager.mjs 누락 — 훅 오케스트레이터 적용 불가");
      }
    }

    if (stoppedHubInfo) {
      if (startHubAfterUpdate(stoppedHubInfo)) ok("hub 재기동 완료");
      else warn("hub 재기동 실패 — `tfx hub start`로 수동 시작 필요");
    }
  }

  console.log(`${GREEN}${BOLD}✓ 업데이트 완료${RESET}\n`);
}

function cmdList(options = {}) {
  const { json = false } = options;
  const pluginSkills = join(PKG_ROOT, "skills");
  const installedSkills = join(CLAUDE_DIR, "skills");
  const packageSkills = [];
  const userSkills = [];
  const aliasNames = new Set(SKILL_ALIASES.map(({ alias }) => alias));
  const skillAliases = [];

  if (existsSync(pluginSkills)) {
    for (const name of readdirSync(pluginSkills).sort()) {
      const src = join(pluginSkills, name, "SKILL.md");
      if (!existsSync(src)) continue;
      const dst = join(installedSkills, name, "SKILL.md");
      packageSkills.push({ name, installed: existsSync(dst) });
    }
  }

  for (const { alias, source } of SKILL_ALIASES) {
    const dst = join(installedSkills, alias, "SKILL.md");
    skillAliases.push({ alias, source, installed: existsSync(dst) });
  }

  const pkgNames = new Set(existsSync(pluginSkills) ? readdirSync(pluginSkills) : []);
  if (existsSync(installedSkills)) {
    for (const name of readdirSync(installedSkills).sort()) {
      if (pkgNames.has(name) || aliasNames.has(name)) continue;
      const skill = join(installedSkills, name, "SKILL.md");
      if (!existsSync(skill)) continue;
      userSkills.push(name);
    }
  }

  if (json) {
    printJson({
      package_skills: packageSkills,
      skill_aliases: skillAliases,
      user_skills: userSkills,
      install_path: installedSkills,
    });
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ triflux list${RESET} ${VER}\n`);
  console.log(`  ${LINE}`);

  section("패키지 스킬");
  for (const skill of packageSkills) {
    if (skill.installed) {
      console.log(`    ${GREEN_BRIGHT}✓${RESET} ${BOLD}${skill.name}${RESET}`);
    } else {
      console.log(`    ${RED_BRIGHT}✗${RESET} ${DIM}${skill.name}${RESET} ${GRAY}(미설치)${RESET}`);
    }
  }

  section("사용자 스킬");
  for (const name of userSkills) {
    console.log(`    ${AMBER}◆${RESET} ${name}`);
  }
  if (userSkills.length === 0) console.log(`    ${GRAY}없음${RESET}`);

  if (skillAliases.length > 0) {
    section("호환 alias");
    for (const entry of skillAliases) {
      const icon = entry.installed ? `${GREEN_BRIGHT}↳${RESET}` : `${RED_BRIGHT}↳${RESET}`;
      const status = entry.installed ? "" : ` ${GRAY}(미설치)${RESET}`;
      console.log(`    ${icon} ${BOLD}${entry.alias}${RESET} ${GRAY}→ ${entry.source}${RESET}${status}`);
    }
  }

  console.log(`\n  ${LINE}`);
  console.log(`  ${GRAY}${installedSkills}${RESET}\n`);
}

function cmdVersion(options = {}) {
  const { json = false } = options;
  const routeVer = getVersion(join(CLAUDE_DIR, "scripts", "tfx-route.sh"));
  const hudVer = getVersion(join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"));
  if (json) {
    printJson({
      triflux: PKG.version,
      tfx_route: routeVer,
      hud: hudVer,
      node: process.versions.node,
    });
    return;
  }
  console.log(`\n  ${AMBER}${BOLD}⬡ triflux${RESET} ${WHITE_BRIGHT}v${PKG.version}${RESET}`);
  if (routeVer) console.log(`  ${GRAY}tfx-route${RESET}  v${routeVer}`);
  if (hudVer) console.log(`  ${GRAY}hud${RESET}        v${hudVer}`);
  console.log("");
}

function cmdSchema(args = []) {
  const bundle = loadDelegatorSchemaBundle();
  const selector = String(args[0] || "").trim();
  const toolEntry = Array.isArray(bundle["x-triflux-mcp-tools"])
    ? bundle["x-triflux-mcp-tools"].find((tool) => tool.name === selector)
    : null;

  if (!selector) {
    printJson({
      $schema: bundle.$schema,
      title: "Triflux CLI Schema Bundle",
      global_options: [
        { name: "--json", type: "boolean", description: "지원 커맨드의 출력을 JSON으로 전환" },
      ],
      commands: CLI_COMMAND_SCHEMAS,
      hub_tools: bundle,
    });
    return;
  }

  if (CLI_COMMAND_SCHEMAS[selector]) {
    printJson({
      command: selector,
      ...CLI_COMMAND_SCHEMAS[selector],
    });
    return;
  }

  if (toolEntry) {
    printJson({
      tool: toolEntry.name,
      description: toolEntry.description,
      pipeAction: toolEntry.pipeAction,
      inputSchema: bundle.$defs?.[toolEntry.inputSchemaDef] || null,
      outputSchema: bundle.$defs?.[toolEntry.outputSchemaDef] || null,
    });
    return;
  }

  throw createCliError(`알 수 없는 schema 대상: ${selector}`, {
    exitCode: EXIT_ARG_ERROR,
    reason: "argError",
    fix: "tfx schema 또는 tfx schema <command>를 실행해 사용 가능한 대상을 확인하세요.",
  });
}

function cmdMcp(args = [], options = {}) {
  const { json = false } = options;
  const sub = String(args[0] || "list").trim().toLowerCase();

  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(`
  ${AMBER}${BOLD}⬡ tfx mcp${RESET}

    ${WHITE_BRIGHT}tfx mcp list${RESET}                 ${GRAY}registry + 실제 설정 상태 테이블${RESET}
    ${WHITE_BRIGHT}tfx mcp sync${RESET}                 ${GRAY}registry 기준 전체 스캔 + 치환${RESET}
    ${WHITE_BRIGHT}tfx mcp add <name> --url <url>${RESET}    ${GRAY}registry 등록 + 대상 설정 반영${RESET}
    ${WHITE_BRIGHT}tfx mcp remove <name>${RESET}        ${GRAY}registry + 실제 설정에서 제거${RESET}
`);
    return;
  }

  switch (sub) {
    case "list": {
      const registryState = ensureValidRegistryState();
      const statusInfo = inspectRegistryStatus(registryState.registry);
      if (json) {
        printJson({
          registry_path: registryState.path,
          server_count: Object.keys(registryState.registry.servers || {}).length,
          rows: statusInfo.rows,
          configs: statusInfo.configs.map((config) => ({
            file: config.filePath,
            label: config.label,
            exists: config.exists,
            parse_error: config.parseError?.message || null,
          })),
        });
        return;
      }

      console.log(`\n  ${AMBER}${BOLD}⬡ triflux mcp${RESET} ${VER}\n`);
      console.log(`  ${LINE}`);
      section("Registry");
      info(formatPathForDisplay(registryState.path));
      ok(`${Object.keys(registryState.registry.servers || {}).length}개 server 등록됨`);
      if (statusInfo.rows.length === 0) {
        info("표시할 MCP 상태 없음");
      } else {
        renderTable(
          ["server", "target", "status", "config", "detail"],
          buildMcpStatusRows(statusInfo),
        );
      }
      console.log("");
      return;
    }

    case "sync": {
      const registryState = ensureValidRegistryState();
      const result = syncRegistryTargets({ registry: registryState.registry });
      if (json) {
        printJson({
          registry_path: registryState.path,
          actions: result.actions,
        });
        return;
      }

      console.log(`\n  ${AMBER}${BOLD}⬡ triflux mcp sync${RESET} ${VER}\n`);
      console.log(`  ${LINE}`);
      section("Actions");
      for (const action of result.actions) {
        const label = `${action.label} ${DIM}(${formatPathForDisplay(action.filePath)})${RESET}`;
        if (action.status === "updated") ok(`${label} → updated`);
        else if (action.status === "warning") warn(`${label} → warning`);
        else if (action.status === "invalid-config") fail(`${label} → invalid-config`);
        else info(`${stripAnsi(label)} → ${action.status}`);
      }
      console.log("");
      return;
    }

    case "add": {
      const name = String(args[1] || "").trim();
      const url = getOptionValue(args, "--url");
      if (!name) {
        throw createCliError("MCP server name is required", {
          exitCode: EXIT_ARG_ERROR,
          reason: "argError",
          fix: "tfx mcp add <name> --url <url>",
        });
      }
      if (!url) {
        throw createCliError("MCP server url is required", {
          exitCode: EXIT_ARG_ERROR,
          reason: "argError",
          fix: "tfx mcp add <name> --url <url>",
        });
      }

      const normalizedUrl = (() => {
        try { return new URL(url).toString(); } catch {
          throw createCliError(`Invalid MCP URL: ${url}`, {
            exitCode: EXIT_ARG_ERROR,
            reason: "argError",
            fix: "http:// 또는 https:// URL을 사용하세요.",
          });
        }
      })();

      const server = addRegistryServer(name, normalizedUrl);
      const registryState = ensureValidRegistryState();
      const syncResult = syncRegistryTargets({ registry: registryState.registry });
      if (json) {
        printJson({
          name,
          server,
          actions: syncResult.actions,
        });
        return;
      }

      console.log(`\n  ${AMBER}${BOLD}⬡ triflux mcp add${RESET} ${VER}\n`);
      console.log(`  ${LINE}`);
      ok(`${name} 등록됨`);
      info(normalizedUrl);
      const updated = syncResult.actions.filter((action) => action.status === "updated").length;
      info(`동기화 반영: ${updated}개`);
      console.log("");
      return;
    }

    case "remove": {
      const name = String(args[1] || "").trim();
      if (!name) {
        throw createCliError("MCP server name is required", {
          exitCode: EXIT_ARG_ERROR,
          reason: "argError",
          fix: "tfx mcp remove <name>",
        });
      }

      ensureValidRegistryState();
      const removed = removeRegistryServer(name);
      const cleanup = removeServerFromTargets(name, { targets: removed?.targets });
      if (json) {
        printJson({
          name,
          removed: Boolean(removed),
          server: removed,
          actions: cleanup.actions,
        });
        return;
      }

      console.log(`\n  ${AMBER}${BOLD}⬡ triflux mcp remove${RESET} ${VER}\n`);
      console.log(`  ${LINE}`);
      if (removed) ok(`${name} registry에서 제거됨`);
      else warn(`${name} registry entry 없음`);
      const changed = cleanup.actions.filter((action) => action.status === "removed").length;
      info(`설정 제거 반영: ${changed}개`);
      console.log("");
      return;
    }

    default:
      throw createCliError(`알 수 없는 mcp 서브커맨드: ${sub}`, {
        exitCode: EXIT_ARG_ERROR,
        reason: "argError",
        fix: "tfx mcp help",
      });
  }
}

function checkForUpdate() {
  const cacheFile = join(CLAUDE_DIR, "cache", "triflux-update-check.json");
  const cacheDir = dirname(cacheFile);

  // 캐시 확인 (1시간 이내면 캐시 사용)
  try {
    if (existsSync(cacheFile)) {
      const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (Date.now() - cache.timestamp < 3600000) {
        return cache.latest !== PKG.version ? cache.latest : null;
      }
    }
  } catch {}

  // npm registry 조회
  try {
    const result = execSync("npm view triflux version", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }).trim();

    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ latest: result, timestamp: Date.now() }));

    return result !== PKG.version ? result : null;
  } catch {
    return null;
  }
}

function cmdHelp() {
  const latestVer = checkForUpdate();
  const updateNotice = latestVer
    ? `\n  ${YELLOW}${BOLD}↑ v${latestVer} 사용 가능${RESET}  ${GRAY}npm update -g triflux${RESET}\n`
    : "";

  console.log(`
  ${AMBER}${BOLD}⬡ triflux${RESET} ${DIM}v${PKG.version}${RESET}
  ${GRAY}CLI-first multi-model orchestrator for Claude Code${RESET}
${updateNotice}
  ${LINE}

  ${BOLD}Commands${RESET}

    ${WHITE_BRIGHT}tfx setup${RESET}      ${GRAY}파일 동기화 + HUD 설정${RESET}
    ${DIM}  --dry-run${RESET}    ${GRAY}변경 예정 작업을 JSON으로 미리보기${RESET}
    ${WHITE_BRIGHT}tfx doctor${RESET}     ${GRAY}CLI 진단 + 이슈 확인${RESET}
    ${DIM}  --fix${RESET}        ${GRAY}진단 + 자동 수정${RESET}
    ${DIM}  --reset${RESET}      ${GRAY}캐시 전체 초기화${RESET}
    ${DIM}  --json${RESET}       ${GRAY}구조화된 진단 결과 JSON 출력${RESET}
    ${WHITE_BRIGHT}tfx mcp${RESET}        ${GRAY}MCP registry 관리 (list/sync/add/remove)${RESET}
    ${WHITE_BRIGHT}tfx update${RESET}     ${GRAY}최신 안정 버전으로 업데이트${RESET}
    ${DIM}  --dev / dev${RESET}   ${GRAY}dev 태그로 업데이트${RESET}
    ${WHITE_BRIGHT}tfx list${RESET}       ${GRAY}설치된 스킬 목록${RESET}
    ${WHITE_BRIGHT}tfx schema${RESET}     ${GRAY}CLI/Hub schema JSON 출력${RESET}
    ${WHITE_BRIGHT}tfx hub${RESET}        ${GRAY}MCP 메시지 버스 관리 (start/stop/status)${RESET}
    ${WHITE_BRIGHT}tfx tray${RESET}       ${GRAY}Windows 시스템 트레이 실행${RESET}
    ${DIM}  --detach${RESET}      ${GRAY}백그라운드 트레이 프로세스로 분리${RESET}
    ${WHITE_BRIGHT}tfx multi${RESET}       ${GRAY}멀티-CLI 팀 모드 (tmux + Hub)${RESET}
    ${WHITE_BRIGHT}tfx codex-team${RESET} ${GRAY}Codex 전용 팀 모드 (기본 lead/agents: codex)${RESET}
    ${WHITE_BRIGHT}tfx notion-read${RESET} ${GRAY}Notion 페이지 → 마크다운 (Codex/Gemini MCP)${RESET}
    ${WHITE_BRIGHT}tfx version${RESET}    ${GRAY}버전 표시${RESET}

  ${BOLD}Skills${RESET} ${GRAY}(Claude Code 슬래시 커맨드)${RESET}

    ${AMBER}/tfx-auto${RESET}       ${GRAY}자동 분류 + 병렬 실행${RESET}
    ${WHITE_BRIGHT}/tfx-auto-codex${RESET} ${GRAY}Codex 리드 + Gemini 유지 (no-Claude-native)${RESET}
    ${WHITE_BRIGHT}/tfx-codex${RESET}      ${GRAY}Codex 전용 모드${RESET}
    ${BLUE}/tfx-gemini${RESET}     ${GRAY}Gemini 전용 모드${RESET}
    ${AMBER}/tfx-setup${RESET}      ${GRAY}HUD 설정 + 진단${RESET}
    ${YELLOW}/tfx-doctor${RESET}     ${GRAY}진단 + 수리 + 캐시 초기화${RESET}

  ${LINE}
  ${GRAY}github.com/tellang/triflux${RESET}
`);
}

async function cmdCodexTeam(args = []) {
  const sub = String(args[0] || "").toLowerCase();
  const passthrough = new Set([
    "status", "attach", "stop", "kill", "send", "list", "help", "--help", "-h",
    "tasks", "task", "focus", "interrupt", "control", "debug",
  ]);

  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(`
  ${AMBER}${BOLD}⬡ tfx codex-team${RESET}

    ${WHITE_BRIGHT}tfx codex-team "작업"${RESET}         ${GRAY}Codex 리드 + 워커 2개로 팀 시작${RESET}
    ${WHITE_BRIGHT}tfx codex-team --layout 1xN "작업"${RESET}   ${GRAY}(세로 분할 컬럼)${RESET}
    ${WHITE_BRIGHT}tfx codex-team --layout Nx1 "작업"${RESET}   ${GRAY}(가로 분할 스택)${RESET}
    ${WHITE_BRIGHT}tfx codex-team status${RESET}
    ${WHITE_BRIGHT}tfx codex-team debug --lines 30${RESET}
    ${WHITE_BRIGHT}tfx codex-team send N "msg"${RESET}

  ${DIM}내부적으로 tfx multi을 호출하며, 시작 시 --lead codex --agents codex,codex를 기본 주입합니다.${RESET}
`);
    return;
  }

  const hasAgents = args.includes("--agents");
  const hasLead = args.includes("--lead");
  const hasLayout = args.includes("--layout");
  const isControl = passthrough.has(sub);
  const normalizedArgs = isControl && args.length ? [sub, ...args.slice(1)] : args;
  const inject = [];
  if (!isControl && !hasLead) inject.push("--lead", "codex");
  if (!isControl && !hasAgents) inject.push("--agents", "codex,codex");
  if (!isControl && !hasLayout) inject.push("--layout", "1xN");
  const forwarded = isControl ? normalizedArgs : [...inject, ...args];

  const prevArgv = process.argv;
  const prevProfile = process.env.TFX_TEAM_PROFILE;
  process.env.TFX_TEAM_PROFILE = "codex-team";
  const { pathToFileURL } = await import("node:url");
  const { cmdTeam } = await import(pathToFileURL(join(PKG_ROOT, "hub", "team", "cli", "index.mjs")).href);
  process.argv = [prevArgv[0], prevArgv[1], "team", ...forwarded];
  try {
    await cmdTeam();
  } finally {
    process.argv = prevArgv;
    if (typeof prevProfile === "string") process.env.TFX_TEAM_PROFILE = prevProfile;
    else delete process.env.TFX_TEAM_PROFILE;
  }
}

// ── Hub preflight 체크 (multi/auto 실행 전) ──

async function checkHubRunning() {
  // preflight 캐시 먼저 확인 — 히트 시 fetch 스킵
  try {
    const cacheFile = join(homedir(), ".claude", "cache", "tfx-preflight.json");
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (Date.now() - cached.timestamp < 3_600_000 && cached.hub?.ok) return true;
  } catch {}
  const port = Number(process.env.TFX_HUB_PORT || "27888");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return true;
  } catch {}
  console.log("");
  warn(`${AMBER}tfx-hub${RESET}가 실행되고 있지 않습니다.`);
  info(`Hub 없이 실행하면 Claude 네이티브 에이전트로 폴백되어 토큰이 소비됩니다.`);
  info(`Codex(무료) 위임을 활용하려면 먼저 Hub를 시작하세요:\n`);
  console.log(`    ${WHITE_BRIGHT}tfx hub start${RESET}\n`);
  return false;
}

// ── hub 서브커맨드 ──

const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopHubForUpdate() {
  if (!existsSync(HUB_PID_FILE)) return null;
  let info = null;
  try {
    info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
    process.kill(info.pid, 0);
  } catch {
    try { unlinkSync(HUB_PID_FILE); } catch {}
    return null;
  }

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(info.pid), "/T", "/F"], {
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 10000,
        windowsHide: true,
      });
    } else {
      process.kill(info.pid, "SIGTERM");
    }
  } catch {
    try { process.kill(info.pid, "SIGKILL"); } catch {}
  }

  // Windows에서 better-sqlite3.node 파일 핸들 해제 대기
  // taskkill 후 프로세스 종료 + 파일 핸들 해제까지 최대 5초
  const sqliteNode = join(PKG_ROOT, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  for (let i = 0; i < 10; i++) {
    sleepMs(500);
    try { process.kill(info.pid, 0); } catch { break; }
  }
  // 파일 잠금 해제 확인 (Windows EBUSY 방지)
  if (existsSync(sqliteNode)) {
    for (let i = 0; i < 6; i++) {
      try {
        const fd = openSync(sqliteNode, "r");
        closeSync(fd);
        break;
      } catch {
        sleepMs(500);
      }
    }
  }
  try { unlinkSync(HUB_PID_FILE); } catch {}
  return info;
}

function startHubAfterUpdate(info) {
  if (!info) return false;
  const serverPath = join(PKG_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) return false;
  const port = Number(info?.port) > 0 ? String(info.port) : String(process.env.TFX_HUB_PORT || "27888");

  try {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, TFX_HUB_PORT: port },
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// 설치된 CLI에 tfx-hub MCP 서버 자동 등록 (1회 설정, 이후 재실행 불필요)
function autoRegisterMcp(mcpUrl) {
  section("MCP 자동 등록");

  // Codex — codex mcp add
  if (which("codex")) {
    try {
      // 이미 등록됐는지 확인
      const list = execSync("codex mcp list 2>&1", { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      if (list.includes("tfx-hub")) {
        ok("Codex: 이미 등록됨");
      } else {
        execFileSync("codex", ["mcp", "add", "tfx-hub", "--url", mcpUrl], { timeout: 10000, stdio: "ignore", windowsHide: true });
        ok("Codex: MCP 등록 완료");
      }
    } catch {
      // mcp list/add 미지원 → 설정 파일 직접 수정
      try {
        const codexDir = join(homedir(), ".codex");
        const configFile = join(codexDir, "config.json");
        let config = {};
        if (existsSync(configFile)) config = JSON.parse(readFileSync(configFile, "utf8"));
        if (!config.mcpServers) config.mcpServers = {};
        if (!config.mcpServers["tfx-hub"]) {
          config.mcpServers["tfx-hub"] = { url: mcpUrl };
          if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });
          writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
          ok("Codex: config.json에 등록 완료");
        } else {
          ok("Codex: 이미 등록됨");
        }
      } catch (e) { warn(`Codex 등록 실패: ${e.message}`); }
    }
  } else {
    info("Codex: 미설치 (건너뜀)");
  }

  // Gemini — settings.json 직접 수정
  if (which("gemini")) {
    try {
      const geminiDir = join(homedir(), ".gemini");
      const settingsFile = join(geminiDir, "settings.json");
      let settings = {};
      if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf8"));
      if (!settings.mcpServers) settings.mcpServers = {};
      if (!settings.mcpServers["tfx-hub"]) {
        settings.mcpServers["tfx-hub"] = { url: mcpUrl };
        if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        ok("Gemini: settings.json에 등록 완료");
      } else {
        ok("Gemini: 이미 등록됨");
      }
    } catch (e) { warn(`Gemini 등록 실패: ${e.message}`); }
  } else {
    info("Gemini: 미설치 (건너뜀)");
  }

  // Claude — .claude/mcp.json에 등록 (Claude Code 공식 경로)
  try {
    const claudeDir = join(process.cwd(), ".claude");
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const mcpJsonPath = join(claudeDir, "mcp.json");
    let mcpJson = {};
    if (existsSync(mcpJsonPath)) mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
    if (!mcpJson.mcpServers["tfx-hub"]) {
      mcpJson.mcpServers["tfx-hub"] = { type: "url", url: mcpUrl };
      writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
      ok("Claude: .claude/mcp.json에 등록 완료");
    } else {
      ok("Claude: 이미 등록됨");
    }
  } catch (e) { warn(`Claude 등록 실패: ${e.message}`); }
}

async function cmdHub(args = [], options = {}) {
  const { json = false } = options;
  const sub = args[0] || "status";
  const defaultPortRaw = Number(process.env.TFX_HUB_PORT || "27888");
  const probePort = Number.isFinite(defaultPortRaw) && defaultPortRaw > 0 ? defaultPortRaw : 27888;
  const formatHostForUrl = (host) => host.includes(":") ? `[${host}]` : host;
  const probeHubStatus = async (host = "127.0.0.1", port = probePort, timeoutMs = 3000) => {
    try {
      const res = await fetch(`http://${formatHostForUrl(host)}:${port}/status`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.hub ? data : null;
    } catch {
      return null;
    }
  };
  const recoverPidFile = (statusData, defaultHost = "127.0.0.1") => {
    const pid = Number(statusData?.pid);
    const port = Number(statusData?.port) || probePort;
    if (!Number.isFinite(pid) || pid <= 0) return;
    try {
      mkdirSync(HUB_PID_DIR, { recursive: true });
      writeFileSync(HUB_PID_FILE, JSON.stringify({
        pid,
        port,
        host: defaultHost,
        url: `http://${formatHostForUrl(defaultHost)}:${port}/mcp`,
        started: Date.now(),
      }));
    } catch {}
  };
  const emitHubStatus = (payload) => {
    if (!json) return false;
    printJson(payload);
    return true;
  };

  switch (sub) {
    case "start": {
      // 이미 실행 중인지 확인
      if (existsSync(HUB_PID_FILE)) {
        try {
          const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
          process.kill(info.pid, 0); // 프로세스 존재 확인
          console.log(`\n  ${YELLOW}⚠${RESET} hub 이미 실행 중 (PID ${info.pid}, ${info.url})\n`);
          return;
        } catch {
          // PID 파일 있지만 프로세스 없음 — 정리
          try { unlinkSync(HUB_PID_FILE); } catch {}
        }
      }

      const portArg = args.indexOf("--port");
      const port = portArg !== -1 ? args[portArg + 1] : "27888";
      const serverPath = join(PKG_ROOT, "hub", "server.mjs");

      if (!existsSync(serverPath)) {
        throw createCliError("hub/server.mjs 없음 — hub 모듈이 설치되지 않음", {
          exitCode: EXIT_HUB_ERROR,
          reason: "hubError",
          fix: "hub 모듈이 포함된 triflux 설치본인지 확인한 뒤 다시 실행하세요.",
        });
      }

      const child = spawn(process.execPath, [serverPath], {
        env: { ...process.env, TFX_HUB_PORT: port },
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.unref();

      // PID 파일 확인 (최대 3초 대기, 100ms 폴링)
      let started = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (existsSync(HUB_PID_FILE)) { started = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (started) {
        const hubInfo = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        console.log(`\n  ${GREEN_BRIGHT}✓${RESET} ${BOLD}tfx-hub 시작${RESET}`);
        console.log(`    URL:  ${AMBER}${hubInfo.url}${RESET}`);
        console.log(`    PID:  ${hubInfo.pid}`);
        console.log(`    DB:   ${DIM}${getPipelineStateDbPath(PKG_ROOT)}${RESET}`);
        console.log("");
        autoRegisterMcp(hubInfo.url);
        console.log("");
      } else {
        // 직접 포그라운드 모드로 안내
        console.log(`\n  ${YELLOW}⚠${RESET} 백그라운드 시작 실패 — 포그라운드로 실행:`);
        console.log(`    ${DIM}TFX_HUB_PORT=${port} node ${serverPath}${RESET}\n`);
      }
      break;
    }

    case "stop": {
      if (!existsSync(HUB_PID_FILE)) {
        const probed = await probeHubStatus("127.0.0.1", probePort, 1500)
          || (probePort === 27888 ? null : await probeHubStatus("127.0.0.1", 27888, 1500));
        if (probed && Number.isFinite(Number(probed.pid))) {
          try {
            process.kill(Number(probed.pid), "SIGTERM");
            console.log(`\n  ${GREEN_BRIGHT}✓${RESET} hub 종료됨 (PID ${probed.pid})${DIM} (probe)${RESET}\n`);
            return;
          } catch {}
        }
        console.log(`\n  ${DIM}hub 미실행${RESET}\n`);
        return;
      }
      try {
        const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        process.kill(info.pid, "SIGTERM");
        try { unlinkSync(HUB_PID_FILE); } catch {}
        console.log(`\n  ${GREEN_BRIGHT}✓${RESET} hub 종료됨 (PID ${info.pid})\n`);
      } catch (e) {
        try { unlinkSync(HUB_PID_FILE); } catch {}
        console.log(`\n  ${DIM}hub 프로세스 없음 — PID 파일 정리됨${RESET}\n`);
      }
      break;
    }

    case "status": {
      if (!existsSync(HUB_PID_FILE)) {
        const probed = await probeHubStatus();
        if (!probed) {
          const fallback = probePort === 27888 ? null : await probeHubStatus("127.0.0.1", 27888, 1500);
          if (fallback) {
            recoverPidFile(fallback, "127.0.0.1");
            if (emitHubStatus({
              status: "online",
              source: "default-port-probe",
              url: `http://127.0.0.1:${fallback.port || 27888}/mcp`,
              pid: fallback.pid,
              state: fallback.hub?.state || null,
              sessions: fallback.sessions,
            })) return;
            console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET} ${DIM}(default port probe 성공)${RESET}`);
            console.log(`    URL:     http://127.0.0.1:${fallback.port || 27888}/mcp`);
            if (fallback.pid !== undefined) console.log(`    PID:     ${fallback.pid}`);
            if (fallback.hub?.state) console.log(`    State:   ${fallback.hub.state}`);
            if (fallback.sessions !== undefined) console.log(`    Sessions: ${fallback.sessions}`);
            console.log("");
            return;
          }
          if (emitHubStatus({ status: "offline", source: "probe", url: null, pid: null, state: null, sessions: 0 })) return;
          console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${RED}offline${RESET}\n`);
          return;
        }
        recoverPidFile(probed, "127.0.0.1");
        if (emitHubStatus({
          status: "online",
          source: "probe",
          url: `http://127.0.0.1:${probed.port || probePort}/mcp`,
          pid: probed.pid,
          state: probed.hub?.state || null,
          sessions: probed.sessions,
        })) return;
        console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET} ${DIM}(pid file 없음 / probe 성공)${RESET}`);
        console.log(`    URL:     http://127.0.0.1:${probed.port || probePort}/mcp`);
        if (probed.pid !== undefined) console.log(`    PID:     ${probed.pid}`);
        if (probed.hub?.state) console.log(`    State:   ${probed.hub.state}`);
        if (probed.sessions !== undefined) console.log(`    Sessions: ${probed.sessions}`);
        console.log("");
        return;
      }
      try {
        const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        process.kill(info.pid, 0); // 생존 확인
        const uptime = Date.now() - info.started;
        const uptimeStr = uptime < 60000 ? `${Math.round(uptime / 1000)}초`
          : uptime < 3600000 ? `${Math.round(uptime / 60000)}분`
          : `${Math.round(uptime / 3600000)}시간`;

        let data = null;
        try {
          const host = typeof info.host === "string" ? info.host : "127.0.0.1";
          const port = Number(info.port) || probePort;
          data = await probeHubStatus(host, port, 3000);
        } catch {}

        if (emitHubStatus({
          status: "online",
          source: "pid-file",
          url: info.url,
          pid: info.pid,
          uptime_ms: uptime,
          state: data?.hub?.state || null,
          sessions: data?.sessions,
        })) return;
        console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET}`);
        console.log(`    URL:     ${info.url}`);
        console.log(`    PID:     ${info.pid}`);
        console.log(`    Uptime:  ${uptimeStr}`);
        if (data?.hub) {
          console.log(`    State:   ${data.hub.state}`);
        }
        if (data?.sessions !== undefined) {
          console.log(`    Sessions: ${data.sessions}`);
        }
        console.log("");
      } catch {
        try { unlinkSync(HUB_PID_FILE); } catch {}
        const probed = await probeHubStatus();
        if (!probed) {
          if (emitHubStatus({ status: "offline", source: "stale-pid", url: null, pid: null, state: null, sessions: 0 })) break;
          console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${RED}offline${RESET} ${DIM}(stale PID 정리됨)${RESET}\n`);
          break;
        }
        recoverPidFile(probed, "127.0.0.1");
        if (emitHubStatus({
          status: "online",
          source: "stale-pid-probe",
          url: `http://127.0.0.1:${probed.port || probePort}/mcp`,
          pid: probed.pid,
          state: probed.hub?.state || null,
          sessions: probed.sessions,
        })) break;
        console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET} ${DIM}(stale PID 정리 후 probe 성공)${RESET}`);
        console.log(`    URL:     http://127.0.0.1:${probed.port || probePort}/mcp`);
        if (probed.pid !== undefined) console.log(`    PID:     ${probed.pid}`);
        if (probed.hub?.state) console.log(`    State:   ${probed.hub.state}`);
        if (probed.sessions !== undefined) console.log(`    Sessions: ${probed.sessions}`);
        console.log("");
      }
      break;
    }

    default:
      console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET}\n`);
      console.log(`    ${WHITE_BRIGHT}tfx hub start${RESET}   ${GRAY}허브 데몬 시작${RESET}`);
      console.log(`    ${DIM}  --port N${RESET}      ${GRAY}포트 지정 (기본 27888)${RESET}`);
      console.log(`    ${WHITE_BRIGHT}tfx hub stop${RESET}    ${GRAY}허브 중지${RESET}`);
      console.log(`    ${WHITE_BRIGHT}tfx hub status${RESET}  ${GRAY}상태 확인${RESET}\n`);
  }
}

// ── 메인 ──

async function main() {
  const cmd = NORMALIZED_ARGS[0] || "help";
  const cmdArgs = NORMALIZED_ARGS.slice(1);

  switch (cmd) {
    case "setup":
      cmdSetup({ dryRun: cmdArgs.includes("--dry-run") });
      return;
    case "doctor": {
      const fix = cmdArgs.includes("--fix");
      const reset = cmdArgs.includes("--reset");
      await cmdDoctor({ fix, reset, json: JSON_OUTPUT });
      return;
    }
    case "mcp":
      cmdMcp(cmdArgs, { json: JSON_OUTPUT });
      return;
    case "schema":
      cmdSchema(cmdArgs);
      return;
    case "update":
      cmdUpdate();
      return;
    case "list":
    case "ls":
      cmdList({ json: JSON_OUTPUT });
      return;
    case "hub":
      await cmdHub(cmdArgs, { json: JSON_OUTPUT && (cmdArgs[0] || "status") === "status" });
      return;
    case "tray": {
      const trayUrl = new URL("../hub/tray.mjs", import.meta.url);
      const trayPath = fileURLToPath(trayUrl);
      if (cmdArgs.includes("--attach")) {
        // --attach: 포그라운드 모드 (디버깅용)
        const { startTray } = await import(trayUrl.href);
        await startTray();
        return;
      }
      // 기본: detach 모드 (프리징 방지)
      const child = spawn(process.execPath, [trayPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      console.log(`\n  ${GREEN_BRIGHT}✓${RESET} tray 시작됨 (PID ${child.pid})\n`);
      return;
    }
    case "multi": {
      const subcommand = cmdArgs[0] || "";
      if (JSON_OUTPUT) process.env.TFX_OUTPUT_JSON = "1";
      else delete process.env.TFX_OUTPUT_JSON;
      if (subcommand !== "status") {
        await checkHubRunning();
      }
      const { pathToFileURL } = await import("node:url");
      const { cmdTeam } = await import(pathToFileURL(join(PKG_ROOT, "hub", "team", "cli", "index.mjs")).href);
      const prevArgv = process.argv;
      process.argv = [prevArgv[0], prevArgv[1], "team", ...cmdArgs];
      try {
        await cmdTeam();
      } finally {
        process.argv = prevArgv;
        delete process.env.TFX_OUTPUT_JSON;
      }
      return;
    }
    case "codex-team":
      if (JSON_OUTPUT) process.env.TFX_OUTPUT_JSON = "1";
      else delete process.env.TFX_OUTPUT_JSON;
      await checkHubRunning();
      try {
        await cmdCodexTeam(cmdArgs);
      } finally {
        delete process.env.TFX_OUTPUT_JSON;
      }
      return;
    case "notion-read":
    case "nr": {
      const scriptPath = join(PKG_ROOT, "scripts", "notion-read.mjs");
      try {
        execFileSync(process.execPath, [scriptPath, ...cmdArgs], { stdio: "inherit", timeout: 660000, windowsHide: true });
      } catch (e) {
        throw createCliError(e.message || "notion-read 실행 실패", {
          exitCode: e.status || EXIT_ERROR,
          reason: "error",
        });
      }
      return;
    }
    case "hooks": {
      const hookManagerPath = join(PKG_ROOT, "hooks", "hook-manager.mjs");
      const sub = cmdArgs[0] || "status";
      try {
        execFileSync(process.execPath, [hookManagerPath, sub, ...cmdArgs.slice(1)], {
          stdio: "inherit",
          timeout: 30000,
          windowsHide: true,
        });
      } catch (e) {
        if (e.status) process.exitCode = e.status;
      }
      return;
    }
    case "version":
    case "--version":
    case "-v":
      cmdVersion({ json: JSON_OUTPUT });
      return;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      return;
    default:
      throw createCliError(`알 수 없는 명령: ${cmd}`, {
        exitCode: EXIT_ARG_ERROR,
        reason: "argError",
        fix: "tfx --help",
      });
  }
}

try {
  await main();
} catch (error) {
  handleFatalError(error, { json: JSON_OUTPUT });
}
