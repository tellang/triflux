#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync, execSync, spawn } from "child_process";
// triflux CLI — setup, doctor, version
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { inspectClaudeRuntimeFlags } from "../hub/diagnostics/claude-runtime-flags.mjs";
import {
  checkNetworkAvailability,
  validateRuntimeCachePaths,
} from "../hub/lib/cache-guard.mjs";
import { getPipelineStateDbPath } from "../hub/pipeline/state.mjs";
import { getVersionHash } from "../hub/state.mjs";
import {
  detectMultiplexer,
  getSessionAttachedCount,
  killSession,
  listSessions,
  tmuxExec,
} from "../hub/team/session.mjs";
import {
  commandExists,
  inspectMacTimeoutDependency,
} from "../scripts/lib/doctor-env-checks.mjs";
import { ensureGeminiProfiles } from "../scripts/lib/gemini-profiles.mjs";
import { cleanupLegacyHooks } from "../scripts/lib/legacy-hook-cleanup.mjs";
import { cleanupLegacyMcp } from "../scripts/lib/legacy-mcp-cleanup.mjs";
import {
  addRegistryServer,
  createDefaultRegistry,
  discoverProjectMcpTargets,
  inspectRegistry,
  inspectRegistryStatus,
  removeRegistryServer,
  removeServerFromTargets,
  saveRegistry,
  syncRegistryTargets,
} from "../scripts/lib/mcp-guard-engine.mjs";
import {
  formatPsmuxInstallGuidance,
  formatPsmuxUpdateGuidance,
  probePsmuxSupport,
} from "../scripts/lib/psmux-info.mjs";
import {
  applyStatusLine,
  buildWindowsHubAutostartCommand,
  ensureCodexHubServerConfig,
  ensureCodexProfiles,
  ensureTrifluxMods,
  getVersion,
  getWindowsHubAutostartStatus,
  isLocalDevSkillDir,
  isSkillSupportedOnPlatform,
  LEGACY_CODEX_MODELS,
  listInlineProfileNames,
  persistSettings,
  REMOVED_SKILL_NAMES,
  REQUIRED_CODEX_PROFILES,
  SKILL_ALIASES,
  SYNC_MAP,
  syncSkills,
} from "../scripts/setup.mjs";
import { cleanupTmpFiles } from "../scripts/tmp-cleanup.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

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
const VER = `${DIM}v${PKG.version}${RESET}`;
const LINE = `${GRAY}${"─".repeat(48)}${RESET}`;
const STALE_TEAM_MAX_AGE_SEC = 3600;
const DEFAULT_TMUX_CLEANUP_PREFIX = "tfx-*";
const DEFAULT_TMUX_CLEANUP_AGE_MIN = 60;
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const HUB_DEFAULT_PORT = 27888;
const DOCTOR_HUB_PID_FILE = join(CLAUDE_DIR, "cache", "tfx-hub", "hub.pid");

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
    usage: "tfx setup [--dry-run] [--enable-hub-autostart] [--mods]",
    description: "파일 동기화 + HUD/MCP 설정",
    options: [
      {
        name: "--mods",
        type: "boolean",
        description: "Claude Code mods 설치 (2.1.287 이상)",
      },
      {
        name: "--dry-run",
        type: "boolean",
        description: "실제 변경 없이 예정 작업을 JSON으로 출력",
      },
      {
        name: "--enable-hub-autostart",
        type: "boolean",
        description:
          "Windows 로그인 시 tfx-hub를 보장하는 Task Scheduler 항목 등록",
      },
    ],
  },
  doctor: {
    usage:
      "tfx doctor [--fix] [--reset] [--audit] [--diagnose] [--purge-logs] [--cleanup-stale-hubs --dry-run|--apply] [--cleanup-stale-tmux --prefix tfx-* --age-min N --dry-run|--apply] [--json]",
    description: "설치 상태 진단 및 자동 복구",
    options: [
      {
        name: "--fix",
        type: "boolean",
        description: "파일/캐시 자동 복구 후 재진단",
      },
      {
        name: "--reset",
        type: "boolean",
        description: "캐시 초기화 후 재생성",
      },
      {
        name: "--audit",
        type: "boolean",
        description: "설정 보안/성능 정적 감사",
      },
      {
        name: "--diagnose",
        type: "boolean",
        description:
          "진단 번들(zip) 생성: spawn-trace + hook timing + system info",
      },
      {
        name: "--purge-logs",
        type: "boolean",
        description:
          "--fix 와 함께 사용. cli-issues.jsonl 에서 7일 초과 항목 물리 삭제 (#144)",
      },
      {
        name: "--cleanup-stale-hubs",
        type: "boolean",
        description:
          "PPID=1 hub/server.mjs 후보를 보고하고 opt-in 정리 모드를 활성화",
      },
      {
        name: "--cleanup-stale-tmux",
        type: "boolean",
        description:
          "detached tmux session 후보를 보고하고 opt-in 정리 모드를 활성화",
      },
      {
        name: "--prefix <glob>",
        type: "string",
        description: "--cleanup-stale-tmux 와 함께 사용. 기본 tfx-*",
      },
      {
        name: "--age-min <minutes>",
        type: "number",
        description: "--cleanup-stale-tmux 와 함께 사용. 기본 60",
      },
      {
        name: "--dry-run",
        type: "boolean",
        description:
          "--cleanup-stale-hubs/--cleanup-stale-tmux 와 함께 사용. 정리 후보만 표시",
      },
      {
        name: "--apply",
        type: "boolean",
        description:
          "--cleanup-stale-hubs/--cleanup-stale-tmux 와 함께 사용. stale 대상 종료",
      },
      {
        name: "--json",
        type: "boolean",
        description: "구조화된 진단 결과 JSON 출력",
      },
    ],
  },
  version: {
    usage: "tfx version [--json]",
    description: "triflux 및 동기화된 스크립트 버전 표시",
    options: [
      {
        name: "--json",
        type: "boolean",
        description: "버전 정보를 JSON으로 출력",
      },
    ],
  },
  list: {
    usage: "tfx list [--json]",
    description: "패키지 스킬과 사용자 스킬 목록 표시",
    options: [
      {
        name: "--json",
        type: "boolean",
        description: "스킬 목록을 JSON으로 출력",
      },
    ],
  },
  mcp: {
    usage: "tfx mcp <list|sync|add|remove> [--json]",
    description: "MCP registry 상태 확인 및 중앙 동기화",
    subcommands: {
      list: {
        usage: "tfx mcp list [--json]",
        options: [
          {
            name: "--json",
            type: "boolean",
            description: "registry + 실제 설정 상태를 JSON으로 출력",
          },
        ],
      },
      sync: {
        usage:
          "tfx mcp sync [--json] [--all-projects [root]] [--dry-run] [--exclude <glob>]",
        options: [
          {
            name: "--json",
            type: "boolean",
            description: "동기화 결과를 JSON으로 출력",
          },
        ],
      },
      add: {
        usage: "tfx mcp add <name> --url <url> [--json]",
        options: [
          { name: "--url", type: "string", description: "등록할 MCP URL" },
          {
            name: "--json",
            type: "boolean",
            description: "등록 결과를 JSON으로 출력",
          },
        ],
      },
      remove: {
        usage: "tfx mcp remove <name> [--json]",
        options: [
          {
            name: "--json",
            type: "boolean",
            description: "제거 결과를 JSON으로 출력",
          },
        ],
      },
    },
  },
  synapse: {
    usage: "tfx synapse status [--json] [--registry <path>]",
    description: "Synapse v1 세션 레지스트리 조회 (활성 스웜 세션 목록)",
    subcommands: {
      status: "활성 세션 테이블 표시 (host/branch/dirty/state/task)",
    },
    options: [
      {
        name: "--json",
        type: "boolean",
        description: "구조화된 JSON 출력",
      },
      {
        name: "--registry",
        type: "string",
        description: "registry 파일 경로 오버라이드",
      },
    ],
  },
  why: {
    usage: "tfx why <path> [--json]",
    description: "해당 경로의 마지막 커밋에서 X-Intent 트레일러 추출",
    options: [
      {
        name: "path",
        type: "string",
        description: "intent를 조회할 파일 경로",
      },
      {
        name: "--json",
        type: "boolean",
        description: "구조화된 JSON 출력",
      },
    ],
  },
  hub: {
    usage: "tfx hub <start|stop|status|ensure> [--port N] [--json]",
    description: "tfx-hub 프로세스 제어",
    subcommands: {
      start: { usage: "tfx hub start [--port N]" },
      stop: { usage: "tfx hub stop" },
      ensure: {
        usage: "tfx hub ensure [--port N] [--json]",
        description: "헬스체크 + 자동 시작 (idempotent)",
      },
      status: {
        usage: "tfx hub status [--json]",
        options: [
          {
            name: "--json",
            type: "boolean",
            description: "허브 상태를 JSON으로 출력",
          },
        ],
      },
    },
  },
  cto: {
    usage: "tfx cto <collect|status|hygiene> [options]",
    description: "repo-local authority layer console",
    subcommands: {
      collect: "refresh .triflux/lake/current.json from authority sources",
      status: "print the current authority summary",
      hygiene:
        "project CTO hygiene counts and actionable dry-run rows (--dry-run)",
    },
  },
  multi: {
    usage:
      "tfx multi [--dashboard-layout lite|single|split-2col|split-3col|auto] <subcommand|task>",
    description: "멀티-CLI 팀 모드",
    options: [
      {
        name: "--teammate-mode",
        type: "string",
        description: "실행 모드: auto|headless|tmux|psmux (Windows)",
      },
      {
        name: "--no-dashboard",
        type: "boolean",
        description: "headless dashboard viewer 비활성화",
      },
      {
        name: "--dashboard-layout",
        type: "string",
        description:
          "dashboard viewer 레이아웃 선택: lite|single|split-2col|split-3col|auto",
      },
    ],
    subcommands: {
      status: {
        usage: "tfx multi status [--json]",
        options: [
          {
            name: "--json",
            type: "boolean",
            description: "팀 상태를 JSON으로 출력",
          },
        ],
      },
    },
  },
  update: {
    usage: "tfx update [--dev]",
    description:
      "설치 방식(plugin/npm/git)을 감지해 triflux를 업데이트하고 setup/cache를 재동기화",
    options: [
      {
        name: "--dev / dev",
        type: "boolean",
        description: "npm 설치 모드에서 dev tag로 업데이트",
      },
      {
        name: "--help",
        type: "boolean",
        description: "업데이트를 실행하지 않고 도움말만 출력",
      },
    ],
  },
});

// ── 유틸리티 ──
// ok/warn/fail/info/section 의 console.log는 디버그 로그가 아닌 의도된 CLI 출력입니다.

function ok(msg) {
  console.log(`  ${GREEN_BRIGHT}✓${RESET} ${msg}`);
}
function warn(msg) {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
}
function fail(msg) {
  console.log(`  ${RED_BRIGHT}✗${RESET} ${msg}`);
}
function info(msg) {
  console.log(`    ${GRAY}${msg}${RESET}`);
}
function section(title) {
  console.log(`\n  ${AMBER}▸${RESET} ${BOLD}${title}${RESET}`);
}
function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}
function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function isHelpArg(arg) {
  return ["help", "--help", "-h"].includes(String(arg || "").toLowerCase());
}

function formatSubcommandHelp(name, entry) {
  if (typeof entry === "string") return `${name} — ${entry}`;
  if (entry?.usage && entry?.description) {
    return `${entry.usage} — ${entry.description}`;
  }
  if (entry?.usage) return entry.usage;
  if (entry?.description) return `${name} — ${entry.description}`;
  return String(name);
}

function printCommandHelp(command) {
  const schema = CLI_COMMAND_SCHEMAS[command];
  if (!schema) return false;
  const subcommands = schema.subcommands
    ? Object.entries(schema.subcommands)
        .map(
          ([name, entry]) =>
            `    ${WHITE_BRIGHT}${formatSubcommandHelp(name, entry)}${RESET}`,
        )
        .join("\n")
    : "";
  const options = schema.options
    ? schema.options
        .map(
          (option) =>
            `    ${DIM}${String(option.name).padEnd(22)}${RESET} ${GRAY}${option.description || ""}${RESET}`,
        )
        .join("\n")
    : "";
  const aliases = schema.aliases?.length
    ? `\n  ${BOLD}Aliases${RESET}\n    ${schema.aliases.join(", ")}\n`
    : "";
  console.log(`
  ${AMBER}${BOLD}⬡ tfx ${command}${RESET}

  ${GRAY}${schema.description || ""}${RESET}

  ${BOLD}Usage${RESET}
    ${WHITE_BRIGHT}${schema.usage}${RESET}
${aliases}${subcommands ? `\n  ${BOLD}Subcommands${RESET}\n${subcommands}\n` : ""}${options ? `\n  ${BOLD}Options${RESET}\n${options}\n` : ""}`);
  return true;
}

async function withConsoleSilenced(enabled, fn) {
  if (!enabled) return fn();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function createCliError(
  message,
  { exitCode = EXIT_ERROR, reason = "error", fix = null, cause = null } = {},
) {
  const error = new Error(message);
  error.exitCode = exitCode;
  error.reason = reason;
  error.fix = fix;
  if (cause) error.cause = cause;
  return error;
}

function parseHubPort(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPidAliveForHub(pid, killFn = process.kill) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return false;
  try {
    killFn(resolvedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isHubServerCommand(command) {
  return /(^|[\\/,\s])hub[\\/]server\.mjs(?=$|[\s"'`])/i.test(
    String(command || ""),
  );
}

function parsePortFromAddress(address) {
  const match = String(address || "").match(/:(\d+)(?:\s|$)/);
  return parseHubPort(match?.[1]);
}

export function parseDetachedHubProcessRows(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pidText, ppidText, rssText, uptime, command] = match;
    const pid = Number.parseInt(pidText, 10);
    const ppid = Number.parseInt(ppidText, 10);
    const rssKb = Number.parseInt(rssText, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (ppid !== 1) continue;
    if (!isHubServerCommand(command)) continue;
    rows.push({
      pid,
      ppid,
      rssKb: Number.isFinite(rssKb) ? rssKb : null,
      uptime,
      command: command.trim(),
    });
  }
  return rows;
}

function queryDetachedHubProcessRows({
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  if (platform === "win32") return [];
  try {
    const output = execFile("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return parseDetachedHubProcessRows(output);
  } catch {
    return [];
  }
}

function parseLsofListeningPorts(output) {
  const ports = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!/\(LISTEN\)/i.test(line)) continue;
    const match = line.match(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/i);
    const port = parseHubPort(match?.[1]) ?? parsePortFromAddress(line);
    if (port) ports.add(port);
  }
  return [...ports];
}

function queryListeningPortsForPid(
  pid,
  { platform = process.platform, execFile = execFileSync } = {},
) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return [];
  if (platform === "win32") return [];
  try {
    const output = execFile(
      "lsof",
      ["-nP", "-Pan", "-p", String(resolvedPid), "-iTCP", "-sTCP:LISTEN"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    return parseLsofListeningPorts(output);
  } catch {
    return [];
  }
}

function queryEstablishedCountForPid(
  pid,
  { platform = process.platform, execFile = execFileSync } = {},
) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return 0;
  if (platform === "win32") return 0;
  try {
    const output = execFile(
      "lsof",
      ["-nP", "-Pan", "-p", String(resolvedPid), "-iTCP", "-sTCP:ESTABLISHED"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    return Math.max(0, output.trim().split(/\r?\n/).filter(Boolean).length - 1);
  } catch {
    return 0;
  }
}

function queryPidCommand(
  pid,
  { platform = process.platform, execFile = execFileSync } = {},
) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return "";
  try {
    if (platform === "win32") return "";
    return execFile("ps", ["-p", String(resolvedPid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

function queryListeningPidByPort(
  port,
  { platform = process.platform, execFile = execFileSync } = {},
) {
  const targetPort = parseHubPort(port);
  if (!targetPort || platform === "win32") return null;
  try {
    const output = execFile(
      "lsof",
      ["-nP", "-iTCP:" + targetPort, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const pid = Number.parseInt(output.trim().split(/\r?\n/)[0] ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function fetchHubHealthForDoctor(
  host,
  port,
  { fetchImpl = fetch, timeoutMs = 1000 } = {},
) {
  try {
    const urlHost = String(host || "127.0.0.1").includes(":")
      ? `[${host}]`
      : host || "127.0.0.1";
    const response = await fetchImpl(`http://${urlHost}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, version: null };
    const body = await response.json().catch(() => null);
    return {
      ok: body?.ok === true,
      version: typeof body?.version === "string" ? body.version : null,
      raw: body,
    };
  } catch (error) {
    return { ok: false, version: null, error };
  }
}

function readHubPidInfo({
  pidFilePath = DOCTOR_HUB_PID_FILE,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  if (!exists(pidFilePath)) return null;
  try {
    return JSON.parse(readFile(pidFilePath, "utf8"));
  } catch {
    return null;
  }
}

async function resolveActiveHealthyHub({
  expectedVersion = getVersionHash(),
  pidFilePath = DOCTOR_HUB_PID_FILE,
  exists = existsSync,
  readFile = readFileSync,
  killFn = process.kill,
  platform = process.platform,
  execFile = execFileSync,
  fetchImpl = fetch,
} = {}) {
  const info = readHubPidInfo({ pidFilePath, exists, readFile });
  const pid = Number(info?.pid);
  const port = parseHubPort(info?.port);
  const host =
    typeof info?.host === "string" && info.host.trim()
      ? info.host.trim()
      : "127.0.0.1";
  if (pid && port && isPidAliveForHub(pid, killFn)) {
    const command = queryPidCommand(pid, { platform, execFile });
    const health = await fetchHubHealthForDoctor(host, port, { fetchImpl });
    if (
      isHubServerCommand(command) &&
      health.ok &&
      health.version === expectedVersion
    ) {
      return { pid, port, host, version: health.version, source: "pid-file" };
    }
  }

  const defaultPid = queryListeningPidByPort(HUB_DEFAULT_PORT, {
    platform,
    execFile,
  });
  if (!defaultPid || !isPidAliveForHub(defaultPid, killFn)) return null;
  const command = queryPidCommand(defaultPid, { platform, execFile });
  if (!isHubServerCommand(command)) return null;
  const health = await fetchHubHealthForDoctor("127.0.0.1", HUB_DEFAULT_PORT, {
    fetchImpl,
  });
  if (!health.ok || health.version !== expectedVersion) return null;
  return {
    pid: defaultPid,
    port: HUB_DEFAULT_PORT,
    host: "127.0.0.1",
    version: health.version,
    source: "default-port",
  };
}

export async function inspectDetachedHubProcesses({
  expectedVersion = getVersionHash(),
  pidFilePath = DOCTOR_HUB_PID_FILE,
  exists = existsSync,
  readFile = readFileSync,
  killFn = process.kill,
  platform = process.platform,
  execFile = execFileSync,
  fetchImpl = fetch,
} = {}) {
  const rows = queryDetachedHubProcessRows({ platform, execFile });
  const activeHealthy = await resolveActiveHealthyHub({
    expectedVersion,
    pidFilePath,
    exists,
    readFile,
    killFn,
    platform,
    execFile,
    fetchImpl,
  });

  const hubs = [];
  for (const row of rows) {
    const ports = queryListeningPortsForPid(row.pid, { platform, execFile });
    const established = queryEstablishedCountForPid(row.pid, {
      platform,
      execFile,
    });
    let version = null;
    let healthy = false;
    for (const port of ports) {
      const health = await fetchHubHealthForDoctor("127.0.0.1", port, {
        fetchImpl,
      });
      if (!health.ok) continue;
      version = health.version;
      healthy = true;
      break;
    }
    const activeByPidFile = activeHealthy?.pid === row.pid;
    const activeByConnection = established >= 1;
    const isActiveHealthy = activeByPidFile || activeByConnection;
    hubs.push({
      ...row,
      ports,
      established,
      version,
      healthy: healthy || activeByConnection,
      activeHealthy: isActiveHealthy,
      activeReason: activeByPidFile
        ? "pid-file-health"
        : activeByConnection
          ? "established-connection"
          : null,
      healthStatus: isActiveHealthy ? "healthy" : "stale",
      staleCandidate: !isActiveHealthy,
    });
  }

  return {
    expectedVersion,
    activeHealthy,
    hubs,
    staleCandidates: hubs.filter((hub) => hub.staleCandidate),
  };
}

async function waitForHubProcessExit(
  pid,
  { killFn = process.kill, graceMs = 5000, pollMs = 100 } = {},
) {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() <= deadline) {
    if (!isPidAliveForHub(pid, killFn)) return true;
    await delay(pollMs);
  }
  return !isPidAliveForHub(pid, killFn);
}

async function retireDetachedHubPid(
  pid,
  { killFn = process.kill, graceMs = 5000, pollMs = 100 } = {},
) {
  if (!isPidAliveForHub(pid, killFn)) return { ok: true, reason: "dead" };
  try {
    killFn(pid, "SIGTERM");
  } catch (error) {
    return { ok: false, reason: "sigterm_failed", error };
  }
  if (await waitForHubProcessExit(pid, { killFn, graceMs, pollMs })) {
    return { ok: true, reason: "sigterm" };
  }
  try {
    killFn(pid, "SIGKILL");
  } catch (error) {
    return { ok: false, reason: "sigkill_failed", error };
  }
  const exited = await waitForHubProcessExit(pid, {
    killFn,
    graceMs: 1000,
    pollMs,
  });
  return { ok: exited, reason: exited ? "sigkill" : "still_alive" };
}

export async function cleanupDetachedHubProcesses({
  hubs,
  activeHealthy,
  dryRun = true,
  apply = false,
  killFn = process.kill,
  graceMs = 5000,
  pollMs = 100,
} = {}) {
  const results = [];
  for (const hub of hubs || []) {
    const classification =
      activeHealthy?.pid === hub.pid ||
      hub.activeHealthy ||
      Number(hub.established) >= 1
        ? "healthy"
        : "stale";
    if (classification === "healthy") {
      results.push({
        pid: hub.pid,
        classification,
        action: "excluded-active",
        ok: true,
        hub,
      });
      continue;
    }
    if (!apply || dryRun) {
      results.push({
        pid: hub.pid,
        classification,
        action: "dry-run-skip",
        ok: true,
        hub,
      });
      continue;
    }
    const retired = await retireDetachedHubPid(hub.pid, {
      killFn,
      graceMs,
      pollMs,
    });
    results.push({
      pid: hub.pid,
      classification,
      action: retired.ok ? "retired" : "failed",
      ok: retired.ok,
      reason: retired.reason,
      hub,
    });
  }
  return {
    dryRun: !apply || dryRun,
    results,
    failed: results.filter((result) => result.ok === false).length,
    retired: results.filter((result) => result.action === "retired").length,
    skipped: results.filter((result) => result.action === "dry-run-skip")
      .length,
    excluded: results.filter((result) => result.action === "excluded-active")
      .length,
  };
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
  if (exitCode === EXIT_CLI_MISSING)
    return "필수 CLI를 설치한 뒤 `tfx doctor`로 상태를 다시 확인하세요.";
  if (exitCode === EXIT_HUB_ERROR)
    return "`tfx hub start`로 허브를 다시 시작하거나 설치 상태를 확인하세요.";
  if (exitCode === EXIT_CONFIG_ERROR)
    return "설정 파일 JSON/TOML 문법을 수정한 뒤 다시 실행하세요.";
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

function renderErrorMessage(message, fallback = "unknown error") {
  if (typeof message === "string") {
    const normalized = message.trim().toLowerCase();
    if (
      normalized.length > 0 &&
      normalized !== "undefined" &&
      normalized !== "null"
    ) {
      return message.trim();
    }
  }
  return fallback;
}

function which(cmd) {
  try {
    const result =
      process.platform === "win32"
        ? execFileSync("where", [cmd], {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
          })
        : execFileSync("which", [cmd], {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
          });
    return result.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function whichInShell(cmd, shell) {
  const escapedCmd = cmd.replace(/(["\\$`])/g, "\\$1");
  const shellArgs = {
    bash: [
      "bash",
      [
        "-lc",
        `source ~/.bashrc 2>/dev/null || true; command -v "${escapedCmd}" 2>/dev/null`,
      ],
    ],
    cmd: ["cmd", ["/c", "where", cmd]],
    zsh: [
      "zsh",
      [
        "-lc",
        `source ~/.zshrc 2>/dev/null || true; command -v "${escapedCmd}" 2>/dev/null`,
      ],
    ],
    pwsh: [
      "pwsh",
      [
        "-NoProfile",
        "-c",
        `(Get-Command '${cmd.replace(/'/g, "''")}' -EA SilentlyContinue).Source`,
      ],
    ],
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
  } catch {
    return null;
  }
}

function isDevUpdateRequested(argv = process.argv) {
  return (
    argv.includes("--dev") || argv.includes("@dev") || argv.includes("dev")
  );
}

function checkShellAvailable(shell) {
  const cmds = {
    bash: "bash --version",
    zsh: "zsh --version",
    cmd: "cmd /c echo ok",
    pwsh: "pwsh -NoProfile -c echo ok",
  };
  try {
    execSync(cmds[shell], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
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

  const normalized = value.replace(
    /^(\d{2})-(\d{2})-(\d{2})(\s+)/,
    "20$1-$2-$3$4",
  );
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

function compileSimpleGlob(pattern) {
  const source = String(pattern || DEFAULT_TMUX_CLEANUP_PREFIX)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${source}$`);
}

function parseDetachedTmuxSessionRows(output, nowSec) {
  const sessions = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const [name, attachedText, createdText] = line.split("\t");
    if (!name) continue;
    const attached = Number.parseInt(attachedText || "0", 10);
    const createdAt = parseSessionCreated(createdText);
    sessions.push({
      name,
      attached: Number.isFinite(attached) ? attached : 0,
      ageSec: createdAt == null ? null : Math.max(0, nowSec - createdAt),
    });
  }
  return sessions;
}

function parseTmuxPaneRows(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [cwd, command, pidText] = line.split("\t");
      const pid = Number.parseInt(pidText || "", 10);
      return {
        cwd: cwd || null,
        command: command || null,
        pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      };
    });
}

function queryTmuxPaneRows(sessionName, { execFile = execFileSync } = {}) {
  try {
    return parseTmuxPaneRows(
      execFile(
        "tmux",
        [
          "list-panes",
          "-t",
          sessionName,
          "-F",
          "#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}",
        ],
        {
          encoding: "utf8",
          timeout: 1000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      ),
    );
  } catch {
    return [];
  }
}

function queryProcessMemoryMb(pid, { execFile = execFileSync } = {}) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return null;
  try {
    const output = execFile("ps", ["-o", "rss=", "-p", String(resolvedPid)], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const rssKb = Number.parseInt(String(output || "").trim(), 10);
    if (!Number.isFinite(rssKb) || rssKb < 0) return null;
    return Math.round(rssKb / 1024);
  } catch {
    return null;
  }
}

function sumMemoryEstimateMb(panes, { execFile = execFileSync } = {}) {
  let total = 0;
  let seen = false;
  for (const pane of panes) {
    const memory = queryProcessMemoryMb(pane.pid, { execFile });
    if (memory == null) continue;
    total += memory;
    seen = true;
  }
  return seen ? total : null;
}

export function inspectDetachedTmuxSessions({
  prefix = DEFAULT_TMUX_CLEANUP_PREFIX,
  ageMin = DEFAULT_TMUX_CLEANUP_AGE_MIN,
  platform = process.platform,
  execFile = execFileSync,
  now = Date.now(),
} = {}) {
  if (platform === "win32") {
    return {
      available: false,
      reason: "unsupported-platform",
      prefix,
      ageMin,
      sessions: [],
      staleCandidates: [],
    };
  }

  let output = "";
  try {
    output = execFile(
      "tmux",
      [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_attached}\t#{session_created}",
      ],
      {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
  } catch (error) {
    return {
      available: false,
      reason: error?.code === "ENOENT" ? "tmux-missing" : "tmux-unavailable",
      prefix,
      ageMin,
      sessions: [],
      staleCandidates: [],
    };
  }

  const nowSec = Math.floor(now / 1000);
  const matcher = compileSimpleGlob(prefix);
  const minAgeSec = Math.max(0, Number(ageMin) || 0) * 60;
  const sessions = parseDetachedTmuxSessionRows(output, nowSec)
    .filter((session) => session.attached === 0 && matcher.test(session.name))
    .map((session) => {
      const panes = queryTmuxPaneRows(session.name, { execFile });
      const commands = [
        ...new Set(panes.map((pane) => pane.command).filter(Boolean)),
      ];
      const cwd = panes.find((pane) => pane.cwd)?.cwd || null;
      const staleCandidate =
        session.ageSec != null && session.ageSec >= minAgeSec;
      return {
        name: session.name,
        age: formatElapsedAge(session.ageSec),
        ageSec: session.ageSec,
        cwd,
        command: commands.length > 0 ? commands.join(",") : null,
        memoryEstimateMb: sumMemoryEstimateMb(panes, { execFile }),
        staleCandidate,
      };
    });

  return {
    available: true,
    reason: null,
    prefix,
    ageMin,
    sessions,
    staleCandidates: sessions.filter((session) => session.staleCandidate),
  };
}

export async function cleanupDetachedTmuxSessions({
  sessions,
  dryRun = true,
  apply = false,
  execFile = execFileSync,
} = {}) {
  const results = [];
  for (const session of sessions || []) {
    if (!session.staleCandidate) {
      results.push({
        name: session.name,
        action: "excluded-fresh",
        ok: true,
        session,
      });
      continue;
    }
    if (!apply || dryRun) {
      results.push({
        name: session.name,
        action: "dry-run-skip",
        ok: true,
        session,
      });
      continue;
    }
    try {
      execFile("tmux", ["kill-session", "-t", session.name], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      results.push({
        name: session.name,
        action: "retired",
        ok: true,
        session,
      });
    } catch (error) {
      results.push({
        name: session.name,
        action: "failed",
        ok: false,
        error,
        session,
      });
    }
  }

  return {
    dryRun: !apply || dryRun,
    results,
    failed: results.filter((result) => result.ok === false).length,
    retired: results.filter((result) => result.action === "retired").length,
    skipped: results.filter((result) => result.action === "dry-run-skip")
      .length,
    excluded: results.filter((result) => result.action === "excluded-fresh")
      .length,
  };
}

function readTeamSessionCreatedMap() {
  const createdMap = new Map();

  try {
    const output = tmuxExec(
      'list-sessions -F "#{session_name} #{session_created}"',
    );
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
    const createdInfo = createdMap.get(sessionName) || {
      createdAt: null,
      createdRaw: "",
    };
    const attachedCount = getSessionAttachedCount(sessionName);
    const ageSec =
      createdInfo.createdAt == null
        ? null
        : Math.max(0, nowSec - createdInfo.createdAt);
    const stale =
      ageSec != null && ageSec >= STALE_TEAM_MAX_AGE_SEC && attachedCount === 0;

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
  const profiles = [];

  // Codex 0.134+: 프로필은 별도 파일 ~/.codex/<name>.config.toml 로 관리한다.
  for (const profile of REQUIRED_CODEX_PROFILES) {
    const profilePath = join(CODEX_DIR, `${profile.name}.config.toml`);
    const desiredContent = `${profile.lines.join("\n")}\n`;
    const existingContent = existsSync(profilePath)
      ? readFileSync(profilePath, "utf8")
      : null;
    if (existingContent !== desiredContent) {
      profiles.push(profile.name);
    }
  }

  // 마이그레이션: config.toml 에 inline [profiles.*] 가 잔존하면 제거/이관 예정 (커스텀 포함).
  const legacyInlineCleanup = listInlineProfileNames(original).length > 0;

  const windowsSandbox =
    process.platform === "win32" && !original.includes("[windows]");

  const willChange =
    profiles.length > 0 || legacyInlineCleanup || windowsSandbox;
  return {
    path: CODEX_CONFIG_PATH,
    profiles,
    windowsSandbox,
    legacyInlineCleanup,
    change: willChange ? (original ? "update" : "create") : "noop",
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
    try {
      chmodSync(dst, 0o755);
    } catch {}
    ok(`${label}: 설치됨 ${srcVer ? `(v${srcVer})` : ""}`);
    return true;
  }

  const srcContent = readFileSync(src, "utf8");
  const dstContent = readFileSync(dst, "utf8");
  if (srcContent !== dstContent) {
    copyFileSync(src, dst);
    try {
      chmodSync(dst, 0o755);
    } catch {}
    const verInfo =
      srcVer && dstVer && srcVer !== dstVer
        ? `(v${dstVer} → v${srcVer})`
        : srcVer
          ? `(v${srcVer}, 내용 변경)`
          : "(내용 변경)";
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
  const shells =
    process.platform === "win32" ? ["bash", "cmd", "pwsh"] : ["bash", "zsh"];
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
      shellResults.push({
        shell,
        status: "missing",
        path: null,
        fix: installHint,
      });
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
      fix: "bash PATH를 정리한 뒤 `tfx doctor`를 다시 실행하세요.",
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
    if (!isSkillSupportedOnPlatform(join(skillsSrc, name))) continue;
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
    change: currentCmd.includes("hud-qos-status.mjs")
      ? "noop"
      : currentCmd
        ? "skip"
        : "create",
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
    ...SYNC_MAP.map(({ src, dst, label }) =>
      describeSyncAction(src, dst, label),
    ),
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
  const autostart = getWindowsHubAutostartStatus();
  actions.push({
    type: "hub-autostart",
    platform: process.platform,
    taskName: autostart.taskName,
    change: autostart.supported && !autostart.registered ? "available" : "noop",
    registered: autostart.registered,
    command: autostart.supported ? buildWindowsHubAutostartCommand() : null,
    enableWith: "tfx setup --enable-hub-autostart",
  });

  return {
    dry_run: true,
    actions,
  };
}

function refreshSetupCaches() {
  const cacheDir = join(CLAUDE_DIR, "cache");
  for (const name of ["tfx-preflight.json", "mcp-inventory.json"]) {
    const file = join(cacheDir, name);
    if (existsSync(file)) unlinkSync(file);
  }
  for (const [name, timeout] of [
    ["preflight-cache.mjs", 15000],
    ["mcp-check.mjs", 10000],
  ]) {
    try {
      execFileSync(process.execPath, [join(PKG_ROOT, "scripts", name)], {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      ok(`${name}: 캐시 갱신 완료`);
    } catch (error) {
      warn(
        `${name}: 캐시 갱신 실패: ${error.message?.split(/\r?\n/)[0] || "unknown"}`,
      );
    }
  }
}

export function runUpdatedSetup({
  packageRoot = PKG_ROOT,
  execFileSyncFn = execFileSync,
} = {}) {
  const cli = join(packageRoot, "bin", "triflux.mjs");
  for (const file of [cli, join(packageRoot, "scripts", "setup.mjs")]) {
    if (!existsSync(file)) throw new Error(`업데이트 핵심 파일 누락: ${file}`);
  }
  execFileSyncFn(process.execPath, [cli, "setup", "--from-update"], {
    stdio: "inherit",
    windowsHide: true,
  });
}

function reportSkillSync() {
  const result = syncSkills();
  for (const warning of result.warnings) warn(warning);
  if (!result.ok)
    throw createCliError("스킬 동기화 실패", { exitCode: EXIT_CONFIG_ERROR });
  ok(`스킬: ${result.total}개 확인, 파일 ${result.changed}개 반영`);
}

function cmdSetup(options = {}) {
  const {
    dryRun = false,
    fromUpdate = false,
    overrideVersion,
    enableHubAutostart = false,
    mods = false,
  } = options;
  if (dryRun) {
    printJson(buildSetupDryRunPlan());
    return;
  }

  const cleanup = cleanupLegacyHooks({
    settingsPath: join(CLAUDE_DIR, "settings.json"),
  });
  if (!cleanup.ok) {
    throw createCliError(`이전 hook 정리 실패: ${cleanup.error}`, {
      exitCode: EXIT_CONFIG_ERROR,
      reason: "configError",
      fix: `${join(CLAUDE_DIR, "settings.json")}의 JSON 문법과 쓰기 권한을 확인하세요.`,
    });
  }
  // 이주가 막혀도 setup 은 계속한다. 남은 항목은 경고로 알린다.
  for (const warning of cleanupLegacyMcp().warnings) warn(warning);
  if (fromUpdate) refreshSetupCaches();

  console.log(`\n${BOLD}triflux setup${RESET}\n`);

  for (const target of SYNC_MAP) {
    syncFile(target.src, target.dst, target.label);
  }
  reportSkillSync();
  ensureTrifluxMods({ install: mods, log: console.log, warn });

  // ── psmux 기본 셸 자동 수정 (cmd.exe → PowerShell) ──
  if (process.platform === "win32" && which("psmux")) {
    try {
      const shellOut = execSync("psmux show-options -g default-shell 2>NUL", {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (!/powershell|pwsh/i.test(shellOut)) {
        const pwsh = which("pwsh")
          ? "pwsh"
          : which("powershell.exe")
            ? "powershell.exe"
            : "";
        if (pwsh) {
          execSync(`psmux set-option -g default-shell "${pwsh}"`, {
            timeout: 3000,
            stdio: "pipe",
          });
          ok(`psmux 기본 셸 → ${pwsh}`);
        }
      }
    } catch {
      /* psmux 서버 미실행 — 무시 */
    }
  }

  // ── 결과 추적 ──
  const summary = [];

  const codexProfileResult = ensureCodexProfiles();
  if (!codexProfileResult.ok) {
    const reason = renderErrorMessage(codexProfileResult.message);
    warn(`Codex profiles 설정 실패: ${reason}`);
    summary.push({ item: "Codex profiles", status: "⚠️", detail: reason });
  } else if (codexProfileResult.changed > 0) {
    ok(
      `Codex profiles: ${codexProfileResult.changed}개 반영됨 (~/.codex/config.toml)`,
    );
    summary.push({
      item: "Codex profiles",
      status: "✅",
      detail: `${codexProfileResult.changed}개 반영됨`,
    });
  } else {
    ok("Codex profiles: 이미 준비됨");
    summary.push({
      item: "Codex profiles",
      status: "✅",
      detail: "이미 준비됨",
    });
  }

  // Antigravity/Gemini 호환 프로필
  const geminiResult = ensureGeminiProfiles();
  if (!geminiResult.ok) {
    const reason = renderErrorMessage(geminiResult.message);
    warn(`Antigravity/Gemini profiles 설정 실패: ${reason}`);
    summary.push({
      item: "Antigravity/Gemini profiles",
      status: "⚠️",
      detail: reason,
    });
  } else if (geminiResult.created) {
    ok(
      `Antigravity/Gemini profiles: ${geminiResult.count}개 생성됨 (~/.gemini/triflux-profiles.json)`,
    );
    summary.push({
      item: "Antigravity/Gemini profiles",
      status: "✅",
      detail: `${geminiResult.count}개 생성됨`,
    });
  } else if (geminiResult.added > 0) {
    ok(`Antigravity/Gemini profiles: ${geminiResult.added}개 추가됨`);
    summary.push({
      item: "Antigravity/Gemini profiles",
      status: "✅",
      detail: `${geminiResult.added}개 추가됨 (총 ${geminiResult.count}개)`,
    });
  } else {
    ok(`Antigravity/Gemini profiles: ${geminiResult.count}개 준비됨`);
    summary.push({
      item: "Antigravity/Gemini profiles",
      status: "✅",
      detail: `${geminiResult.count}개 준비됨`,
    });
  }

  // hub MCP 사전 등록 (서버 미실행이어도 설정만 등록 — hub start 시 즉시 사용 가능)
  if (existsSync(join(PKG_ROOT, "hub", "server.mjs"))) {
    const defaultHubUrl = `http://127.0.0.1:${process.env.TFX_HUB_PORT || "27888"}/mcp`;
    autoRegisterMcp(defaultHubUrl, { codexEnabled: false });
    summary.push({ item: "Hub MCP", status: "✅", detail: "등록됨" });
    console.log("");
  }

  if (process.platform === "win32") {
    const status = getWindowsHubAutostartStatus();
    if (enableHubAutostart) {
      try {
        const script = join(PKG_ROOT, "scripts", "setup.mjs");
        execFileSync(
          process.execPath,
          [script, "--enable-hub-autostart", "--sync"],
          {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10000,
            windowsHide: true,
          },
        );
        // subprocess silent-catch 회귀 가드: schtasks /Query 로 실제 등록 재검증.
        const verified = getWindowsHubAutostartStatus();
        if (verified.registered) {
          ok(`Hub autostart: ${verified.taskName} 등록됨`);
          summary.push({
            item: "Hub autostart",
            status: "✅",
            detail: `${verified.taskName} 등록됨`,
          });
        } else {
          warn(
            "Hub autostart 등록 실패: subprocess 성공했으나 /Query 에서 미발견",
          );
          summary.push({
            item: "Hub autostart",
            status: "⚠️",
            detail: "등록 실패 (subprocess silent catch 의심)",
          });
        }
      } catch (error) {
        warn(`Hub autostart 등록 실패: ${renderErrorMessage(error.message)}`);
        summary.push({
          item: "Hub autostart",
          status: "⚠️",
          detail: "등록 실패",
        });
      }
    } else if (status.registered) {
      ok(`Hub autostart: ${status.taskName} 이미 등록됨`);
      summary.push({
        item: "Hub autostart",
        status: "✅",
        detail: "이미 등록됨",
      });
    } else {
      warn(
        "Hub autostart 미등록 — Codex 단독 시작 전 hub가 죽어 있으면 MCP가 실패할 수 있음",
      );
      info("등록: tfx setup --enable-hub-autostart");
      summary.push({
        item: "Hub autostart",
        status: "⏭️",
        detail: "미등록",
      });
    }
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

      const changed = applyStatusLine(settings, { hudPath, warn });
      if (changed) persistSettings(settings, settingsPath);
      const detail = changed ? "설정 완료" : "기존 설정 유지";
      ok(`statusLine: ${detail}`);
      summary.push({ item: "HUD statusLine", status: "✅", detail });
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
    summary.push({
      item: "HUD statusLine",
      status: "⚠️",
      detail: "HUD 파일 없음",
    });
  }

  // CLI 존재 확인
  const cliChecks = [
    { name: "codex", install: "npm i -g @openai/codex" },
    {
      name: "agy",
      label: "Antigravity",
      install: "Install Google Antigravity and ensure `agy` is on PATH",
    },
  ];
  for (const { name, label, install } of cliChecks) {
    const displayName = label || name;
    if (which(name)) {
      summary.push({
        item: `${displayName} CLI`,
        status: "✅",
        detail: "설치됨",
      });
    } else {
      summary.push({
        item: `${displayName} CLI`,
        status: "⏭️",
        detail: `미설치 (${install})`,
      });
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

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function formatPathForDisplay(filePath) {
  const value = String(filePath || "").replace(/\\/g, "/");
  const homePath = homedir().replace(/\\/g, "/");
  return value.startsWith(homePath)
    ? `~${value.slice(homePath.length)}`
    : value;
}

function renderTable(headers, rows) {
  if (!rows.length) return;
  const widths = headers.map((header, index) => {
    const cellWidths = rows.map(
      (row) => stripAnsi(String(row[index] ?? "")).length,
    );
    return Math.max(stripAnsi(header).length, ...cellWidths);
  });

  const padCell = (cell, width) => {
    const text = String(cell ?? "");
    return text + " ".repeat(Math.max(0, width - stripAnsi(text).length));
  };
  const formatRow = (row) =>
    row.map((cell, index) => padCell(cell, widths[index])).join("  ");
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
    case "skipped":
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
      if (row.status === "present")
        detail = row.actualUrl || row.actualCommand || row.expectedUrl;
      else if (row.status === "missing") detail = "registry only";
      else if (row.status === "missing-file") detail = "config missing";
      else if (row.status === "mismatch")
        detail = `expected ${row.expectedUrl || row.expectedCommand}`;
      else if (row.status === "invalid-config") detail = "parse error";
      else if (row.status === "skipped") detail = row.message || "skipped";
      else if (row.status === "stdio") detail = "configured as stdio";
      return [
        row.name,
        row.label,
        statusBadge(row.status),
        formatPathForDisplay(row.filePath),
        detail,
      ];
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
  let registryState = inspectRegistry();
  if (!registryState.exists) {
    saveRegistry(createDefaultRegistry());
    registryState = inspectRegistry();
  }
  if (!registryState.valid) {
    throw createCliError(
      `MCP registry invalid: ${registryState.errors.join("; ")}`,
      {
        exitCode: EXIT_CONFIG_ERROR,
        reason: "configError",
        fix: `${registryState.path}의 JSON 구조를 수정하세요.`,
      },
    );
  }
  return registryState;
}

async function cmdDoctor(options = {}) {
  const {
    fix = false,
    reset = false,
    purgeLogs = false,
    cleanupStaleHubs = false,
    cleanupStaleHubsDryRun = true,
    cleanupStaleHubsApply = false,
    cleanupStaleTmux = false,
    cleanupStaleTmuxDryRun = true,
    cleanupStaleTmuxApply = false,
    cleanupStaleTmuxPrefix = DEFAULT_TMUX_CLEANUP_PREFIX,
    cleanupStaleTmuxAgeMin = DEFAULT_TMUX_CLEANUP_AGE_MIN,
    json = false,
  } = options;
  const report = {
    status: "ok",
    mode: reset ? "reset" : fix ? "fix" : "check",
    checks: [],
    actions: [],
    legacy_hooks: { remaining: 0, removed: 0 },
    fsmonitorDaemons: { stale: 0, killed: 0 },
    hubServers: { detached: 0, stale: 0, activeHealthy: null },
    tmuxSessions: {
      detached: 0,
      stale: 0,
      prefix: cleanupStaleTmuxPrefix,
      ageMin: cleanupStaleTmuxAgeMin,
      sessions: [],
    },
    issue_count: 0,
  };

  return await withConsoleSilenced(json, async () => {
    const modeLabel = reset
      ? ` ${RED}--reset${RESET}`
      : fix
        ? ` ${YELLOW}--fix${RESET}`
        : "";
    console.log(
      `\n  ${AMBER}${BOLD}⬡ triflux doctor${RESET} ${VER}${modeLabel}\n`,
    );
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
            report.actions.push({
              type: "delete",
              path: fp,
              status: "failed",
              message: e.message,
            });
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
          execFileSync(process.execPath, [mcpCheck], {
            timeout: 15000,
            stdio: "ignore",
            windowsHide: true,
          });
          report.actions.push({
            type: "rebuild",
            name: "mcp-inventory",
            status: "ok",
          });
          ok("MCP 인벤토리 재생성됨");
        } catch {
          report.actions.push({
            type: "rebuild",
            name: "mcp-inventory",
            status: "failed",
          });
          warn("MCP 인벤토리 재생성 실패 — 다음 세션에서 자동 재시도");
        }
      }
      const hudScript = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
      if (existsSync(hudScript)) {
        try {
          execFileSync(
            process.execPath,
            [hudScript, "--refresh-claude-usage"],
            { timeout: 20000, stdio: "ignore", windowsHide: true },
          );
          report.actions.push({
            type: "rebuild",
            name: "claude-usage-cache",
            status: "ok",
          });
          ok("Claude 사용량 캐시 재생성됨");
        } catch {
          report.actions.push({
            type: "rebuild",
            name: "claude-usage-cache",
            status: "failed",
          });
          warn("Claude 사용량 캐시 재생성 실패 — 다음 API 호출 시 자동 생성");
        }
        try {
          execFileSync(
            process.execPath,
            [hudScript, "--refresh-codex-rate-limits"],
            { timeout: 15000, stdio: "ignore", windowsHide: true },
          );
          report.actions.push({
            type: "rebuild",
            name: "codex-rate-limits-cache",
            status: "ok",
          });
          ok("Codex 레이트 리밋 캐시 재생성됨");
        } catch {
          report.actions.push({
            type: "rebuild",
            name: "codex-rate-limits-cache",
            status: "failed",
          });
          warn("Codex 레이트 리밋 캐시 재생성 실패");
        }
      }
      console.log(`\n  ${LINE}`);
      console.log(
        `  ${GREEN_BRIGHT}${BOLD}✓ 캐시 초기화 + 재생성 완료${RESET}\n`,
      );
      report.status = report.actions.some(
        (action) => action.status === "failed",
      )
        ? "issues"
        : "ok";
      report.issue_count = report.actions.filter(
        (action) => action.status === "failed",
      ).length;
      if (json) printJson(report);
      return report;
    }

    // ── fix 모드: 파일 동기화 + 캐시 정리 후 진단 ──
    if (fix) {
      section("Auto Fix");
      const mcpCleanup = cleanupLegacyMcp();
      for (const warning of mcpCleanup.warnings) warn(warning);
      report.actions.push({
        type: "legacy-mcp-cleanup",
        ...mcpCleanup,
        status: mcpCleanup.ok ? "ok" : "failed",
      });
      for (const target of SYNC_MAP) {
        syncFile(target.src, target.dst, target.label);
      }
      const macTimeoutForFix = inspectMacTimeoutDependency();
      if (!macTimeoutForFix.ok) {
        if (commandExists("brew")) {
          if (process.stdin.isTTY && process.stdout.isTTY) {
            info("macOS GNU timeout 부재: coreutils 설치 가능");
            process.stdout.write(
              "      brew install coreutils 실행할까요? [y/N] ",
            );
            let answer = "";
            try {
              const buf = Buffer.alloc(128);
              const n = readSync(0, buf, 0, 128);
              answer = buf.toString("utf8", 0, n).trim().toLowerCase();
            } catch {
              answer = "";
            }
            if (answer.startsWith("y")) {
              try {
                execFileSync("brew", ["install", "coreutils"], {
                  stdio: "inherit",
                  timeout: 600000,
                  windowsHide: true,
                });
                report.actions.push({
                  type: "install",
                  name: "coreutils",
                  status: "ok",
                });
                ok("coreutils 설치 완료");
              } catch (error) {
                report.actions.push({
                  type: "install",
                  name: "coreutils",
                  status: "failed",
                  message: error.message,
                });
                warn(
                  `coreutils 설치 실패: ${renderErrorMessage(error.message)}`,
                );
              }
            } else {
              info("건너뜀: brew install coreutils");
            }
          } else {
            warn(
              "macOS GNU timeout 부재 — 비대화형 모드에서는 자동 설치하지 않습니다.",
            );
            info("수동 설치: brew install coreutils");
          }
        } else {
          warn("macOS GNU timeout 부재 — Homebrew를 찾지 못했습니다.");
          info("Homebrew 설치 후: brew install coreutils");
        }
      }
      reportSkillSync();
      const profileFix = ensureCodexProfiles();
      if (!profileFix.ok) {
        warn(
          `Codex Profiles 자동 복구 실패: ${renderErrorMessage(profileFix.message)}`,
        );
      } else if (profileFix.changed > 0) {
        ok(`Codex Profiles: ${profileFix.changed}개 반영됨`);
      } else {
        info("Codex Profiles: 이미 최신 상태");
      }
      // 에러/스테일 캐시 정리
      const fCacheDir = join(CLAUDE_DIR, "cache");
      const staleNames = [
        "claude-usage-cache.json",
        ".claude-refresh-lock",
        "codex-rate-limits-cache.json",
      ];
      let cleaned = 0;
      for (const name of staleNames) {
        const fp = join(fCacheDir, name);
        if (!existsSync(fp)) continue;
        try {
          const parsed = JSON.parse(readFileSync(fp, "utf8"));
          if (parsed.error || name.startsWith(".")) {
            unlinkSync(fp);
            cleaned++;
            ok(`에러 캐시 정리: ${name}`);
          }
        } catch {
          try {
            unlinkSync(fp);
            cleaned++;
            ok(`손상된 캐시 정리: ${name}`);
          } catch {}
        }
      }
      if (cleaned === 0) info("에러 캐시 없음");
      const registryStateForFix = inspectRegistry();
      if (registryStateForFix.valid) {
        try {
          const mcpSync = syncRegistryTargets({
            registry: registryStateForFix.registry,
          });
          const updatedCount = mcpSync.actions.filter(
            (action) => action.status === "updated",
          ).length;
          const invalidCount = mcpSync.actions.filter(
            (action) => action.status === "invalid-config",
          ).length;
          report.actions.push({
            type: "mcp-sync",
            status: invalidCount > 0 ? "issues" : "ok",
            actions: mcpSync.actions,
          });
          if (updatedCount > 0)
            ok(`MCP registry 동기화: ${updatedCount}개 설정 반영됨`);
          else info("MCP registry: 이미 최신 상태");
          if (invalidCount > 0)
            warn(`MCP registry 동기화 건너뜀: parse error ${invalidCount}개`);
        } catch (error) {
          report.actions.push({
            type: "mcp-sync",
            status: "failed",
            message: error.message,
          });
          warn(`MCP registry 자동 동기화 실패: ${error.message}`);
        }
      } else if (registryStateForFix.exists) {
        saveRegistry(createDefaultRegistry());
        report.actions.push({ type: "mcp-registry-reset", status: "ok" });
        ok("MCP registry 손상 → 기본값으로 재생성됨");
      } else {
        saveRegistry(createDefaultRegistry());
        report.actions.push({ type: "mcp-registry-create", status: "ok" });
        ok("MCP registry 없음 → 기본값으로 자동 생성됨");
      }
      console.log(`\n  ${LINE}`);
      info("수정 완료 — 아래 진단 결과를 확인하세요");
      console.log("");
    }

    // fix 단계에서 실패한 작업도 확인 필요 항목으로 센다.
    let issues = report.actions.filter(
      (action) => action.status === "failed",
    ).length;

    // tfx-route.sh
    section("tfx-route.sh");
    const routeSh = join(CLAUDE_DIR, "scripts", "tfx-route.sh");
    if (existsSync(routeSh)) {
      const ver = getVersion(routeSh);
      addDoctorCheck(report, {
        name: "tfx-route.sh",
        status: "ok",
        path: routeSh,
        version: ver,
      });
      ok(`설치됨 ${ver ? `${DIM}v${ver}${RESET}` : ""}`);
    } else {
      addDoctorCheck(report, {
        name: "tfx-route.sh",
        status: "missing",
        path: routeSh,
        fix: "tfx setup",
      });
      fail("미설치 — tfx setup 실행 필요");
      issues++;
    }

    // macOS GNU timeout/coreutils
    section("macOS timeout");
    const macTimeout = inspectMacTimeoutDependency();
    if (macTimeout.status === "skipped") {
      addDoctorCheck(report, {
        name: "macos-timeout",
        status: "skipped",
        platform: process.platform,
      });
      info("macOS 아님 — 건너뜀");
    } else if (macTimeout.ok) {
      addDoctorCheck(report, {
        name: "macos-timeout",
        status: "ok",
        provider: macTimeout.provider,
      });
      ok(`timeout provider: ${macTimeout.provider}`);
    } else {
      addDoctorCheck(report, {
        name: "macos-timeout",
        status: "missing",
        fix: macTimeout.fix,
      });
      warn("GNU timeout/gtimeout 미설치");
      info("수정: brew install coreutils");
      issues++;
    }

    // HUD
    section("HUD");
    const hud = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
    if (existsSync(hud)) {
      addDoctorCheck(report, {
        name: "hud-qos-status.mjs",
        status: "ok",
        path: hud,
      });
      ok("설치됨");
    } else {
      addDoctorCheck(report, {
        name: "hud-qos-status.mjs",
        status: "missing",
        path: hud,
        optional: true,
        fix: "tfx setup",
      });
      warn(`미설치 ${GRAY}(선택사항)${RESET}`);
    }

    // Codex CLI
    section(`Codex CLI ${WHITE_BRIGHT}●${RESET}`);
    const codexCli = checkCliCrossShell(
      "codex",
      "npm install -g @openai/codex",
    );
    issues += codexCli.issues;
    addDoctorCheck(report, {
      name: "codex",
      status: codexCli.status,
      shells: codexCli.shells,
      ...(codexCli.fix ? { fix: codexCli.fix } : {}),
    });
    // API 키 검사 제거 — bash exec 기반이므로 API 키 불필요

    // Codex Profiles (0.134+: 별도 파일 ~/.codex/<name>.config.toml)
    section("Codex Profiles");
    {
      const codexConfig = existsSync(CODEX_CONFIG_PATH)
        ? readFileSync(CODEX_CONFIG_PATH, "utf8")
        : "";
      const missingProfiles = [];
      for (const profile of REQUIRED_CODEX_PROFILES) {
        const profilePath = join(CODEX_DIR, `${profile.name}.config.toml`);
        if (existsSync(profilePath)) {
          ok(
            `${profile.name}: 정상${profile.proOnly ? ` ${DIM}(Pro 전용)${RESET}` : ""}`,
          );
        } else if (profile.proOnly) {
          info(
            `${profile.name}: 미설정 ${DIM}(Pro 전용 — Plus/기본에서는 불필요)${RESET}`,
          );
        } else {
          missingProfiles.push(profile.name);
          warn(
            `${profile.name}: 미설정 ${DIM}(~/.codex/${profile.name}.config.toml)${RESET}`,
          );
          issues++;
        }
      }
      // 0.134: config.toml 에 잔존하는 inline [profiles.*] 는 codex 가 거부한다 (커스텀 포함).
      const leftoverInline = listInlineProfileNames(codexConfig);
      if (leftoverInline.length > 0) {
        warn(
          `config.toml legacy inline [profiles.*] 잔존: ${leftoverInline.join(", ")} ${DIM}(codex 0.134+ 거부 — 'tfx setup' 로 정리)${RESET}`,
        );
        issues++;
      }
      const profilesOk =
        missingProfiles.length === 0 && leftoverInline.length === 0;
      addDoctorCheck(report, {
        name: "codex-profiles",
        status: profilesOk ? "ok" : "missing",
        path: CODEX_DIR,
        missing_profiles: missingProfiles,
        ...(leftoverInline.length > 0 ? { legacy_inline: leftoverInline } : {}),
        ...(profilesOk ? {} : { fix: "tfx setup" }),
      });
    }

    // Codex 구형 모델 감지
    if (existsSync(CODEX_CONFIG_PATH)) {
      const codexContent = readFileSync(CODEX_CONFIG_PATH, "utf8");
      const legacyFound = LEGACY_CODEX_MODELS.filter((m) =>
        codexContent.includes(`"${m}"`),
      );
      if (legacyFound.length > 0) {
        warn(`구형 모델 감지: ${legacyFound.join(", ")}`);
        info("최신 프로필로 마이그레이션: tfx setup 또는 tfx profile");
        addDoctorCheck(report, {
          name: "codex-legacy-models",
          status: "issues",
          models: legacyFound,
          fix: "tfx setup",
        });
        issues++;
      }
    }

    // Antigravity CLI
    section(`Antigravity CLI ${BLUE}●${RESET}`);
    const antigravityCli = checkCliCrossShell(
      "agy",
      "Install Google Antigravity and ensure `agy` is on PATH",
    );
    issues += antigravityCli.issues;
    addDoctorCheck(report, {
      name: "antigravity",
      status: antigravityCli.status,
      shells: antigravityCli.shells,
      ...(antigravityCli.fix ? { fix: antigravityCli.fix } : {}),
    });
    // API 키 검사 제거 — agy OAuth 기반이므로 API 키 불필요

    // Claude Code
    section(`Claude Code ${AMBER}●${RESET}`);
    const claudePath = which("claude");
    if (claudePath) {
      addDoctorCheck(report, {
        name: "claude",
        status: "ok",
        path: claudePath,
      });
      ok("설치됨");
    } else {
      addDoctorCheck(report, {
        name: "claude",
        status: "missing",
        fix: "Claude Code를 설치한 뒤 `tfx doctor`를 다시 실행하세요.",
      });
      fail("미설치 (필수)");
      issues++;
    }

    const claudeSettings = readJsonIfExists(join(CLAUDE_DIR, "settings.json"));
    const runtimeFlags = inspectClaudeRuntimeFlags({
      env: process.env,
      settings: claudeSettings,
    });
    addDoctorCheck(report, {
      name: "claude-runtime-flags",
      status: runtimeFlags.status,
      safe_mode: runtimeFlags.safeMode,
      disable_bundled_skills: runtimeFlags.disableBundledSkills,
      managed_mcp_policy: runtimeFlags.managedMcpPolicy,
      summary: runtimeFlags.summary,
      ...(runtimeFlags.fix ? { fix: runtimeFlags.fix } : {}),
    });
    if (runtimeFlags.status === "warning") warn(runtimeFlags.summary);

    // psmux (Windows only)
    if (process.platform === "win32") {
      section("psmux (터미널 멀티플렉서)");
      const psmuxPath = which("psmux");
      if (psmuxPath) {
        ok("설치됨");
        const psmuxSupport = probePsmuxSupport({
          execFileSyncFn: execFileSync,
        });
        const supportOk = psmuxSupport.ok;
        info(`버전: ${psmuxSupport.version || "unknown"}`);
        if (!supportOk) {
          warn(`capability 부족: ${psmuxSupport.missingCommands.join(", ")}`);
          info(`업데이트 권장:\n${formatPsmuxUpdateGuidance("  ")}`);
          addDoctorCheck(report, {
            name: "psmux",
            status: "issues",
            path: psmuxPath,
            version: psmuxSupport.version || "unknown",
            missing_commands: psmuxSupport.missingCommands,
            fix: "tfx setup 또는 psmux 업그레이드",
          });
          issues++;
        } else if (!psmuxSupport.recommended) {
          warn(
            `권장 버전 미만: v${psmuxSupport.version || "unknown"} (권장: v${psmuxSupport.recommendedVersion}+)`,
          );
          info(`업데이트 권장:\n${formatPsmuxUpdateGuidance("  ")}`);
        }
        if (psmuxSupport.missingOptionalCommands?.length > 0) {
          // #144: 단순히 "detach-first hardening 경로에서만 사용" 만으로는 사용자가
          // 영향 범위와 해결 방법을 알 수 없다. 각 capability 별 영향과 업그레이드 명령을 명시.
          info(
            `선택 capability 미지원: ${psmuxSupport.missingOptionalCommands.join(", ")}`,
          );
          if (psmuxSupport.missingOptionalCommands.includes("detach-client")) {
            info(
              "  detach-client: WT 1.24 ConPTY close-race 회피용. WT 기반 병렬 실행(swarm dashboard, tfx-multi wt 모드) 에서 pane freeze/ConPTY hang 위험 증가.",
            );
            info(
              "  해결: psmux v3.4+ 로 업그레이드. 현재 psmux 업그레이드 명령:",
            );
            info(`${formatPsmuxUpdateGuidance("    ")}`);
          }
        }

        // 기본 셸 확인: psmux 세션의 기본 셸이 PowerShell인지 cmd.exe인지
        let shellOk = false;
        try {
          const defaultShell = execSync(
            "psmux show-options -g default-shell 2>NUL",
            { encoding: "utf8", timeout: 3000 },
          ).trim();
          shellOk = /powershell|pwsh/i.test(defaultShell);
        } catch {
          // show-options 실패 시 pwsh/powershell 존재 여부로 판단
          shellOk = !!which("pwsh") || !!which("powershell.exe");
        }
        if (supportOk && shellOk) {
          ok("기본 셸: PowerShell");
          addDoctorCheck(report, {
            name: "psmux",
            status: "ok",
            path: psmuxPath,
            shell: "powershell",
          });
        } else {
          if (fix) {
            // --fix: PowerShell로 자동 변경
            const pwshBin = which("pwsh") ? "pwsh" : "powershell.exe";
            try {
              execSync(`psmux set-option -g default-shell "${pwshBin}"`, {
                timeout: 3000,
                stdio: "pipe",
              });
              ok(`기본 셸 → ${pwshBin} 으로 변경 완료`);
              addDoctorCheck(report, {
                name: "psmux",
                status: "ok",
                path: psmuxPath,
                shell: pwshBin,
                fixed: true,
              });
              report.actions.push("psmux default-shell → " + pwshBin);
            } catch (e) {
              fail(`기본 셸 변경 실패: ${e.message}`);
              addDoctorCheck(report, {
                name: "psmux",
                status: "issues",
                path: psmuxPath,
                shell: "cmd",
                fix: `psmux set-option -g default-shell "${pwshBin}"`,
              });
              issues++;
            }
          } else {
            warn("기본 셸이 cmd.exe — headless 명령 실패 가능");
            info(
              `수정: tfx doctor --fix 또는 psmux set-option -g default-shell "powershell.exe"`,
            );
            addDoctorCheck(report, {
              name: "psmux",
              status: "issues",
              path: psmuxPath,
              shell: "cmd",
              fix: "tfx doctor --fix",
            });
            issues++;
          }
        }
      } else {
        info(`미설치 ${GRAY}(선택 — 멀티모델 병렬 실행에 필요)${RESET}`);
        info(`설치 방법:\n${formatPsmuxInstallGuidance("  ")}`);
        addDoctorCheck(report, {
          name: "psmux",
          status: "skipped",
          detail: "미설치 (선택)",
          fix: "winget install psmux",
        });
      }
    }

    // 스킬 설치 상태
    section("Skills");
    const skillsSrc = join(PKG_ROOT, "skills");
    const skillsDst = join(CLAUDE_DIR, "skills");
    if (existsSync(skillsSrc)) {
      let installed = 0;
      let total = 0;
      const missing = [];
      for (const name of readdirSync(skillsSrc)) {
        if (!existsSync(join(skillsSrc, name, "SKILL.md"))) continue;
        if (!isSkillSupportedOnPlatform(join(skillsSrc, name))) continue;
        total++;
        if (existsSync(join(skillsDst, name, "SKILL.md"))) {
          installed++;
        } else {
          missing.push(name);
        }
      }
      if (installed === total) {
        addDoctorCheck(report, {
          name: "skills",
          status: "ok",
          installed,
          total,
        });
        ok(`${installed}/${total}개 설치됨`);
      } else {
        addDoctorCheck(report, {
          name: "skills",
          status: "missing",
          installed,
          total,
          missing,
          fix: "tfx setup",
        });
        warn(`${installed}/${total}개 설치됨 — 미설치: ${missing.join(", ")}`);
        info("triflux setup으로 동기화 가능");
        issues++;
      }
    } else {
      addDoctorCheck(report, {
        name: "skills",
        status: "missing",
        installed: 0,
        total: 0,
        fix: "패키지 skills 디렉토리를 확인하세요.",
      });
    }

    // Stale 스킬 체크
    const staleSkills = [];
    const userSkillsDir = join(CLAUDE_DIR, "skills");
    if (existsSync(userSkillsDir)) {
      const pkgSkillsDir = join(PKG_ROOT, "skills");
      const pkgSkills = new Set();
      if (existsSync(pkgSkillsDir)) {
        for (const n of readdirSync(pkgSkillsDir)) {
          if (isSkillSupportedOnPlatform(join(pkgSkillsDir, n)))
            pkgSkills.add(n);
        }
      }
      for (const { alias } of SKILL_ALIASES) pkgSkills.add(alias);

      for (const n of readdirSync(userSkillsDir)) {
        if (
          !REMOVED_SKILL_NAMES.includes(n) &&
          !existsSync(join(pkgSkillsDir, n))
        )
          continue;
        if (isLocalDevSkillDir(join(userSkillsDir, n))) continue;
        if (!pkgSkills.has(n)) staleSkills.push(n);
      }
    }
    if (staleSkills.length > 0) {
      warn(`구형 스킬 ${staleSkills.length}개 감지: ${staleSkills.join(", ")}`);
      info("관리 사본 정리: tfx setup 또는 tfx update");
      addDoctorCheck(report, {
        name: "stale-skills",
        status: "issues",
        skills: staleSkills,
        fix: "tfx setup",
      });
      issues++;
    } else {
      addDoctorCheck(report, { name: "stale-skills", status: "ok" });
    }

    // 8.5 Dev 의존성 (npm link 환경에서 node_modules 누락 감지 — Issue #101)
    section("Dev Dependencies");
    try {
      const pkgJsonPath = join(PKG_ROOT, "package.json");
      const nodeModulesPath = join(PKG_ROOT, "node_modules");
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      const runtimeDeps = Object.keys(pkgJson.dependencies || {});
      const isLinkedDev = (() => {
        try {
          const stat = statSync(nodeModulesPath);
          return stat.isDirectory();
        } catch {
          return false;
        }
      })();
      const missingDeps = [];
      if (!isLinkedDev) {
        // node_modules 전체 누락 — 전역 install 또는 미압축 릴리즈일 가능성
        if (runtimeDeps.length > 0) {
          missingDeps.push(...runtimeDeps);
        }
      } else {
        for (const dep of runtimeDeps) {
          const depPath = join(nodeModulesPath, ...dep.split("/"));
          if (!existsSync(depPath)) missingDeps.push(dep);
        }
      }
      if (missingDeps.length === 0) {
        ok(
          `의존성 ${runtimeDeps.length}개 설치됨${
            isLinkedDev ? ` ${DIM}(dev)${RESET}` : ""
          }`,
        );
        addDoctorCheck(report, {
          name: "dev-deps",
          status: "ok",
          total: runtimeDeps.length,
          linkedDev: isLinkedDev,
        });
      } else {
        const head = missingDeps.slice(0, 5);
        const tail = missingDeps.length > 5 ? `+${missingDeps.length - 5}` : "";
        warn(
          `누락 의존성 ${missingDeps.length}개: ${head.join(", ")}${tail ? ` ${tail}` : ""}`,
        );
        info("수정: tfx doctor --fix 또는 `npm install` (PKG_ROOT 내)");
        addDoctorCheck(report, {
          name: "dev-deps",
          status: "missing",
          missing: missingDeps,
          linkedDev: isLinkedDev,
          pkgRoot: PKG_ROOT,
          fix: "tfx doctor --fix",
        });
        issues++;
        if (fix) {
          // --fix 모드: npm install 실행 (Windows 호환 shell: true)
          info(`npm install 실행 중 (${PKG_ROOT})...`);
          try {
            const { execFileSync } = await import("node:child_process");
            execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
              cwd: PKG_ROOT,
              stdio: "inherit",
              shell: process.platform === "win32",
            });
            ok("npm install 완료 — 의존성 복구됨");
          } catch (err) {
            warn(`npm install 실패: ${err?.message || err}`);
          }
        }
      }
    } catch (err) {
      warn(`dev 의존성 체크 실패: ${err?.message || err}`);
      addDoctorCheck(report, {
        name: "dev-deps",
        status: "error",
        error: String(err?.message || err),
      });
    }

    // MCP 인벤토리
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
          const names = inv.codex.servers.map((s) => s.name).join(", ");
          info(`Codex: ${inv.codex.servers.length}개 서버 (${names})`);
        }
        if (inv.gemini?.servers?.length) {
          const names = inv.gemini.servers.map((s) => s.name).join(", ");
          info(`Gemini: ${inv.gemini.servers.length}개 서버 (${names})`);
        }
      } catch {
        addDoctorCheck(report, {
          name: "mcp-inventory",
          status: "invalid",
          path: mcpCache,
          fix: `node ${join(PKG_ROOT, "scripts", "mcp-check.mjs")}`,
        });
        warn("캐시 파일 파싱 실패");
      }
    } else {
      addDoctorCheck(report, {
        name: "mcp-inventory",
        status: "missing",
        path: mcpCache,
        fix: `node ${join(PKG_ROOT, "scripts", "mcp-check.mjs")}`,
      });
      warn("캐시 없음 — 다음 세션 시작 시 자동 생성");
      info(`수동: node ${join(PKG_ROOT, "scripts", "mcp-check.mjs")}`);
    }

    // CLI 이슈 트래커
    section("CLI Issues");
    const issuesFile = join(CLAUDE_DIR, "cache", "cli-issues.jsonl");
    if (existsSync(issuesFile)) {
      try {
        const lines = readFileSync(issuesFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        const entries = lines
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const unresolved = entries.filter((e) => !e.resolved);

        if (unresolved.length === 0) {
          addDoctorCheck(report, {
            name: "cli-issues",
            status: "ok",
            path: issuesFile,
            unresolved: 0,
          });
          ok("미해결 이슈 없음");
        } else {
          // 패턴별 그룹핑
          const groups = {};
          for (const e of unresolved) {
            const key = `${e.cli}:${e.pattern}`;
            if (!groups[key]) groups[key] = { ...e, count: 0 };
            groups[key].count++;
            if (e.ts > groups[key].ts) {
              groups[key].ts = e.ts;
              groups[key].snippet = e.snippet;
            }
          }

          // #144: 오래된 로그 노이즈 완화 — 7일 초과 항목은 INFO 레벨로 downgrade.
          // --fix --purge-logs 플래그가 있으면 해당 오래된 항목은 실제 삭제.
          const STALE_AGE_MS = 7 * 24 * 3600 * 1000;
          let purged = 0;
          for (const g of Object.values(groups)) {
            const age = Date.now() - g.ts;
            const ago =
              age < 3600000
                ? `${Math.round(age / 60000)}분 전`
                : age < 86400000
                  ? `${Math.round(age / 3600000)}시간 전`
                  : `${Math.round(age / 86400000)}일 전`;
            const isStale = age >= STALE_AGE_MS;
            if (isStale && fix && purgeLogs) {
              purged += g.count;
              continue;
            }
            const sev = isStale
              ? `${CYAN}INFO${RESET}`
              : g.severity === "error"
                ? `${RED}ERROR${RESET}`
                : `${YELLOW}WARN${RESET}`;
            const staleTag = isStale ? " [STALE]" : "";
            if (isStale) {
              info(
                `[${sev}]${staleTag} ${g.cli}/${g.pattern} x${g.count} (최근: ${ago})`,
              );
            } else {
              warn(`[${sev}] ${g.cli}/${g.pattern} x${g.count} (최근: ${ago})`);
            }
            if (g.snippet) info(`  ${g.snippet.substring(0, 120)}`);
            if (isStale && !purgeLogs) {
              info(`  7일 초과 — 삭제: tfx doctor --fix --purge-logs`);
            }
            if (!isStale) issues++;
          }

          if (purged > 0) {
            const now = Date.now();
            const remaining = entries.filter(
              (entry) => now - entry.ts < STALE_AGE_MS,
            );
            writeFileSync(
              issuesFile,
              remaining.map((e) => JSON.stringify(e)).join("\n") +
                (remaining.length ? "\n" : ""),
            );
            if (purged > 0) {
              ok(`${purged}개 stale 로그 항목 삭제 (7일 초과)`);
              report.actions.push({
                name: "purge-stale-logs",
                status: "applied",
                count: purged,
              });
            }
          }
          addDoctorCheck(report, {
            name: "cli-issues",
            status: unresolved.length === 0 ? "ok" : "issues",
            path: issuesFile,
            unresolved: unresolved.length,
          });
        }
      } catch (e) {
        addDoctorCheck(report, {
          name: "cli-issues",
          status: "invalid",
          path: issuesFile,
          fix: "cli-issues.jsonl 형식을 확인하세요.",
        });
        warn(`이슈 파일 읽기 실패: ${e.message}`);
      }
    } else {
      addDoctorCheck(report, {
        name: "cli-issues",
        status: "ok",
        path: issuesFile,
        unresolved: 0,
      });
      ok("이슈 로그 없음 (정상)");
    }

    // Team Sessions
    section("Team Sessions");
    const teamSessionReport = inspectTeamSessions();
    if (!teamSessionReport.mux) {
      addDoctorCheck(report, {
        name: "team-sessions",
        status: "skipped",
        detail: "tmux/psmux unavailable",
      });
      info("tmux/psmux 미감지 — 팀 세션 검사 건너뜀");
    } else if (teamSessionReport.sessions.length === 0) {
      addDoctorCheck(report, {
        name: "team-sessions",
        status: "ok",
        multiplexer: teamSessionReport.mux,
        sessions: 0,
      });
      ok(`활성 팀 세션 없음 ${DIM}(${teamSessionReport.mux})${RESET}`);
    } else {
      addDoctorCheck(report, {
        name: "team-sessions",
        status: teamSessionReport.sessions.some((session) => session.stale)
          ? "issues"
          : "ok",
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
        const attachedLabel =
          session.attachedCount == null ? "?" : `${session.attachedCount}`;
        const ageLabel = formatElapsedAge(session.ageSec);

        if (session.stale) {
          warn(
            `${session.sessionName}: stale 추정 (attach=${attachedLabel}, 경과=${ageLabel})`,
          );
        } else {
          ok(
            `${session.sessionName}: 정상 (attach=${attachedLabel}, 경과=${ageLabel})`,
          );
        }

        if (session.createdAt == null) {
          info(
            `${session.sessionName}: session_created 파싱 실패${session.createdRaw ? ` (${session.createdRaw})` : ""}`,
          );
        }
      }

      const staleSessions = teamSessionReport.sessions.filter(
        (session) => session.stale,
      );
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

    // detached tmux session report and opt-in cleanup
    section("Detached Tmux Sessions");
    const detachedTmuxReport = inspectDetachedTmuxSessions({
      prefix: cleanupStaleTmuxPrefix,
      ageMin: cleanupStaleTmuxAgeMin,
    });
    report.tmuxSessions = {
      detached: detachedTmuxReport.sessions.length,
      stale: detachedTmuxReport.staleCandidates.length,
      prefix: detachedTmuxReport.prefix,
      ageMin: detachedTmuxReport.ageMin,
      available: detachedTmuxReport.available,
      reason: detachedTmuxReport.reason,
      sessions: detachedTmuxReport.sessions.map((session) => ({
        name: session.name,
        age: session.age,
        age_sec: session.ageSec,
        cwd: session.cwd,
        command: session.command,
        memory_estimate_mb: session.memoryEstimateMb,
        stale: session.staleCandidate,
      })),
    };
    addDoctorCheck(report, {
      name: "detached-tmux-sessions",
      status: !detachedTmuxReport.available
        ? "skipped"
        : detachedTmuxReport.staleCandidates.length > 0
          ? "warning"
          : "ok",
      prefix: detachedTmuxReport.prefix,
      age_min: detachedTmuxReport.ageMin,
      detached: detachedTmuxReport.sessions.length,
      stale: detachedTmuxReport.staleCandidates.length,
      reason: detachedTmuxReport.reason,
    });

    if (!detachedTmuxReport.available) {
      info(
        `tmux 미감지 또는 서버 없음 — detached tmux 검사 건너뜀 (${detachedTmuxReport.reason})`,
      );
    } else if (detachedTmuxReport.sessions.length === 0) {
      ok(`detached tmux session 없음 (prefix=${detachedTmuxReport.prefix})`);
    } else {
      info(
        `prefix=${detachedTmuxReport.prefix} age-min=${detachedTmuxReport.ageMin}분`,
      );
      for (const session of detachedTmuxReport.sessions) {
        const memoryLabel =
          session.memoryEstimateMb == null
            ? "?"
            : `${session.memoryEstimateMb}MB`;
        const cwdLabel = session.cwd || "?";
        const commandLabel = session.command || "?";
        const line = `${session.name}: age=${session.age} cwd=${cwdLabel} command=${commandLabel} memory=${memoryLabel}`;
        if (session.staleCandidate) warn(`${line} stale`);
        else ok(`${line} fresh`);
      }
    }

    if (cleanupStaleTmux) {
      const cleanupResult = await cleanupDetachedTmuxSessions({
        sessions: detachedTmuxReport.sessions,
        dryRun: cleanupStaleTmuxDryRun,
        apply: cleanupStaleTmuxApply,
      });
      report.actions.push({
        type: "cleanup-stale-tmux",
        status: cleanupResult.failed > 0 ? "failed" : "ok",
        dryRun: cleanupResult.dryRun,
        retired: cleanupResult.retired,
        skipped: cleanupResult.skipped,
        excluded: cleanupResult.excluded,
        failed: cleanupResult.failed,
      });
      for (const result of cleanupResult.results) {
        if (result.action === "excluded-fresh") {
          ok(`fresh detached tmux excluded: ${result.name}`);
        } else if (result.action === "dry-run-skip") {
          info(`dry-run stale tmux target: ${result.name}`);
        } else if (result.action === "retired") {
          ok(`stale tmux session killed: ${result.name}`);
        } else {
          fail(`stale tmux cleanup failed: ${result.name}`);
        }
      }
      issues += cleanupResult.failed;
      if (
        cleanupResult.dryRun &&
        detachedTmuxReport.staleCandidates.length > 0
      ) {
        issues += detachedTmuxReport.staleCandidates.length;
      }
    } else if (detachedTmuxReport.staleCandidates.length > 0) {
      info(
        "정리: tfx doctor --cleanup-stale-tmux --prefix tfx-* --dry-run|--apply",
      );
      issues += detachedTmuxReport.staleCandidates.length;
    }

    // detached tfx-hub/server.mjs 누적 감지 및 opt-in 정리
    section("Hub Servers");
    try {
      const hubReport = await inspectDetachedHubProcesses();
      report.hubServers = {
        detached: hubReport.hubs.length,
        stale: hubReport.staleCandidates.length,
        activeHealthy: hubReport.activeHealthy,
        expectedVersion: hubReport.expectedVersion,
        hubs: hubReport.hubs.map((hub) => ({
          pid: hub.pid,
          ppid: hub.ppid,
          version: hub.version,
          uptime: hub.uptime,
          ports: hub.ports,
          established: hub.established,
          rssKb: hub.rssKb,
          activeHealthy: hub.activeHealthy,
          activeReason: hub.activeReason,
          healthStatus: hub.healthStatus,
          staleCandidate: hub.staleCandidate,
        })),
      };
      addDoctorCheck(report, {
        name: "hub-server-processes",
        status: hubReport.staleCandidates.length > 0 ? "warning" : "ok",
        detached: hubReport.hubs.length,
        stale: hubReport.staleCandidates.length,
        activeHealthy: hubReport.activeHealthy,
      });

      if (hubReport.hubs.length === 0) {
        ok("PPID=1 hub/server.mjs 없음");
      } else {
        for (const hub of hubReport.hubs) {
          const portLabel = hub.ports.length > 0 ? hub.ports.join(",") : "?";
          const versionLabel = hub.version || "unknown";
          const rssLabel = hub.rssKb == null ? "?" : `${hub.rssKb}KB`;
          const activeLabel = hub.activeHealthy
            ? ` healthy excluded${hub.activeReason ? ` (${hub.activeReason})` : ""}`
            : " stale candidate";
          const line = `PID=${hub.pid} PPID=${hub.ppid} status=${hub.healthStatus} version=${versionLabel} uptime=${hub.uptime} port=${portLabel} ESTABLISHED=${hub.established} RSS=${rssLabel}${activeLabel}`;
          if (hub.activeHealthy) ok(line);
          else warn(line);
        }
      }

      if (cleanupStaleHubs) {
        const cleanupResult = await cleanupDetachedHubProcesses({
          hubs: hubReport.hubs,
          activeHealthy: hubReport.activeHealthy,
          dryRun: cleanupStaleHubsDryRun,
          apply: cleanupStaleHubsApply,
        });
        report.actions.push({
          type: "cleanup-stale-hubs",
          status: cleanupResult.failed > 0 ? "failed" : "ok",
          dryRun: cleanupResult.dryRun,
          retired: cleanupResult.retired,
          skipped: cleanupResult.skipped,
          excluded: cleanupResult.excluded,
          failed: cleanupResult.failed,
        });
        for (const result of cleanupResult.results) {
          if (result.action === "excluded-active") {
            ok(`dry-run healthy hub excluded: PID=${result.pid}`);
          } else if (result.action === "dry-run-skip") {
            info(`dry-run stale hub target: PID=${result.pid}`);
          } else if (result.action === "retired") {
            ok(`stale hub retired: PID=${result.pid} (${result.reason})`);
          } else {
            fail(`stale hub cleanup failed: PID=${result.pid}`);
          }
        }
        issues += cleanupResult.failed;
        if (cleanupResult.dryRun && hubReport.staleCandidates.length > 0) {
          issues += hubReport.staleCandidates.length;
        }
      } else if (hubReport.staleCandidates.length > 0) {
        info("정리: tfx doctor --cleanup-stale-hubs --dry-run|--apply");
        issues += hubReport.staleCandidates.length;
      }
    } catch (error) {
      addDoctorCheck(report, {
        name: "hub-server-processes",
        status: "warning",
        error: error.message,
      });
      warn(`hub/server.mjs 검사 실패: ${error.message}`);
      issues++;
    }

    // 고아 node.exe 프로세스 정리 (Windows)
    section("Orphan Processes");
    if (process.platform === "win32") {
      try {
        const {
          cleanupOrphanNodeProcesses,
          cleanupStaleFsmonitorDaemons,
          findFsmonitorDaemons,
        } = await import("../hub/lib/process-utils.mjs");
        if (fix) {
          const { killed, remaining } = cleanupOrphanNodeProcesses();
          if (killed > 0) {
            warn(
              `고아 node.exe ${killed}개 정리 완료 (남은 프로세스: ${remaining})`,
            );
          } else {
            ok(`고아 node.exe 없음 (활성: ${remaining})`);
          }
        } else {
          // --fix 없이는 개수만 보고
          const { execSync: execSyncDoctor } = await import(
            "node:child_process"
          );
          const countStr = execSyncDoctor(
            `powershell -NoProfile -WindowStyle Hidden -Command "(Get-Process node -ErrorAction SilentlyContinue).Count"`,
            { encoding: "utf8", timeout: 5000 },
          ).trim();
          const count = Number.parseInt(countStr, 10) || 0;
          if (count > 20) {
            warn(
              `node.exe ${count}개 실행 중 (고아 포함 가능). 정리: tfx doctor --fix`,
            );
            issues++;
          } else {
            ok(`node.exe ${count}개 (정상 범위)`);
          }
        }

        const fsmonitorStale = findFsmonitorDaemons({
          minAgeMs: 24 * 60 * 60 * 1000,
        });
        let fsmonitorKilled = 0;
        if (fix && fsmonitorStale.length > 0) {
          const cleanupResult = cleanupStaleFsmonitorDaemons({
            minAgeMs: 24 * 60 * 60 * 1000,
          });
          fsmonitorKilled = cleanupResult.killed;
          report.actions.push({
            type: "git-fsmonitor-cleanup",
            status:
              fsmonitorKilled === fsmonitorStale.length ? "ok" : "partial",
            stale: fsmonitorStale.length,
            killed: fsmonitorKilled,
          });
          warn(
            `stale git fsmonitor daemon ${fsmonitorKilled}/${fsmonitorStale.length}개 정리`,
          );
        } else if (fsmonitorStale.length > 0) {
          warn(
            `stale git fsmonitor daemon ${fsmonitorStale.length}개 발견 (24h+). 정리: tfx doctor --fix`,
          );
        } else {
          ok("stale git fsmonitor daemon 없음");
        }

        report.fsmonitorDaemons = {
          stale: fsmonitorStale.length,
          killed: fsmonitorKilled,
        };
        addDoctorCheck(report, {
          name: "fsmonitor-daemons",
          status: fsmonitorStale.length > 0 ? "warning" : "ok",
          stale: fsmonitorStale.length,
          killed: fsmonitorKilled,
          detail: fsmonitorStale.map((p) => ({
            pid: p.pid,
            parentPid: p.parentPid,
            ageHours: Number((p.ageMs / (60 * 60 * 1000)).toFixed(1)),
          })),
        });
        if (
          fsmonitorStale.length > 0 &&
          (!fix || fsmonitorKilled < fsmonitorStale.length)
        ) {
          issues++;
        }
      } catch (e) {
        info(`고아 프로세스 검사 실패: ${e.message}`);
      }
    } else {
      ok("Windows 전용 검사 — 건너뜀");
    }

    // ── MCP 중앙 레지스트리 ──
    section("MCP Registry");
    {
      const registryState = inspectRegistry();
      if (!registryState.valid) {
        addDoctorCheck(report, {
          name: "mcp-registry",
          status: registryState.exists ? "invalid" : "missing",
          path: registryState.path,
          errors: registryState.errors,
          fix: "tfx doctor --fix",
        });
        warn("MCP registry 없음 또는 손상: tfx doctor --fix");
        issues++;
      } else {
        const statusInfo = inspectRegistryStatus(registryState.registry);
        const invalidConfigs = statusInfo.configs.filter(
          (config) => config.parseError,
        );
        const mismatchRows = statusInfo.rows.filter(
          (row) => row.type === "registry" && row.status === "mismatch",
        );
        const missingRows = statusInfo.rows.filter(
          (row) => row.type === "registry" && row.status === "missing",
        );
        const missingFileRows = statusInfo.rows.filter(
          (row) => row.type === "registry" && row.status === "missing-file",
        );
        const stdioRows = statusInfo.rows.filter((row) => row.type === "stdio");
        const hasHardIssues =
          invalidConfigs.length > 0 || mismatchRows.length > 0;
        const status = hasHardIssues
          ? "issues"
          : stdioRows.length > 0
            ? "warning"
            : "ok";

        addDoctorCheck(report, {
          name: "mcp-registry",
          status,
          path: registryState.path,
          server_count: Object.keys(registryState.registry.servers || {})
            .length,
          rows: statusInfo.rows,
          invalid_configs: invalidConfigs.map((config) => ({
            file: config.filePath,
            error: config.parseError?.message || "parse error",
          })),
          ...(stdioRows.length > 0
            ? { fix: "tfx doctor --fix 또는 tfx mcp sync" }
            : {}),
        });

        ok(
          `registry 정상 (${Object.keys(registryState.registry.servers || {}).length}개 server)`,
        );

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
          info(
            `${formatPathForDisplay(config.filePath)} — ${config.parseError.message}`,
          );
        }

        for (const row of mismatchRows) {
          warn(`${row.label}: ${row.name} URL 불일치`);
          info(`expected ${row.expectedUrl}`);
          if (row.actualUrl) info(`actual   ${row.actualUrl}`);
        }

        // #144: --fix 모드에서 tfx-hub URL 불일치를 hub status 기준으로 자동 갱신.
        // Project MCP (.mcp.json) 와 Codex/Claude/Gemini settings 모두 대상.
        // Codex review P2: fix 성공 시 issues 집계에서 차감해야 doctor 결과가 ok 로 반영됨.
        let autoFixedMismatches = 0;
        if (fix && mismatchRows.some((r) => r.name === "tfx-hub")) {
          try {
            const hubUrl = mismatchRows.find(
              (r) => r.name === "tfx-hub",
            )?.expectedUrl;
            if (hubUrl) {
              const { syncHubMcpSettings, syncProjectMcpJson } = await import(
                "../scripts/sync-hub-mcp-settings.mjs"
              );
              const settingsResult = await syncHubMcpSettings({
                hubUrl,
                logger: { log() {}, warn() {}, error() {} },
              });
              const projectResult = await syncProjectMcpJson({
                hubUrl,
                projectRoot: process.cwd(),
                logger: { log() {}, warn() {}, error() {} },
              });
              const totalUpdated =
                (settingsResult?.updated?.length || 0) +
                (projectResult?.updated?.length || 0);
              if (totalUpdated > 0) {
                ok(`tfx-hub URL ${totalUpdated}개 파일 자동 갱신 (${hubUrl})`);
                report.actions.push({
                  name: "sync-hub-url",
                  status: "applied",
                  files: [
                    ...(settingsResult?.updated || []),
                    ...(projectResult?.updated || []),
                  ],
                });
                // fix 성공 — mismatchRows 중 tfx-hub 엔트리는 해결된 것으로 집계
                autoFixedMismatches = mismatchRows.filter(
                  (r) => r.name === "tfx-hub",
                ).length;
              } else {
                info("tfx-hub URL 자동 갱신: 대상 파일 없음");
              }
            }
          } catch (e) {
            warn(
              `tfx-hub URL 자동 갱신 실패: ${e?.message?.split(/\r?\n/)[0] || e}`,
            );
          }
        }

        for (const row of missingFileRows) {
          info(
            `${row.label}: ${row.name} 미배치 (${formatPathForDisplay(row.filePath)})`,
          );
        }

        for (const row of missingRows) {
          info(`${row.label}: ${row.name} 누락`);
        }

        if (stdioRows.length === 0) {
          ok("미등록 stdio MCP 없음");
        } else {
          warn(`${stdioRows.length}개 미등록 stdio MCP 감지`);
          for (const row of stdioRows) {
            info(
              `${row.label}: ${row.name}${row.command ? ` (${row.command})` : ""}`,
            );
          }
        }

        issues += invalidConfigs.length;
        issues += Math.max(0, mismatchRows.length - autoFixedMismatches);
        issues += stdioRows.length;
      }
    }

    // ── Codex Config Health (BUG-H #132) ──
    // 이전 버전의 swap이 남긴 백업을 감지하고 --fix로 복원한다.
    section("Codex Config Health");
    {
      const codexConfig = join(CODEX_DIR, "config.toml");
      const orphanBackup = `${codexConfig}.pre-exec`;
      if (existsSync(orphanBackup)) {
        addDoctorCheck(report, {
          name: "codex-config-orphan-backup",
          status: "issues",
          path: orphanBackup,
          fix: "tfx doctor --fix",
        });
        warn(
          `orphan config swap backup 감지: ${formatPathForDisplay(orphanBackup)}`,
        );
        info("이전 Codex 실행의 config swap 이 restore 에 실패했습니다.");
        if (fix) {
          // BUG-H (#132) ownership-claim + atomic rename:
          // 1) orphan → claim (rename 으로 소유권 확보 — 동시 codex worker 가 건드릴 수 없음)
          // 2) claim 읽어 tmp 로 write
          // 3) tmp → codexConfig 로 atomic rename
          // 4) claim 삭제
          // 중간 실패 시 claim 을 orphan 경로로 되돌려 수동 복구 가능하게 한다.
          const claimPath = `${orphanBackup}.doctor-claim-${process.pid}`;
          const tmpPath = `${codexConfig}.doctor-tmp-${process.pid}`;
          try {
            renameSync(orphanBackup, claimPath);
          } catch (error) {
            fail(`복원 실패 (ownership claim): ${error.message}`);
            info(
              `다른 프로세스가 backup 을 사용 중이거나 이미 정리됨: ${orphanBackup}`,
            );
            issues++;
          }
          if (existsSync(claimPath)) {
            try {
              const backupContent = readFileSync(claimPath, "utf8");
              writeFileSync(tmpPath, backupContent);
              renameSync(tmpPath, codexConfig);
              unlinkSync(claimPath);
              ok("config.toml 을 backup 에서 복원 + orphan 제거 완료");
            } catch (error) {
              fail(`복원 실패: ${error.message}`);
              // 실패 시 claim 을 orphan 경로로 되돌려 사용자가 재시도 가능하게.
              try {
                renameSync(claimPath, orphanBackup);
              } catch {
                // claim 롤백 실패 — claim 그대로 남음. 경로 알려줌.
                info(
                  `claim 경로 보존: ${claimPath} (수동으로 ${orphanBackup} 로 이동 가능)`,
                );
              }
              try {
                unlinkSync(tmpPath);
              } catch {
                // tmp 가 아직 안 만들어진 경우 무시
              }
              issues++;
            }
          }
        } else {
          info("복원하려면 `tfx doctor --fix` 를 실행하세요.");
          issues++;
        }
      } else {
        addDoctorCheck(report, {
          name: "codex-config-orphan-backup",
          status: "ok",
        });
        ok("orphan config swap backup 없음");
      }
    }

    // ── Route Script 정합성 ──
    section("Route Script Sync");
    {
      const srcRoute = join(PKG_ROOT, "scripts", "tfx-route.sh");
      const destRoute = join(CLAUDE_DIR, "scripts", "tfx-route.sh");
      if (existsSync(srcRoute) && existsSync(destRoute)) {
        const srcContent = readFileSync(srcRoute, "utf8");
        const destContent = readFileSync(destRoute, "utf8");
        if (srcContent === destContent) {
          addDoctorCheck(report, { name: "route-sync", status: "ok" });
          ok("프로젝트 소스와 설치본 일치");
        } else {
          addDoctorCheck(report, {
            name: "route-sync",
            status: "issues",
            fix: "tfx setup",
          });
          warn("tfx-route.sh 프로젝트 소스와 설치본 불일치");
          info(
            `소스: ${srcRoute} (${Buffer.byteLength(srcContent)}B) / 설치: ${destRoute} (${Buffer.byteLength(destContent)}B)`,
          );
          if (fix) {
            copyFileSync(srcRoute, destRoute);
            ok("tfx-route.sh 동기화 완료");
          } else {
            issues++;
          }
        }
      } else if (existsSync(srcRoute) && !existsSync(destRoute)) {
        addDoctorCheck(report, {
          name: "route-sync",
          status: "missing",
          fix: "tfx setup",
        });
        fail("설치본 없음");
        issues++;
      } else {
        addDoctorCheck(report, { name: "route-sync", status: "ok" });
        ok("소스 없음 (npm 패키지 모드)");
      }
    }

    section("이전 Claude command hook");
    const legacyHooks = cleanupLegacyHooks({
      settingsPath: join(CLAUDE_DIR, "settings.json"),
      dryRun: !fix,
    });
    const remaining = legacyHooks.ok && fix ? 0 : legacyHooks.removed;
    report.legacy_hooks = { remaining, removed: fix ? legacyHooks.removed : 0 };
    addDoctorCheck(report, {
      name: "legacy-claude-hooks",
      status: !legacyHooks.ok ? "error" : remaining > 0 ? "issues" : "ok",
      ...report.legacy_hooks,
      ...(legacyHooks.ok ? {} : { error: legacyHooks.error }),
      ...(remaining > 0 ? { fix: "tfx doctor --fix" } : {}),
    });
    if (!legacyHooks.ok) {
      fail(`이전 hook 점검 실패: ${legacyHooks.error}`);
      issues++;
    } else if (remaining > 0) {
      warn(`이전 triflux hook ${remaining}개 남음: tfx doctor --fix`);
      issues += remaining;
    } else {
      ok(
        fix && legacyHooks.changed
          ? `이전 hook ${legacyHooks.removed}개 정리됨`
          : "남은 triflux command hook 없음",
      );
    }
    if (fix) {
      try {
        execFileSync(
          process.execPath,
          [join(PKG_ROOT, "scripts", "session-stale-cleanup.mjs")],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30000,
            windowsHide: true,
          },
        );
        report.actions.push({ name: "session-stale-cleanup", status: "ok" });
      } catch (error) {
        warn(`이전 세션 정리 실패: ${error.message}`);
        report.actions.push({ name: "session-stale-cleanup", status: "error" });
        issues++;
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

function normalizeRemoteReachabilityUrl(remoteUrl) {
  if (!remoteUrl) return null;
  if (/^https?:\/\//iu.test(remoteUrl)) {
    try {
      return new URL(remoteUrl).origin;
    } catch {
      return null;
    }
  }
  const scpMatch = /^git@([^:]+):/iu.exec(remoteUrl);
  if (scpMatch) return `https://${scpMatch[1]}`;
  if (/^ssh:\/\//iu.test(remoteUrl)) {
    try {
      return `https://${new URL(remoteUrl).hostname}`;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveGitUpdateUrl(repoDir) {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf8",
      timeout: 10_000,
      cwd: repoDir,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return normalizeRemoteReachabilityUrl(remoteUrl);
  } catch {
    return null;
  }
}

function resolveUpdateTargets({ installMode, pluginPath }) {
  const repoDir = installMode === "plugin" ? pluginPath || PKG_ROOT : PKG_ROOT;
  const gitUrl = resolveGitUpdateUrl(repoDir);

  if (installMode === "npm-global" || installMode === "npm-local") {
    return ["https://registry.npmjs.org/triflux"];
  }
  if (installMode === "plugin" || installMode === "git-local") {
    return gitUrl ? [gitUrl] : ["https://github.com"];
  }
  return [];
}

async function cmdUpdate(args = []) {
  if (args.some(isHelpArg)) {
    printCommandHelp("update");
    return;
  }

  const isDev = isDevUpdateRequested(args);
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
  if (
    installMode === "unknown" &&
    PKG_ROOT.includes(join(".claude", "plugins"))
  ) {
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

  info(
    `검색: ${installMode === "plugin" ? "플러그인" : installMode === "npm-global" ? "npm global" : installMode === "npm-local" ? "npm local" : installMode === "git-local" ? "git 로컬 저장소" : "알 수 없음"} 설치 감지`,
  );

  const networkTargets = resolveUpdateTargets({ installMode, pluginPath });
  if (networkTargets.length > 0) {
    const networkStatus = await checkNetworkAvailability(networkTargets);
    if (!networkStatus.online) {
      fail(`네트워크 확인 실패: ${networkStatus.unreachable.join(", ")}`);
      info("네트워크 연결을 확인한 뒤 다시 시도하세요.");
      return;
    }
    ok(`네트워크 확인 완료 (${networkStatus.reachable.join(", ")})`);
  }

  const cacheValidation = validateRuntimeCachePaths(join(CLAUDE_DIR, "cache"));
  if (!cacheValidation.ok) {
    warn(`런타임 캐시 검증 이슈 ${cacheValidation.issues.length}건 발견`);
    for (const issue of cacheValidation.issues) {
      info(`${issue.file}: ${issue.error}`);
    }
  } else {
    ok("런타임 캐시 검증 완료");
  }

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
        const npmCmd = isDev
          ? "npm install -g triflux@dev"
          : "npm install -g triflux@latest";
        let result;
        try {
          result = execSync(npmCmd, {
            encoding: "utf8",
            timeout: 90000,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
            .trim()
            .split(/\r?\n/)[0];
        } catch {
          // Windows: 자기 자신의 파일 잠금으로 첫 시도 실패 가능 → --force 재시도
          info("첫 시도 실패, --force 재시도 중...");
          result = execSync(`${npmCmd} --force`, {
            encoding: "utf8",
            timeout: 90000,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
            .trim()
            .split(/\r?\n/)[0];
        }
        ok(`${npmCmd} — ${result || "완료"}`);
        updated = true;
        break;
      }
      case "npm-local": {
        const npmLocalCmd = isDev
          ? "npm install triflux@dev"
          : "npm update triflux";
        const result = execSync(npmLocalCmd, {
          encoding: "utf8",
          timeout: 60000,
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        })
          .trim()
          .split(/\r?\n/)[0];
        ok(
          `${isDev ? "npm install triflux@dev" : "npm update triflux"} — ${result || "완료"}`,
        );
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
    fail(
      `업데이트 실패: ${e.message}${stderr ? `\n  ${stderr.split(/\r?\n/)[0]}` : ""}`,
    );
    return;
  }

  // 3. setup 재실행 (파일 동기화, 프로파일, HUD, CLI 확인)
  if (updated) {
    console.log("");
    const updatedRoot =
      installMode === "plugin" ? pluginPath || PKG_ROOT : PKG_ROOT;
    // 업데이트 후 새 버전 읽기
    let newVer = oldVer;
    try {
      const newPkg = JSON.parse(
        readFileSync(join(updatedRoot, "package.json"), "utf8"),
      );
      newVer = newPkg.version;
    } catch {}

    if (newVer !== oldVer) {
      ok(`버전: v${oldVer} → v${newVer}`);
    } else {
      ok(`버전: v${oldVer} (이미 최신)`);
    }

    try {
      runUpdatedSetup({ packageRoot: updatedRoot });
    } catch (error) {
      if (stoppedHubInfo) startHubAfterUpdate(stoppedHubInfo);
      throw createCliError(`업데이트 후 설정 동기화 실패: ${error.message}`, {
        exitCode: error.status || EXIT_ERROR,
        reason: "error",
      });
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

  if (existsSync(pluginSkills)) {
    for (const name of readdirSync(pluginSkills).sort()) {
      const src = join(pluginSkills, name, "SKILL.md");
      if (!existsSync(src)) continue;
      const dst = join(installedSkills, name, "SKILL.md");
      packageSkills.push({
        name,
        installed: existsSync(dst),
      });
    }
  }

  const pkgNames = new Set(
    existsSync(pluginSkills) ? readdirSync(pluginSkills) : [],
  );
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
      console.log(
        `    ${RED_BRIGHT}✗${RESET} ${DIM}${skill.name}${RESET} ${GRAY}(미설치)${RESET}`,
      );
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
  console.log(
    `\n  ${AMBER}${BOLD}⬡ triflux${RESET} ${WHITE_BRIGHT}v${PKG.version}${RESET}`,
  );
  if (routeVer) console.log(`  ${GRAY}tfx-route${RESET}  v${routeVer}`);
  if (hudVer) console.log(`  ${GRAY}hud${RESET}        v${hudVer}`);
  console.log("");
}

function cmdMcp(args = [], options = {}) {
  const { json = false } = options;
  const sub = String(args[0] || "list")
    .trim()
    .toLowerCase();

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
          server_count: Object.keys(registryState.registry.servers || {})
            .length,
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
      ok(
        `${Object.keys(registryState.registry.servers || {}).length}개 server 등록됨`,
      );
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
      const allProjectsIndex = args.indexOf("--all-projects");
      const allProjectsRoot =
        allProjectsIndex >= 0 &&
        args[allProjectsIndex + 1] &&
        !String(args[allProjectsIndex + 1]).startsWith("--")
          ? args[allProjectsIndex + 1]
          : null;
      const dryRun = args.includes("--dry-run");
      const excludes = args.flatMap((arg, index) =>
        arg === "--exclude" && args[index + 1] ? [args[index + 1]] : [],
      );
      const allProjects =
        allProjectsIndex >= 0
          ? discoverProjectMcpTargets({
              root: allProjectsRoot || undefined,
              exclude: excludes,
            })
          : null;
      const result = dryRun
        ? { actions: [] }
        : syncRegistryTargets({
            registry: registryState.registry,
            ...(allProjects ? { targets: allProjects.targets } : {}),
          });
      if (json) {
        printJson({
          registry_path: registryState.path,
          ...(allProjects
            ? {
                dry_run: dryRun,
                all_projects: {
                  root: allProjects.root,
                  maxDepth: allProjects.maxDepth,
                  exclude: allProjects.exclude,
                  count: allProjects.targets.length,
                },
                targets: allProjects.targets,
              }
            : {}),
          actions: result.actions,
        });
        return;
      }

      console.log(`\n  ${AMBER}${BOLD}⬡ triflux mcp sync${RESET} ${VER}\n`);
      console.log(`  ${LINE}`);
      if (allProjects) {
        section("Project Targets");
        info(`${allProjects.targets.length}개 파일 (${allProjects.root})`);
        for (const target of allProjects.targets) {
          info(formatPathForDisplay(target.filePath));
        }
        if (dryRun) {
          console.log("");
          return;
        }
      }
      section("Actions");
      for (const action of result.actions) {
        for (const warning of action.warnings || []) {
          process.stderr.write(`${warning}\n`);
        }
        const label = `${action.label} ${DIM}(${formatPathForDisplay(action.filePath)})${RESET}`;
        if (action.status === "updated") ok(`${label} → updated`);
        else if (action.status === "warning") warn(`${label} → warning`);
        else if (action.status === "invalid-config")
          fail(`${label} → invalid-config`);
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
        try {
          return new URL(url).toString();
        } catch {
          throw createCliError(`Invalid MCP URL: ${url}`, {
            exitCode: EXIT_ARG_ERROR,
            reason: "argError",
            fix: "http:// 또는 https:// URL을 사용하세요.",
          });
        }
      })();

      const server = addRegistryServer(name, normalizedUrl);
      const registryState = ensureValidRegistryState();
      const syncResult = syncRegistryTargets({
        registry: registryState.registry,
      });
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
      const updated = syncResult.actions.filter(
        (action) => action.status === "updated",
      ).length;
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
      const cleanup = removeServerFromTargets(name, {
        targets: removed?.targets,
      });
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
      const changed = cleanup.actions.filter(
        (action) => action.status === "removed",
      ).length;
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

function cmdHelp() {
  console.log(`
  ${AMBER}${BOLD}⬡ triflux${RESET} ${DIM}v${PKG.version}${RESET}
  ${GRAY}CLI-first multi-model orchestrator for Claude Code${RESET}

  ${LINE}

  ${BOLD}Commands${RESET}

    ${WHITE_BRIGHT}tfx setup${RESET}      ${GRAY}파일 동기화 + HUD 설정${RESET}
    ${DIM}  --dry-run${RESET}    ${GRAY}변경 예정 작업을 JSON으로 미리보기${RESET}
    ${DIM}  --mods${RESET}       ${GRAY}Claude Code mods 설치 (2.1.287 이상)${RESET}
    ${WHITE_BRIGHT}tfx doctor${RESET}     ${GRAY}CLI 진단 + 이슈 확인${RESET}
    ${DIM}  --fix${RESET}        ${GRAY}진단 + 자동 수정${RESET}
    ${DIM}  --reset${RESET}      ${GRAY}캐시 전체 초기화${RESET}
    ${DIM}  --json${RESET}       ${GRAY}구조화된 진단 결과 JSON 출력${RESET}
    ${WHITE_BRIGHT}tfx mcp${RESET}        ${GRAY}MCP registry 관리 (list/sync/add/remove)${RESET}
    ${WHITE_BRIGHT}tfx update${RESET}     ${GRAY}최신 안정 버전으로 업데이트${RESET}
    ${DIM}  --dev / dev${RESET}   ${GRAY}dev 태그로 업데이트${RESET}
    ${WHITE_BRIGHT}tfx list${RESET}       ${GRAY}설치된 스킬 목록${RESET}
    ${WHITE_BRIGHT}tfx hub${RESET}        ${GRAY}MCP 메시지 버스 관리 (start/stop/status)${RESET}
    ${WHITE_BRIGHT}tfx multi${RESET}       ${GRAY}멀티-CLI 팀 모드 (tmux + Hub)${RESET}
    ${WHITE_BRIGHT}tfx synapse${RESET}     ${GRAY}스웜 세션 registry 조회 / lease 관리${RESET}
    ${WHITE_BRIGHT}tfx why${RESET}         ${GRAY}경로의 마지막 커밋 X-Intent 트레일러 추출${RESET}
    ${WHITE_BRIGHT}tfx version${RESET}    ${GRAY}버전 표시${RESET}

  ${BOLD}Skills${RESET} ${GRAY}(Claude Code 슬래시 커맨드)${RESET}

    ${AMBER}/tfx-auto${RESET}       ${GRAY}자동 분류 + 병렬 실행 (--cli codex|antigravity|claude, --parallel N)${RESET}
    ${AMBER}/tfx-setup${RESET}      ${GRAY}HUD 설정 + 진단${RESET}
    ${YELLOW}/tfx-doctor${RESET}     ${GRAY}진단 + 수리 + 캐시 초기화${RESET}

  ${LINE}
  ${GRAY}github.com/tellang/triflux${RESET}
`);
}

// ── Hub preflight 체크 (multi/auto 실행 전) ──

async function checkHubRunning() {
  // preflight 캐시 먼저 확인 — 히트 시 fetch 스킵
  try {
    const cacheFile = join(homedir(), ".claude", "cache", "tfx-preflight.json");
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (Date.now() - cached.timestamp < 3_600_000 && cached.hub?.ok)
      return true;
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
  info(
    `Hub 없이 실행하면 Claude 네이티브 에이전트로 폴백되어 토큰이 소비됩니다.`,
  );
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
    try {
      unlinkSync(HUB_PID_FILE);
    } catch {}
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
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {}
  }

  // Windows에서 better-sqlite3.node 파일 핸들 해제 대기
  // taskkill 후 프로세스 종료 + 파일 핸들 해제까지 최대 5초
  const sqliteNode = join(
    PKG_ROOT,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  for (let i = 0; i < 10; i++) {
    sleepMs(500);
    try {
      process.kill(info.pid, 0);
    } catch {
      break;
    }
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
  try {
    unlinkSync(HUB_PID_FILE);
  } catch {}
  return info;
}

function openHubLogFd() {
  try {
    const logDir = join(homedir(), ".claude", "cache", "tfx-hub");
    mkdirSync(logDir, { recursive: true });
    return openSync(join(logDir, "hub.log"), "a");
  } catch {
    return undefined;
  }
}

function startHubAfterUpdate(info) {
  if (!info) return false;
  const serverPath = join(PKG_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) return false;
  const port =
    Number(info?.port) > 0
      ? String(info.port)
      : String(process.env.TFX_HUB_PORT || "27888");

  try {
    const logFd = openHubLogFd();
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, TFX_HUB_PORT: port },
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

// 설치된 CLI에 tfx-hub MCP 서버 자동 등록 (1회 설정, 이후 재실행 불필요)
function autoRegisterMcp(mcpUrl, { codexEnabled = false } = {}) {
  section("MCP 자동 등록");

  // Codex — config.json에 기본 disabled 엔트리로 등록.
  // Hub startup must keep the MCP config fresh even on CI/dev machines where
  // the Codex CLI binary itself is not installed.
  try {
    const result = ensureCodexHubServerConfig({
      mcpUrl,
      createIfMissing: true,
      enabled: codexEnabled,
    });
    if (!result.ok) throw new Error(result.reason || "unknown");
    const suffix = which("codex") ? "" : " (CLI 미설치)";
    if (result.changed) {
      ok(
        `Codex: config.json에 등록 완료 (${codexEnabled ? "enabled" : "기본 disabled"})${suffix}`,
      );
    } else {
      ok(
        `Codex: 이미 등록됨 (${codexEnabled ? "enabled" : "기본 disabled"})${suffix}`,
      );
    }
  } catch (e) {
    warn(`Codex 등록 실패: ${e.message}`);
  }

  // Gemini — settings.json 직접 수정
  if (which("gemini")) {
    try {
      const geminiDir = join(homedir(), ".gemini");
      const settingsFile = join(geminiDir, "settings.json");
      let settings = {};
      if (existsSync(settingsFile))
        settings = JSON.parse(readFileSync(settingsFile, "utf8"));
      if (!settings.mcpServers) settings.mcpServers = {};
      const current = settings.mcpServers["tfx-hub"];
      if (!current || current.url !== mcpUrl) {
        settings.mcpServers["tfx-hub"] = {
          ...(current && typeof current === "object" ? current : {}),
          url: mcpUrl,
        };
        if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        ok(
          current
            ? "Gemini: settings.json URL 갱신 완료"
            : "Gemini: settings.json에 등록 완료",
        );
      } else {
        ok("Gemini: 이미 등록됨");
      }
    } catch (e) {
      warn(`Gemini 등록 실패: ${e.message}`);
    }
  } else {
    info("Gemini: 미설치 (건너뜀)");
  }

  // Claude — .claude/mcp.json에 등록 (Claude Code 공식 경로)
  try {
    const claudeDir = join(process.cwd(), ".claude");
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const mcpJsonPath = join(claudeDir, "mcp.json");
    let mcpJson = {};
    if (existsSync(mcpJsonPath))
      mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
    const current = mcpJson.mcpServers["tfx-hub"];
    if (!current || current.type !== "http" || current.url !== mcpUrl) {
      mcpJson.mcpServers["tfx-hub"] = {
        ...(current && typeof current === "object" ? current : {}),
        type: "http",
        url: mcpUrl,
      };
      writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
      ok(
        current
          ? "Claude: .claude/mcp.json URL/type 갱신 완료"
          : "Claude: .claude/mcp.json에 등록 완료",
      );
    } else {
      ok("Claude: 이미 등록됨");
    }
  } catch (e) {
    warn(`Claude 등록 실패: ${e.message}`);
  }
}

async function cmdHub(args = [], options = {}) {
  const { json = false } = options;
  const sub = args[0] || "status";
  const defaultPortRaw = Number(process.env.TFX_HUB_PORT || "27888");
  const probePort =
    Number.isFinite(defaultPortRaw) && defaultPortRaw > 0
      ? defaultPortRaw
      : 27888;
  const formatHostForUrl = (host) => (host.includes(":") ? `[${host}]` : host);
  const probeHubStatus = async (
    host = "127.0.0.1",
    port = probePort,
    timeoutMs = 3000,
  ) => {
    try {
      const res = await fetch(
        `http://${formatHostForUrl(host)}:${port}/status`,
        {
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
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
      writeFileSync(
        HUB_PID_FILE,
        JSON.stringify({
          pid,
          port,
          host: defaultHost,
          url: `http://${formatHostForUrl(defaultHost)}:${port}/mcp`,
          started: Date.now(),
        }),
      );
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
          const host =
            typeof info.host === "string" && info.host.trim()
              ? info.host.trim()
              : "127.0.0.1";
          const port = Number(info.port) || probePort;
          const probed = await probeHubStatus(host, port, 1500);
          if (probed?.hub) {
            const url = `http://${formatHostForUrl(host)}:${probed.port || port}/mcp`;
            recoverPidFile(probed, host);
            autoRegisterMcp(url, { codexEnabled: true });
            console.log(
              `\n  ${YELLOW}⚠${RESET} hub 이미 실행 중 (PID ${probed.pid || info.pid}, ${url})\n`,
            );
            return;
          }
          warn(
            `stale hub PID 파일 감지: PID ${info.pid}는 살아있지만 hub status 응답이 없음. PID 파일을 정리합니다.`,
          );
          unlinkSync(HUB_PID_FILE);
        } catch {
          // PID 파일 있지만 프로세스 없음 — 정리
          try {
            unlinkSync(HUB_PID_FILE);
          } catch {}
        }
      }

      const portArg = args.indexOf("--port");
      const port = portArg !== -1 ? args[portArg + 1] : String(probePort);
      const serverPath = join(PKG_ROOT, "hub", "server.mjs");

      if (!existsSync(serverPath)) {
        throw createCliError("hub/server.mjs 없음 — hub 모듈이 설치되지 않음", {
          exitCode: EXIT_HUB_ERROR,
          reason: "hubError",
          fix: "hub 모듈이 포함된 triflux 설치본인지 확인한 뒤 다시 실행하세요.",
        });
      }

      // Issue #102 + hub-detach fix: spawn stdout/stderr 를 두 채널로 redirect.
      // - startupErrPath (tmp): 3초 안의 startup 실패 진단 (성공 시 cleanup)
      // - hub.log (cache): runtime stdout/stderr 영구 보존 (crash 추적)
      // detached spawn 은 pipe 유지가 까다로우니 fd 리다이렉트로 접근.
      const { openSync: _openSync, closeSync: _closeSync } = await import(
        "node:fs"
      );
      const { tmpdir: _tmpdir } = await import("node:os");
      const startupErrPath = join(
        _tmpdir(),
        `tfx-hub-start-${Date.now()}-${process.pid}.err`,
      );
      let errFd;
      try {
        errFd = _openSync(startupErrPath, "w");
      } catch {
        errFd = undefined;
      }
      const logFd = openHubLogFd();

      const child = spawn(process.execPath, [serverPath], {
        env: { ...process.env, TFX_HUB_PORT: port },
        stdio: ["ignore", logFd ?? "ignore", errFd ?? logFd ?? "ignore"],
        detached: true,
        windowsHide: true,
      });
      child.unref();
      if (errFd !== undefined) {
        try {
          _closeSync(errFd);
        } catch {}
      }
      if (logFd !== undefined) {
        try {
          _closeSync(logFd);
        } catch {}
      }

      // PID 파일 확인 (최대 3초 대기, 100ms 폴링)
      let started = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (existsSync(HUB_PID_FILE)) {
          started = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (started) {
        const hubInfo = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        console.log(`\n  ${GREEN_BRIGHT}✓${RESET} ${BOLD}tfx-hub 시작${RESET}`);
        console.log(`    URL:  ${AMBER}${hubInfo.url}${RESET}`);
        console.log(`    PID:  ${hubInfo.pid}`);
        console.log(
          `    DB:   ${DIM}${getPipelineStateDbPath(PKG_ROOT)}${RESET}`,
        );
        console.log("");
        autoRegisterMcp(hubInfo.url, { codexEnabled: true });
        console.log("");
        // 성공했으면 임시 stderr 파일 정리
        try {
          unlinkSync(startupErrPath);
        } catch {}
      } else {
        // Issue #102: 캡처된 stderr 에서 root cause 추출
        let rootCause = "";
        try {
          rootCause = readFileSync(startupErrPath, "utf8").trim();
        } catch {}

        console.log(`\n  ${YELLOW}⚠${RESET} 백그라운드 시작 실패`);

        if (rootCause) {
          // 가장 유용한 에러 라인 강조 (ERR_*, Error:, throw)
          const highlight = rootCause
            .split(/\r?\n/)
            .find((line) => /ERR_[A-Z_]+|^Error:|cannot find/i.test(line));
          if (highlight) {
            console.log(`    ${RED}▸ ${highlight.trim()}${RESET}`);
          }
          console.log(`\n  ${DIM}전체 로그: ${startupErrPath}${RESET}`);
          // 원인별 실전 힌트
          if (/Cannot find package/i.test(rootCause)) {
            console.log(
              `  ${DIM}힌트: \`cd ${PKG_ROOT} && npm install\` 로 의존성 복구 (특히 \`npm link\` 환경).${RESET}`,
            );
          } else if (/EADDRINUSE/i.test(rootCause)) {
            console.log(
              `  ${DIM}힌트: 포트 ${port} 이 이미 사용 중. \`tfx hub stop\` 후 재시도.${RESET}`,
            );
          }
        } else {
          console.log(
            `    ${DIM}stderr 캡처 실패 — 아래 명령으로 포그라운드 실행해 원인 확인:${RESET}`,
          );
        }

        console.log(
          `\n  ${DIM}포그라운드 실행: TFX_HUB_PORT=${port} node ${serverPath}${RESET}\n`,
        );
      }
      break;
    }

    case "stop": {
      if (!existsSync(HUB_PID_FILE)) {
        const probed =
          (await probeHubStatus("127.0.0.1", probePort, 1500)) ||
          (probePort === 27888
            ? null
            : await probeHubStatus("127.0.0.1", 27888, 1500));
        if (probed && Number.isFinite(Number(probed.pid))) {
          try {
            process.kill(Number(probed.pid), "SIGTERM");
            console.log(
              `\n  ${GREEN_BRIGHT}✓${RESET} hub 종료됨 (PID ${probed.pid})${DIM} (probe)${RESET}\n`,
            );
            return;
          } catch {}
        }
        console.log(`\n  ${DIM}hub 미실행${RESET}\n`);
        return;
      }
      try {
        const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        process.kill(info.pid, "SIGTERM");
        try {
          unlinkSync(HUB_PID_FILE);
        } catch {}
        console.log(
          `\n  ${GREEN_BRIGHT}✓${RESET} hub 종료됨 (PID ${info.pid})\n`,
        );
      } catch (_e) {
        try {
          unlinkSync(HUB_PID_FILE);
        } catch {}
        console.log(`\n  ${DIM}hub 프로세스 없음 — PID 파일 정리됨${RESET}\n`);
      }
      break;
    }

    case "status": {
      if (!existsSync(HUB_PID_FILE)) {
        const probed = await probeHubStatus();
        if (!probed) {
          const fallback =
            probePort === 27888
              ? null
              : await probeHubStatus("127.0.0.1", 27888, 1500);
          if (fallback) {
            recoverPidFile(fallback, "127.0.0.1");
            if (
              emitHubStatus({
                status: "online",
                source: "default-port-probe",
                url: `http://127.0.0.1:${fallback.port || 27888}/mcp`,
                pid: fallback.pid,
                state: fallback.hub?.state || null,
                sessions: fallback.sessions,
              })
            )
              return;
            console.log(
              `\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET} ${DIM}(default port probe 성공)${RESET}`,
            );
            console.log(
              `    URL:     http://127.0.0.1:${fallback.port || 27888}/mcp`,
            );
            if (fallback.pid !== undefined)
              console.log(`    PID:     ${fallback.pid}`);
            if (fallback.hub?.state)
              console.log(`    State:   ${fallback.hub.state}`);
            if (fallback.sessions !== undefined)
              console.log(`    Sessions: ${fallback.sessions}`);
            console.log("");
            return;
          }
          if (
            emitHubStatus({
              status: "offline",
              source: "probe",
              url: null,
              pid: null,
              state: null,
              sessions: 0,
            })
          )
            return;
          console.log(
            `\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${RED}offline${RESET}\n`,
          );
          return;
        }
        recoverPidFile(probed, "127.0.0.1");
        if (
          emitHubStatus({
            status: "online",
            source: "probe",
            url: `http://127.0.0.1:${probed.port || probePort}/mcp`,
            pid: probed.pid,
            state: probed.hub?.state || null,
            sessions: probed.sessions,
          })
        )
          return;
        console.log(
          `\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET} ${DIM}(pid file 없음 / probe 성공)${RESET}`,
        );
        console.log(
          `    URL:     http://127.0.0.1:${probed.port || probePort}/mcp`,
        );
        if (probed.pid !== undefined) console.log(`    PID:     ${probed.pid}`);
        if (probed.hub?.state) console.log(`    State:   ${probed.hub.state}`);
        if (probed.sessions !== undefined)
          console.log(`    Sessions: ${probed.sessions}`);
        console.log("");
        return;
      }
      try {
        const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        process.kill(info.pid, 0); // 생존 확인
        const uptime = Date.now() - info.started;
        const uptimeStr =
          uptime < 60000
            ? `${Math.round(uptime / 1000)}초`
            : uptime < 3600000
              ? `${Math.round(uptime / 60000)}분`
              : `${Math.round(uptime / 3600000)}시간`;

        let data = null;
        try {
          const host = typeof info.host === "string" ? info.host : "127.0.0.1";
          const port = Number(info.port) || probePort;
          data = await probeHubStatus(host, port, 3000);
        } catch {}

        if (
          emitHubStatus({
            status: "online",
            source: "pid-file",
            url: info.url,
            pid: info.pid,
            uptime_ms: uptime,
            state: data?.hub?.state || null,
            sessions: data?.sessions,
          })
        )
          return;
        console.log(
          `\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET}`,
        );
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
        try {
          unlinkSync(HUB_PID_FILE);
        } catch {}
        const probed = await probeHubStatus();
        if (!probed) {
          if (
            emitHubStatus({
              status: "offline",
              source: "stale-pid",
              url: null,
              pid: null,
              state: null,
              sessions: 0,
            })
          )
            break;
          console.log(
            `\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${RED}offline${RESET} ${DIM}(stale PID 정리됨)${RESET}\n`,
          );
          break;
        }
        recoverPidFile(probed, "127.0.0.1");
        if (
          emitHubStatus({
            status: "online",
            source: "stale-pid-probe",
            url: `http://127.0.0.1:${probed.port || probePort}/mcp`,
            pid: probed.pid,
            state: probed.hub?.state || null,
            sessions: probed.sessions,
          })
        )
          break;
        console.log(
          `\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET} ${DIM}(stale PID 정리 후 probe 성공)${RESET}`,
        );
        console.log(
          `    URL:     http://127.0.0.1:${probed.port || probePort}/mcp`,
        );
        if (probed.pid !== undefined) console.log(`    PID:     ${probed.pid}`);
        if (probed.hub?.state) console.log(`    State:   ${probed.hub.state}`);
        if (probed.sessions !== undefined)
          console.log(`    Sessions: ${probed.sessions}`);
        console.log("");
      }
      break;
    }

    case "ensure": {
      // 사일런트 idempotent 보장 — 스킬 환경 프로브용.
      // Hub 살아있으면 즉시 종료, 죽어있으면 자동 시작 + ready 대기.
      const portArg = args.indexOf("--port");
      const ensurePort =
        portArg !== -1
          ? args[portArg + 1]
          : process.env.TFX_HUB_PORT || "27888";

      // 1. 이미 healthy?
      const ensureProbed = await probeHubStatus(
        "127.0.0.1",
        Number(ensurePort),
        1500,
      );
      if (ensureProbed?.hub?.state === "healthy") {
        if (json)
          printJson({
            status: "ok",
            pid: ensureProbed.pid,
            port: Number(ensurePort),
          });
        else process.stdout.write("hub: ok\n");
        return;
      }

      // 2. PID 파일 있는데 프로세스 죽었으면 정리
      if (existsSync(HUB_PID_FILE)) {
        try {
          const staleInfo = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
          process.kill(staleInfo.pid, 0);
          // 프로세스 살아있지만 healthy가 아님 — 잠시 더 대기
          const retryDeadline = Date.now() + 3000;
          while (Date.now() < retryDeadline) {
            await new Promise((r) => setTimeout(r, 250));
            const retry = await probeHubStatus(
              "127.0.0.1",
              Number(ensurePort),
              1000,
            );
            if (retry?.hub?.state === "healthy") {
              if (json)
                printJson({
                  status: "ok",
                  pid: retry.pid,
                  port: Number(ensurePort),
                });
              else process.stdout.write("hub: ok\n");
              return;
            }
          }
        } catch {
          try {
            unlinkSync(HUB_PID_FILE);
          } catch {}
        }
      }

      // 3. 시작
      const serverPath = join(PKG_ROOT, "hub", "server.mjs");
      if (!existsSync(serverPath)) {
        if (json) printJson({ status: "error", reason: "server_missing" });
        else process.stderr.write("hub: server.mjs not found\n");
        process.exitCode = 1;
        return;
      }

      if (process.platform === "win32") {
        const child = spawn(
          "cmd.exe",
          ["/c", "start", "/b", "", process.execPath, serverPath],
          {
            env: { ...process.env, TFX_HUB_PORT: String(ensurePort) },
            stdio: "ignore",
            windowsHide: true,
          },
        );
        child.unref();
      } else {
        const child = spawn(process.execPath, [serverPath], {
          env: { ...process.env, TFX_HUB_PORT: String(ensurePort) },
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      }

      // 4. ready 대기 (최대 5초)
      const readyDeadline = Date.now() + 5000;
      while (Date.now() < readyDeadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (existsSync(HUB_PID_FILE)) {
          const readyProbe = await probeHubStatus(
            "127.0.0.1",
            Number(ensurePort),
            1000,
          );
          if (readyProbe?.hub?.state === "healthy") {
            if (json)
              printJson({
                status: "ok",
                pid: readyProbe.pid,
                port: Number(ensurePort),
                started: true,
              });
            else process.stdout.write("hub: started\n");
            return;
          }
        }
      }

      // 5. 타임아웃이지만 프로세스는 기동 중일 수 있음
      if (json) printJson({ status: "starting", port: Number(ensurePort) });
      else process.stdout.write("hub: starting\n");
      break;
    }

    default:
      console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET}\n`);
      console.log(
        `    ${WHITE_BRIGHT}tfx hub start${RESET}    ${GRAY}허브 데몬 시작${RESET}`,
      );
      console.log(
        `    ${DIM}  --port N${RESET}       ${GRAY}포트 지정 (기본 27888)${RESET}`,
      );
      console.log(
        `    ${WHITE_BRIGHT}tfx hub stop${RESET}     ${GRAY}허브 중지${RESET}`,
      );
      console.log(
        `    ${WHITE_BRIGHT}tfx hub status${RESET}   ${GRAY}상태 확인${RESET}`,
      );
      console.log(
        `    ${WHITE_BRIGHT}tfx hub ensure${RESET}   ${GRAY}헬스체크 + 자동 시작 (스킬 프로브용)${RESET}\n`,
      );
  }
}

// ── 메인 ──

function readCliOptionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function parsePositiveIntegerOption(args, name, fallback) {
  const value = readCliOptionValue(args, name);
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createCliError(`${name} 값은 0 이상의 정수여야 합니다`, {
      exitCode: EXIT_ARG_ERROR,
      reason: "argError",
      fix: `${name} ${fallback}`,
    });
  }
  return parsed;
}

async function main() {
  const cmd = NORMALIZED_ARGS[0] || "help";
  const cmdArgs = NORMALIZED_ARGS.slice(1);

  cleanupTmpFiles({
    protectPaths: [process.env.HOME, process.env.USERPROFILE],
  }).catch(() => {});

  switch (cmd) {
    case "setup":
      if (cmdArgs.some(isHelpArg)) {
        printCommandHelp("setup");
        return;
      }
      cmdSetup({
        dryRun: cmdArgs.includes("--dry-run"),
        fromUpdate: cmdArgs.includes("--from-update"),
        enableHubAutostart: cmdArgs.includes("--enable-hub-autostart"),
        mods: cmdArgs.includes("--mods"),
      });
      return;
    case "doctor": {
      if (cmdArgs.some(isHelpArg)) {
        printCommandHelp("doctor");
        return;
      }
      if (cmdArgs.includes("--audit")) {
        const auditScript = join(PKG_ROOT, "scripts", "config-audit.mjs");
        const auditArgs = JSON_OUTPUT ? ["--json"] : [];
        try {
          const out = execFileSync(
            process.execPath,
            [auditScript, ...auditArgs],
            {
              timeout: 15000,
              encoding: "utf8",
              windowsHide: true,
            },
          );
          process.stdout.write(out);
        } catch (e) {
          process.stdout.write(e.stdout || "");
          if (e.stderr) process.stderr.write(e.stderr);
        }
        return;
      }
      if (cmdArgs.includes("--diagnose")) {
        const { diagnose } = await import("../scripts/doctor-diagnose.mjs");
        const result = await diagnose({ json: JSON_OUTPUT });
        if (!JSON_OUTPUT) {
          if (result.ok) {
            console.log(
              `\n  ${GREEN_BRIGHT}✓${RESET} 진단 번들 생성: ${result.zipPath}`,
            );
            console.log(
              `  spawn 이벤트: ${result.traceCount}건, 훅 타이밍: ${result.hookTimingCount}건\n`,
            );
          } else {
            console.log(`\n  ${RED}✗${RESET} 진단 실패: ${result.error}\n`);
          }
        }
        return;
      }
      const fix = cmdArgs.includes("--fix");
      const reset = cmdArgs.includes("--reset");
      const purgeLogs = cmdArgs.includes("--purge-logs");
      const cleanupStaleHubs = cmdArgs.includes("--cleanup-stale-hubs");
      const cleanupStaleTmux = cmdArgs.includes("--cleanup-stale-tmux");
      const cleanupApply = cmdArgs.includes("--apply");
      const cleanupDryRun = cmdArgs.includes("--dry-run") || !cleanupApply;
      if (
        (cleanupStaleHubs || cleanupStaleTmux) &&
        cleanupApply &&
        cmdArgs.includes("--dry-run")
      ) {
        throw createCliError(
          "cleanup 옵션에서는 --dry-run 과 --apply 중 하나만 지정하세요",
          {
            exitCode: EXIT_ARG_ERROR,
            reason: "argError",
            fix: "tfx doctor --cleanup-stale-tmux --dry-run",
          },
        );
      }
      const cleanupStaleTmuxPrefix =
        readCliOptionValue(cmdArgs, "--prefix") || DEFAULT_TMUX_CLEANUP_PREFIX;
      const cleanupStaleTmuxAgeMin = parsePositiveIntegerOption(
        cmdArgs,
        "--age-min",
        DEFAULT_TMUX_CLEANUP_AGE_MIN,
      );
      await cmdDoctor({
        fix,
        reset,
        purgeLogs,
        cleanupStaleHubs,
        cleanupStaleHubsDryRun: cleanupDryRun,
        cleanupStaleHubsApply: cleanupApply,
        cleanupStaleTmux,
        cleanupStaleTmuxDryRun: cleanupDryRun,
        cleanupStaleTmuxApply: cleanupApply,
        cleanupStaleTmuxPrefix,
        cleanupStaleTmuxAgeMin,
        json: JSON_OUTPUT,
      });
      return;
    }
    case "mcp":
      cmdMcp(cmdArgs, { json: JSON_OUTPUT });
      return;
    case "update":
      await cmdUpdate(cmdArgs);
      return;
    case "list":
    case "ls":
      if (cmdArgs.some(isHelpArg)) {
        printCommandHelp("list");
        return;
      }
      cmdList({ json: JSON_OUTPUT });
      return;
    case "hub":
      if (cmdArgs.some(isHelpArg)) {
        printCommandHelp("hub");
        return;
      }
      await cmdHub(cmdArgs, {
        json:
          JSON_OUTPUT && ["status", "ensure"].includes(cmdArgs[0] || "status"),
      });
      return;
    case "cto": {
      if (cmdArgs.some(isHelpArg)) {
        printCommandHelp("cto");
        return;
      }
      const { pathToFileURL } = await import("node:url");
      const { cmdCto } = await import(
        pathToFileURL(join(PKG_ROOT, "cto", "index.mjs")).href
      );
      await cmdCto(cmdArgs, { json: JSON_OUTPUT });
      return;
    }
    case "multi": {
      const subcommand = cmdArgs[0] || "";
      if (cmdArgs.some(isHelpArg)) {
        const { pathToFileURL } = await import("node:url");
        const { renderTeamHelp } = await import(
          pathToFileURL(join(PKG_ROOT, "hub", "team", "cli", "help.mjs")).href
        );
        renderTeamHelp();
        return;
      }
      if (JSON_OUTPUT) process.env.TFX_OUTPUT_JSON = "1";
      else delete process.env.TFX_OUTPUT_JSON;
      if (subcommand !== "status") {
        await checkHubRunning();
      }
      const { pathToFileURL } = await import("node:url");
      const { cmdTeam } = await import(
        pathToFileURL(join(PKG_ROOT, "hub", "team", "cli", "index.mjs")).href
      );
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
    case "synapse": {
      const { cmdSynapseStatus } = await import("../hub/team/synapse-cli.mjs");
      const sub = cmdArgs[0] || "status";
      if (isHelpArg(sub)) {
        printCommandHelp("synapse");
        return;
      }
      if (sub !== "status") {
        throw createCliError(`synapse 서브커맨드 미지원: ${sub}`, {
          exitCode: EXIT_ARG_ERROR,
          reason: "argError",
          fix: "tfx synapse status [--json] [--registry <path>]",
        });
      }
      await cmdSynapseStatus(cmdArgs.slice(1), { json: JSON_OUTPUT });
      return;
    }
    case "why": {
      if (cmdArgs.some(isHelpArg)) {
        printCommandHelp("why");
        return;
      }
      const { cmdSynapseWhy } = await import("../hub/team/synapse-cli.mjs");
      await cmdSynapseWhy(cmdArgs, { json: JSON_OUTPUT });
      return;
    }
    case "version":
    case "--version":
    case "-v":
      if (cmdArgs.some(isHelpArg)) {
        printCommandHelp("version");
        return;
      }
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

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === modulePath;
  } catch {
    return resolve(process.argv[1]) === modulePath;
  }
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    handleFatalError(error, { json: JSON_OUTPUT });
  }
}
