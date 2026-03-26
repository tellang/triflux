#!/usr/bin/env node
// triflux CLI — setup, doctor, version
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, unlinkSync, rmSync, statSync, openSync, closeSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync, execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { setTimeout as delay } from "node:timers/promises";
import { loadDelegatorSchemaBundle } from "../hub/delegator/tool-definitions.mjs";
import { detectMultiplexer, getSessionAttachedCount, killSession, listSessions, tmuxExec } from "../hub/team/session.mjs";
import { forceCleanupTeam } from "../hub/team/nativeProxy.mjs";
import { cleanupStaleOmcTeams, inspectStaleOmcTeams } from "../hub/team/staleState.mjs";
import { getPipelineStateDbPath } from "../hub/pipeline/state.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

const REQUIRED_CODEX_PROFILES = [
  {
    name: "high",
    lines: [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "high"',
    ],
  },
  {
    name: "xhigh",
    lines: [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "xhigh"',
    ],
  },
  {
    name: "spark_fast",
    lines: [
      'model = "gpt-5.1-codex-mini"',
      'model_reasoning_effort = "low"',
    ],
  },
];

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
    usage: "tfx multi <subcommand>",
    description: "멀티-CLI 팀 모드",
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

function getVersion(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/VERSION\s*=\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch { return null; }
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasProfileSection(tomlContent, profileName) {
  const section = `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*$`;
  return new RegExp(section, "m").test(tomlContent);
}

function ensureCodexProfiles() {
  try {
    if (!existsSync(CODEX_DIR)) mkdirSync(CODEX_DIR, { recursive: true });

    const original = existsSync(CODEX_CONFIG_PATH)
      ? readFileSync(CODEX_CONFIG_PATH, "utf8")
      : "";

    let updated = original;
    let added = 0;

    for (const profile of REQUIRED_CODEX_PROFILES) {
      if (hasProfileSection(updated, profile.name)) continue;

      if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
      if (updated.trim().length > 0) updated += "\n";
      updated += `[profiles.${profile.name}]\n${profile.lines.join("\n")}\n`;
      added++;
    }

    if (added > 0) {
      writeFileSync(CODEX_CONFIG_PATH, updated, "utf8");
    }

    return { ok: true, added };
  } catch (e) {
    return { ok: false, added: 0, message: e.message };
  }
}

function previewCodexProfiles() {
  const original = existsSync(CODEX_CONFIG_PATH)
    ? readFileSync(CODEX_CONFIG_PATH, "utf8")
    : "";
  const missingProfiles = REQUIRED_CODEX_PROFILES
    .filter((profile) => !hasProfileSection(original, profile.name))
    .map((profile) => profile.name);

  return {
    path: CODEX_CONFIG_PATH,
    missingProfiles,
    change: missingProfiles.length > 0 ? (original ? "update" : "create") : "noop",
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

function getSetupSyncTargets() {
  return [
    {
      src: join(PKG_ROOT, "scripts", "tfx-route.sh"),
      dst: join(CLAUDE_DIR, "scripts", "tfx-route.sh"),
      label: "tfx-route.sh",
    },
    {
      src: join(PKG_ROOT, "hud", "hud-qos-status.mjs"),
      dst: join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"),
      label: "hud-qos-status.mjs",
    },
    {
      src: join(PKG_ROOT, "scripts", "notion-read.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "notion-read.mjs"),
      label: "notion-read.mjs",
    },
    {
      src: join(PKG_ROOT, "scripts", "tfx-route-post.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "tfx-route-post.mjs"),
      label: "tfx-route-post.mjs",
    },
    {
      src: join(PKG_ROOT, "scripts", "tfx-batch-stats.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "tfx-batch-stats.mjs"),
      label: "tfx-batch-stats.mjs",
    },
    {
      src: join(PKG_ROOT, "scripts", "lib", "mcp-filter.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "lib", "mcp-filter.mjs"),
      label: "lib/mcp-filter.mjs",
    },
    {
      src: join(PKG_ROOT, "scripts", "lib", "mcp-server-catalog.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "lib", "mcp-server-catalog.mjs"),
      label: "lib/mcp-server-catalog.mjs",
    },
    {
      src: join(PKG_ROOT, "scripts", "lib", "keyword-rules.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "lib", "keyword-rules.mjs"),
      label: "lib/keyword-rules.mjs",
    },
    {
      src: join(PKG_ROOT, "scripts", "tfx-route-worker.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "tfx-route-worker.mjs"),
      label: "tfx-route-worker.mjs",
    },
    {
      src: join(PKG_ROOT, "hub", "workers", "codex-mcp.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "codex-mcp.mjs"),
      label: "hub/workers/codex-mcp.mjs",
    },
    {
      src: join(PKG_ROOT, "hub", "workers", "delegator-mcp.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "delegator-mcp.mjs"),
      label: "hub/workers/delegator-mcp.mjs",
    },
    {
      src: join(PKG_ROOT, "hub", "workers", "interface.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "interface.mjs"),
      label: "hub/workers/interface.mjs",
    },
    {
      src: join(PKG_ROOT, "hub", "workers", "gemini-worker.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "gemini-worker.mjs"),
      label: "hub/workers/gemini-worker.mjs",
    },
    {
      src: join(PKG_ROOT, "hub", "workers", "claude-worker.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "claude-worker.mjs"),
      label: "hub/workers/claude-worker.mjs",
    },
    {
      src: join(PKG_ROOT, "hub", "workers", "factory.mjs"),
      dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "factory.mjs"),
      label: "hub/workers/factory.mjs",
    },
  ];
}

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
    path: join(PKG_ROOT, ".mcp.json"),
    url: mcpUrl,
    change: "check",
  });

  return actions;
}

function buildSetupDryRunPlan() {
  const actions = [
    ...getSetupSyncTargets().map(({ src, dst, label }) => describeSyncAction(src, dst, label)),
    ...listSkillSyncActions(),
  ];
  const codexProfiles = previewCodexProfiles();
  actions.push({
    type: "codex-profiles",
    path: codexProfiles.path,
    change: codexProfiles.change,
    profiles: codexProfiles.missingProfiles,
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
  const { dryRun = false } = options;
  if (dryRun) {
    printJson(buildSetupDryRunPlan());
    return;
  }

  console.log(`\n${BOLD}triflux setup${RESET}\n`);

  for (const target of getSetupSyncTargets()) {
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
    }
    if (skillCount > 0) {
      ok(`스킬: ${skillCount}/${skillTotal}개 업데이트됨`);
    } else {
      ok(`스킬: ${skillTotal}개 최신 상태`);
    }
  }

  const codexProfileResult = ensureCodexProfiles();
  if (!codexProfileResult.ok) {
    warn(`Codex profiles 설정 실패: ${codexProfileResult.message}`);
  } else if (codexProfileResult.added > 0) {
    ok(`Codex profiles: ${codexProfileResult.added}개 추가됨 (~/.codex/config.toml)`);
  } else {
    ok("Codex profiles: 이미 준비됨");
  }

  // hub MCP 사전 등록 (서버 미실행이어도 설정만 등록 — hub start 시 즉시 사용 가능)
  if (existsSync(join(PKG_ROOT, "hub", "server.mjs"))) {
    const defaultHubUrl = `http://127.0.0.1:${process.env.TFX_HUB_PORT || "27888"}/mcp`;
    autoRegisterMcp(defaultHubUrl);
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
  }

  console.log(`\n${DIM}설치 위치: ${CLAUDE_DIR}${RESET}\n`);
}

function addDoctorCheck(report, entry) {
  report.checks.push(entry);
}

async function cmdDoctor(options = {}) {
  const { fix = false, reset = false, json = false } = options;
  const report = {
    status: "ok",
    mode: reset ? "reset" : fix ? "fix" : "check",
    checks: [],
    actions: [],
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
    for (const target of getSetupSyncTargets()) {
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
    } else if (profileFix.added > 0) {
      ok(`Codex Profiles: ${profileFix.added}개 추가됨`);
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
          ok(`${profile.name}: 정상`);
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

  // 7. 스킬 설치 상태
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

    // 8. 플러그인 등록
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

  // 9. MCP 인벤토리
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

  // 10. CLI 이슈 트래커
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

  // 11. Team Sessions
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

  // 12. OMC stale team 상태
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

  // 13. Stale Teams (Claude teams/ + tasks/ 자동 감지)
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
                    `powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${safeToken}' } | Select-Object ProcessId | ConvertTo-Json -Compress"`,
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
                    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
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

  // 3. setup 재실행 (tfx-route.sh, HUD, 스킬 동기화)
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

    // setup 재실행
    console.log("");
    info("setup 재실행 중...");
    cmdSetup();

    if (stoppedHubInfo) {
      if (startHubAfterUpdate(stoppedHubInfo)) info("hub 재기동 완료");
      else warn("hub 재기동 실패 — `tfx hub start`로 수동 시작 필요");
    }
  }

  console.log(`${GREEN}${BOLD}업데이트 완료${RESET}\n`);
}

function cmdList(options = {}) {
  const { json = false } = options;
  const pluginSkills = join(PKG_ROOT, "skills");
  const installedSkills = join(CLAUDE_DIR, "skills");
  const packageSkills = [];
  const userSkills = [];

  if (existsSync(pluginSkills)) {
    for (const name of readdirSync(pluginSkills).sort()) {
      const src = join(pluginSkills, name, "SKILL.md");
      if (!existsSync(src)) continue;
      const dst = join(installedSkills, name, "SKILL.md");
      packageSkills.push({ name, installed: existsSync(dst) });
    }
  }

  const pkgNames = new Set(existsSync(pluginSkills) ? readdirSync(pluginSkills) : []);
  if (existsSync(installedSkills)) {
    for (const name of readdirSync(installedSkills).sort()) {
      if (pkgNames.has(name)) continue;
      const skill = join(installedSkills, name, "SKILL.md");
      if (!existsSync(skill)) continue;
      userSkills.push(name);
    }
  }

  if (json) {
    printJson({
      package_skills: packageSkills,
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

  // Claude — 프로젝트 .mcp.json에 등록 (오케스트레이터용)
  try {
    const mcpJsonPath = join(PKG_ROOT, ".mcp.json");
    let mcpJson = {};
    if (existsSync(mcpJsonPath)) mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
    if (!mcpJson.mcpServers["tfx-hub"]) {
      mcpJson.mcpServers["tfx-hub"] = { type: "url", url: mcpUrl };
      writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
      ok("Claude: .mcp.json에 등록 완료");
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
