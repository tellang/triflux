#!/usr/bin/env node

// remote-spawn.mjs — 로컬/원격 Claude 세션 실행 유틸리티
//
// Usage:
//   node remote-spawn.mjs --local [--dir <path>] [--prompt "..."] [--handoff <file>] [--transfer <file>]
//   node remote-spawn.mjs --host <ssh-host> [--dir <path>] [--prompt "..."] [--handoff <file>] [--transfer <file>]
//   node remote-spawn.mjs --send <session> "prompt"
//   node remote-spawn.mjs --list
//   node remote-spawn.mjs --attach <session>
//   node remote-spawn.mjs --probe <ssh-host>

import { execFileSync, execSync } from "child_process";
import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { platform as getPlatform, homedir, tmpdir } from "os";
import {
  basename,
  join,
  posix as posixPath,
  resolve,
  win32 as win32Path,
} from "path";
import { fileURLToPath } from "url";
import { readHost, readHosts } from "../hub/lib/hosts-compat.mjs";
import { spawn } from "../hub/lib/spawn-trace.mjs";
import {
  attachPsmuxSession,
  capturePsmuxPane,
  createPsmuxSession,
  hasPsmux,
  killPsmuxSession,
  listPsmuxSessions,
  psmuxExec,
  psmuxSessionExists,
  sendKeysToPane,
  startCapture,
  waitForPattern,
} from "../hub/team/psmux.mjs";

const MAX_HANDOFF_BYTES = 1 * 1024 * 1024; // 1 MB
const REMOTE_ENV_TTL_MS = 86_400_000;
const REMOTE_ENV_CACHE_DIR = resolve(".omc", "state", "remote-env");
const REMOTE_STAGE_ROOT = "tfx-remote";
const SSH_PROMPT_PATTERN = /(\$|%|#|PS |>)\s*$/;
const IS_WINDOWS_LOCAL = getPlatform() === "win32";
const SELF_SCRIPT_PATH = fileURLToPath(import.meta.url);

const DEFAULT_CLEANUP_WATCH_POLL_MS = 1000;
const DEFAULT_CLEANUP_WATCH_GRACE_MS = 1500;
const DEFAULT_CLEANUP_WATCH_MAX_MS = 60 * 60 * 1000;

const SAFE_HOST_RE = /^[a-zA-Z0-9._-]+$/;
const SAFE_DIR_RE = /^[a-zA-Z0-9_.~/:-]+$/;

// --- 화면 상태 판별 / 수명주기 (PRD: remote-session-lifecycle) ---
const CLAUDE_SCREEN_HOME = "home";
const CLAUDE_SCREEN_REPL = "repl";
const CLAUDE_SCREEN_TRUST = "trust_prompt";
const CLAUDE_SCREEN_NEEDS_INPUT = "needs_input";
const CLAUDE_SCREEN_BUSY = "busy";
const CLAUDE_SCREEN_UNKNOWN = "unknown";

const CLAUDE_HOME_SIGNAL = /describe a task for a new session/i;
const CLAUDE_TRUST_SIGNAL = /is this a project you created/i;
const CLAUDE_BUSY_SIGNAL = /esc to interrupt/i;
const CLAUDE_NEEDS_INPUT_SIGNAL = /needs input/i;
const CLAUDE_REPL_SIGNALS = [
  /\? for shortcuts/i,
  /bypass permissions/i,
  /shift\+tab to cycle/i,
];
const CLAUDE_REPL_LAST_LINE = /(❯|➕|>\s*$)/u;

const DEFAULT_SCREEN_WAIT_POLL_MS = 1000;
const DEFAULT_MONITOR_POLL_MS = 2000;
const DEFAULT_MONITOR_MAX_MS = 12 * 60 * 60 * 1000;
const DEFAULT_STALL_THRESHOLD_SEC = 1200;
const MONITOR_EVENT_PREFIX = "TFX_REMOTE_EVENT";
const KILL_READBACK_RETRY_DELAY_MS = 5000;
const REMOTE_ACTIONABLE_STATES = new Set([
  CLAUDE_SCREEN_NEEDS_INPUT,
  CLAUDE_SCREEN_TRUST,
]);
const SAFE_REMOTE_BIN_DIR_RE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const SPAWN_SESSION_PREFIX = "tfx-spawn-";

function validateHost(host) {
  if (!SAFE_HOST_RE.test(host)) {
    console.error(`invalid host name: ${host}`);
    process.exit(1);
  }
  return host;
}

function validateDir(dir) {
  if (!SAFE_DIR_RE.test(dir)) {
    console.error(`invalid directory path: ${dir}`);
    process.exit(1);
  }
  return dir;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapePwshSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function escapePwshDoubleQuoted(value) {
  return String(value).replace(/`/g, "``").replace(/"/g, '`"');
}

function normalizeCommandPath(value) {
  return String(value).replace(/\\/g, "/");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function sleepMsAsync(ms) {
  return new Promise((resolveSleep) =>
    setTimeout(resolveSleep, Math.max(0, ms)),
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildPwshExitTail() {
  return "$trifluxExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }; exit $trifluxExit";
}

export function buildPosixExitTail() {
  return "exit $?";
}

export function buildRemoteBootstrapCommand(host) {
  return `ssh -t ${host}; ${buildPwshExitTail()}`;
}

export function buildLocalClaudeCommand(claudePathNorm, permissionFlags = "") {
  // try/finally: Ctrl+C로 Claude 종료해도 shell이 자동 exit
  return `try { & '${escapePwshSingleQuoted(claudePathNorm)}'${permissionFlags ? ` ${permissionFlags}` : ""} } finally { exit }`;
}

export function buildRemoteClaudeCommand(env, permissionFlags = "") {
  if (env.shell === "pwsh") {
    return `try { & "${escapePwshDoubleQuoted(env.claudePath)}"${permissionFlags ? ` ${permissionFlags}` : ""} } finally { exit }`;
  }
  return `${shellQuote(env.claudePath)}${permissionFlags ? ` ${permissionFlags}` : ""}; ${buildPosixExitTail()}`;
}

export function resolveCleanupWatcherTimingOptions(
  source = {},
  env = process.env,
) {
  return Object.freeze({
    graceMs: parsePositiveInt(
      source.graceMs ?? env.TFX_SPAWN_CLEANUP_GRACE_MS,
      DEFAULT_CLEANUP_WATCH_GRACE_MS,
    ),
    maxMs: parsePositiveInt(
      source.maxMs ?? env.TFX_SPAWN_CLEANUP_MAX_MS,
      DEFAULT_CLEANUP_WATCH_MAX_MS,
    ),
    pollMs: parsePositiveInt(
      source.pollMs ?? env.TFX_SPAWN_CLEANUP_POLL_MS,
      DEFAULT_CLEANUP_WATCH_POLL_MS,
    ),
  });
}

export function buildSpawnCleanupWatcherArgs(
  sessionName,
  paneId,
  timingOptions = {},
) {
  const timings = resolveCleanupWatcherTimingOptions(timingOptions);
  return [
    SELF_SCRIPT_PATH,
    "--watch-cleanup",
    sessionName,
    "--pane",
    paneId,
    "--poll-ms",
    String(timings.pollMs),
    "--grace-ms",
    String(timings.graceMs),
    "--max-ms",
    String(timings.maxMs),
  ];
}

/** 문자열을 psmux 세션명에 안전한 slug로 변환 */
function toSlug(raw) {
  return raw
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 24);
}

/** 세션 이름용 slug 생성: --name > git branch > random UUID */
function buildSessionSlug(customName) {
  if (customName) return toSlug(customName);
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch) {
      // feature/swarm-hypervisor → swarm-hypervisor
      const stripped = branch.includes("/")
        ? branch.split("/").slice(1).join("-")
        : branch;
      const slug = toSlug(stripped);
      if (slug) return slug;
    }
  } catch {
    /* git not available */
  }
  return randomUUID().slice(0, 8);
}

/** 같은 slug의 세션이 이미 존재하면 -2, -3 ... 카운터 추가 */
function deduplicateSessionName(baseName) {
  try {
    const existing = listPsmuxSessions();
    if (!existing.includes(baseName)) return baseName;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${baseName}-${i}`;
      if (!existing.includes(candidate)) return candidate;
    }
  } catch {
    /* psmux not available */
  }
  return `${baseName}-${randomUUID().slice(0, 4)}`;
}

function usageText() {
  return `Usage:
  remote-spawn --local [--dir <path>] [--prompt "task"] [--name <slug>] [--handoff <file>] [--transfer <file>]
  remote-spawn --host <ssh-host> [--dir <path>] [--prompt "task"] [--name <slug>] [--handoff <file>] [--transfer <file>]
  remote-spawn --send <session> "prompt"
  remote-spawn --list
  remote-spawn --attach <session>
  remote-spawn --probe <ssh-host>

Options:
  --local          로컬 WT 탭에서 Claude 실행
  --host <name>    SSH 호스트로 원격 Claude 실행
  --dir <path>     작업 디렉토리 (기본: 현재 디렉토리 / 원격 홈)
  --prompt "..."   Claude에 전달할 첫 메시지
  --name <slug>    세션/탭 이름 (기본: git branch명)
  --handoff <file> 핸드오프 파일 경로 (prompt와 결합 가능)
  --transfer <file> 원격 스테이징할 추가 파일 (반복 지정 가능)
  --send <session> 실행 중인 세션에 프롬프트 전송
  --list           tfx-spawn-* psmux 세션 목록
  --attach <name>  WT 새 탭에서 세션 attach
  --probe <host>   SSH 원격 환경 강제 프로브 + 캐시 갱신
  --capture <name> 세션 pane 내용 캡처 출력
  --wait <name>    세션의 Claude 준비 완료 대기 (기본 60초)
  --monitor <name> 화면 상태 폴링 — stall/needs_input/trust 구조화 보고
  --kill <name>    로컬 세션 종료 + 원격 claude daemon 정리 + readback
  --auto-trust     trust 화면 감지 시 Enter 자동 응대 (기본 off)
  --no-attach      spawn 후 자동 attach 생략`;
}

function parseArgs(argv) {
  let command = "spawn";
  let host = null;
  let dir = null;
  let prompt = null;
  let handoff = null;
  const transferFiles = [];
  let local = false;
  let spawnName = null;
  let sessionName = null;
  let probeHost = null;
  let watchPane = null;
  let watchGraceMs = null;
  let watchPollMs = null;
  let watchMaxMs = null;
  let autoTrust = false;
  let attach = true;
  const promptParts = [];

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--local") {
      local = true;
      continue;
    }
    if (arg === "--auto-trust") {
      autoTrust = true;
      continue;
    }
    if (arg === "--no-attach") {
      attach = false;
      continue;
    }
    if (arg === "--kill" && argv[index + 1]) {
      command = "kill";
      sessionName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--monitor" && argv[index + 1]) {
      command = "monitor";
      sessionName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--host" && argv[index + 1]) {
      host = validateHost(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--dir" && argv[index + 1]) {
      dir = validateDir(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--prompt" && argv[index + 1]) {
      prompt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--handoff" && argv[index + 1]) {
      handoff = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--transfer" && argv[index + 1]) {
      transferFiles.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--name" && argv[index + 1]) {
      spawnName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--send" && argv[index + 1]) {
      command = "send";
      sessionName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--list") {
      command = "list";
      continue;
    }
    if (arg === "--attach" && argv[index + 1]) {
      command = "attach";
      sessionName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--probe" && argv[index + 1]) {
      command = "probe";
      probeHost = validateHost(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--capture" && argv[index + 1]) {
      command = "capture";
      sessionName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--wait" && argv[index + 1]) {
      command = "wait";
      sessionName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--watch-cleanup" && argv[index + 1]) {
      command = "watch-cleanup";
      sessionName = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--pane" && argv[index + 1]) {
      watchPane = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--grace-ms" && argv[index + 1]) {
      watchGraceMs = parsePositiveInt(argv[index + 1], null);
      index += 1;
      continue;
    }
    if (arg === "--poll-ms" && argv[index + 1]) {
      watchPollMs = parsePositiveInt(argv[index + 1], null);
      index += 1;
      continue;
    }
    if (arg === "--max-ms" && argv[index + 1]) {
      watchMaxMs = parsePositiveInt(argv[index + 1], null);
      index += 1;
      continue;
    }

    promptParts.push(arg);
  }

  const mergedPrompt =
    prompt ?? (promptParts.length > 0 ? promptParts.join(" ") : null);
  return {
    attach,
    autoTrust,
    command,
    dir,
    handoff,
    host,
    local,
    probeHost,
    prompt: mergedPrompt,
    sessionName,
    spawnName,
    transferFiles,
    watchGraceMs,
    watchMaxMs,
    watchPane,
    watchPollMs,
  };
}

function parseVersion(versionStr) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionStr);
  if (!match) return null;
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
  ];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function probeVersion(binPath) {
  try {
    if (/\.(cmd|bat)$/iu.test(binPath)) {
      // .cmd/.bat → execSync로 shell 경유 (execFileSync EINVAL 회피)
      const out = execSync(`"${binPath}" --version`, {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parseVersion(out);
    }
    const out = execFileSync(binPath, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

function detectClaudePath() {
  if (process.env.CLAUDE_BIN_PATH) return process.env.CLAUDE_BIN_PATH;

  const candidates = [];

  const wingetPath = join(
    homedir(),
    "AppData",
    "Local",
    "Microsoft",
    "WinGet",
    "Links",
    "claude.exe",
  );
  if (existsSync(wingetPath)) candidates.push(wingetPath);

  const npmPath = join(process.env.APPDATA || "", "npm", "claude.cmd");
  if (existsSync(npmPath)) candidates.push(npmPath);

  try {
    const command = IS_WINDOWS_LOCAL ? "where" : "which";
    const result = execFileSync(command, ["claude"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (result) {
      for (const line of result.split(/\r?\n/u)) {
        const p = line.trim();
        if (p && !candidates.includes(p)) candidates.push(p);
      }
    }
  } catch {
    // not found
  }

  if (candidates.length === 0) return "claude";

  let bestPath = candidates[0];
  let bestVersion = probeVersion(candidates[0]);

  for (const candidate of candidates.slice(1)) {
    const ver = probeVersion(candidate);
    if (ver === null) continue;
    if (bestVersion === null || compareVersions(ver, bestVersion) > 0) {
      bestVersion = ver;
      bestPath = candidate;
    }
  }

  return bestPath;
}

function getPermissionFlag() {
  return process.env.TFX_CLAUDE_SAFE_MODE === "1"
    ? []
    : ["--dangerously-skip-permissions"];
}

function failFast(message) {
  console.error(message);
  process.exit(1);
}

function validateTransferCandidate(pathLike, label) {
  const localPath = resolve(pathLike);
  if (!existsSync(localPath)) {
    failFast(`${label} not found: ${localPath}`);
  }

  // 프로젝트 디렉토리 외부 파일 전송 방지
  const projectRoot = process.cwd();
  if (!localPath.startsWith(projectRoot)) {
    failFast(`${label} must be within project directory: ${localPath}`);
  }

  const size = statSync(localPath).size;
  if (size > MAX_HANDOFF_BYTES) {
    failFast(`${label} too large: ${size} bytes (max ${MAX_HANDOFF_BYTES})`);
  }

  return {
    inputPath: pathLike,
    localPath,
    size,
  };
}

function dedupeTransferCandidates(candidates) {
  const byPath = new Map();
  for (const candidate of candidates) {
    if (!byPath.has(candidate.localPath)) {
      byPath.set(candidate.localPath, candidate);
    }
  }
  return [...byPath.values()];
}

function buildPromptContext(args, options = {}) {
  const includeTransferFiles = options.includeTransferFiles === true;
  const candidates = [];
  let content = "";

  if (args.handoff) {
    const handoffCandidate = validateTransferCandidate(
      args.handoff,
      "handoff file",
    );
    content = readFileSync(handoffCandidate.localPath, "utf8").trim();
    candidates.push(handoffCandidate);
  }

  if (includeTransferFiles) {
    for (const filePath of args.transferFiles || []) {
      candidates.push(validateTransferCandidate(filePath, "transfer file"));
    }
  }

  if (args.prompt) {
    content = content ? `${content}\n\n---\n\n${args.prompt}` : args.prompt;
  }

  return {
    prompt: content,
    transferCandidates: dedupeTransferCandidates(candidates),
  };
}

function buildLocalPathVariants(pathLike) {
  const resolvedPath = resolve(pathLike);
  const variants = new Set([
    pathLike,
    resolvedPath,
    normalizeCommandPath(pathLike),
    normalizeCommandPath(resolvedPath),
    pathLike.replace(/\//g, "\\"),
    resolvedPath.replace(/\//g, "\\"),
  ]);

  return [...variants]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 2);
}

function rewritePromptPaths(prompt, stagedFiles) {
  if (!prompt || stagedFiles.length === 0) {
    return prompt;
  }

  const replacements = [];
  for (const file of stagedFiles) {
    for (const variant of buildLocalPathVariants(file.inputPath)) {
      replacements.push({ from: variant, to: file.remotePath });
    }
    for (const variant of buildLocalPathVariants(file.localPath)) {
      replacements.push({ from: variant, to: file.remotePath });
    }
  }

  replacements.sort((a, b) => b.from.length - a.from.length);

  let rewritten = prompt;
  for (const replacement of replacements) {
    if (rewritten.includes(replacement.from)) {
      rewritten = rewritten.split(replacement.from).join(replacement.to);
    }
  }

  return rewritten;
}

async function spawnLocalFallback(args, claudePath, prompt) {
  const dir = args.dir ? resolve(args.dir) : process.cwd();

  if (!IS_WINDOWS_LOCAL) {
    const cliArgs = [...getPermissionFlag()];
    if (prompt) cliArgs.push(prompt);

    const child = spawn(claudePath, cliArgs, {
      cwd: dir,
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code || 0));
    return;
  }

  const claudeForward = claudePath.replace(/\\/g, "/");
  let command;

  if (prompt) {
    const psQuoted = `'${prompt.replace(/'/g, "''")}'`;
    command = `pwsh -NoProfile -Command "& '${claudeForward}' ${getPermissionFlag().join(" ")} ${psQuoted}"`;
  } else {
    command = `${claudeForward} ${getPermissionFlag().join(" ")}`;
  }

  try {
    const wt = (await import("../hub/team/wt-manager.mjs")).createWtManager();
    await wt.createTab({ title: "Claude", command, cwd: dir });
    console.log(`spawned local Claude in WT tab → ${dir}`);
  } catch (error) {
    console.error("wt.exe spawn failed:", error.message);
    process.exit(1);
  }
}

async function spawnRemoteFallback(args, promptContext) {
  const { host } = args;
  if (!host) {
    console.error("--host required for remote spawn");
    process.exit(1);
  }

  const dir = args.dir || "~";
  const permFlags = getPermissionFlag();
  let prompt = promptContext.prompt;

  let remoteHome;
  try {
    remoteHome = execFileSync("ssh", [host, "echo", "$env:USERPROFILE"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    try {
      remoteHome = execFileSync("ssh", [host, "echo", "$HOME"], {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch {
      // 원격 홈 감지 실패 시 transfer 기능을 사용할 수 없음
      console.warn(
        `[tfx] 원격 홈 디렉토리 감지 실패 (${host}) — file transfer 비활성화`,
      );
      remoteHome = null;
    }
  }

  if (remoteHome) {
    try {
      const fallbackEnv = { home: remoteHome, os: "win32", shell: "pwsh" };
      const stageId = `spawn-${randomUUID().slice(0, 8)}`;
      const { stagedFiles } = stageRemotePromptFiles(
        host,
        fallbackEnv,
        promptContext.transferCandidates,
        stageId,
      );
      prompt = rewritePromptPaths(prompt, stagedFiles);
    } catch (error) {
      failFast(
        `failed to stage remote files: ${error?.message || String(error)}`,
      );
    }
  } else if (promptContext.transferCandidates.length > 0) {
    console.warn("[tfx] 원격 홈 미감지 — --transfer 파일이 무시됩니다");
  }

  const scriptLines = [`cd '${dir.replace(/'/g, "''")}'`];

  if (prompt) {
    const safePrompt = prompt.replace(/'/g, "''");
    scriptLines.push(
      `& "$env:USERPROFILE\\.local\\bin\\claude.exe" ${permFlags.join(" ")} '${safePrompt}'`,
    );
  } else {
    scriptLines.push(
      `& "$env:USERPROFILE\\.local\\bin\\claude.exe" ${permFlags.join(" ")}`,
    );
  }

  const scriptContent = scriptLines.join("\n");
  const localScript = join(tmpdir(), "tfx-remote-spawn.ps1");
  writeFileSync(localScript, scriptContent, "utf8");

  try {
    execFileSync("scp", [localScript, `${host}:tfx-remote-spawn.ps1`], {
      timeout: 10000,
      stdio: "pipe",
    });
  } catch (error) {
    console.error("failed to copy script to remote:", error.message);
    process.exit(1);
  }

  const remoteScript = `${remoteHome.replace(/\\/g, "/")}/tfx-remote-spawn.ps1`;
  const remoteCmd = `pwsh -NoExit -File ${remoteScript}`;

  if (IS_WINDOWS_LOCAL) {
    try {
      const wt = (await import("../hub/team/wt-manager.mjs")).createWtManager();
      await wt.createTab({
        title: `Claude@${host}`,
        command: `ssh -t -- ${host} ${remoteCmd}`,
      });
      console.log(`spawned remote Claude → ${host}:${dir}`);
    } catch (error) {
      console.error("wt.exe spawn failed:", error.message);
      process.exit(1);
    }
  } else {
    const child = spawn("ssh", ["-t", "--", host, remoteCmd], {
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code || 0));
  }
}

function shouldUsePsmux() {
  return IS_WINDOWS_LOCAL && hasPsmux();
}

function requirePsmux() {
  if (!hasPsmux()) {
    throw new Error("psmux is required for this command");
  }
}

function parseProbeLines(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return separatorIndex === -1
          ? null
          : [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      })
      .filter(Boolean),
  );
}

function normalizePwshProbeEnv(host, parsed) {
  if (parsed.shell !== "pwsh" || parsed.os !== "win32") {
    return null;
  }

  if (!parsed.home) {
    return null;
  }

  return Object.freeze({
    claudePath:
      !parsed.claude || parsed.claude === "notfound" ? null : parsed.claude,
    home: parsed.home,
    os: "win32",
    shell: "pwsh",
  });
}

function normalizePosixProbeEnv(host, parsed) {
  const os =
    parsed.os === "darwin" ? "darwin" : parsed.os === "linux" ? "linux" : null;
  if (!os || !parsed.home) {
    return null;
  }

  return Object.freeze({
    claudePath:
      !parsed.claude || parsed.claude === "notfound" ? null : parsed.claude,
    home: parsed.home,
    os,
    shell: parsed.shell === "zsh" ? "zsh" : "bash",
  });
}

function getRemoteEnvCachePath(host) {
  return join(REMOTE_ENV_CACHE_DIR, `${host}.json`);
}

function readRemoteEnvCache(host) {
  const cachePath = getRemoteEnvCachePath(host);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isRemoteEnvCacheFresh(cacheEntry) {
  return Boolean(
    cacheEntry &&
      typeof cacheEntry.cachedAt === "number" &&
      cacheEntry.env &&
      Date.now() - cacheEntry.cachedAt < REMOTE_ENV_TTL_MS,
  );
}

function writeRemoteEnvCache(host, env) {
  mkdirSync(REMOTE_ENV_CACHE_DIR, { recursive: true });
  writeFileSync(
    getRemoteEnvCachePath(host),
    JSON.stringify({ cachedAt: Date.now(), env }, null, 2),
    "utf8",
  );
}

function probeRemoteEnvViaPwsh(host) {
  const command = [
    "Write-Output 'shell=pwsh'",
    'Write-Output "home=$env:USERPROFILE"',
    'if (Test-Path "$env:USERPROFILE\\.local\\bin\\claude.exe") { Write-Output "claude=$env:USERPROFILE\\.local\\bin\\claude.exe" } elseif (Get-Command claude -ErrorAction SilentlyContinue) { Write-Output "claude=$((Get-Command claude).Source)" } else { Write-Output \'claude=notfound\' }',
    "Write-Output \"os=$([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) ? 'win32' : 'other')\"",
  ].join("; ");

  let output;
  try {
    output = execFileSync(
      "ssh",
      [host, "pwsh", "-NoProfile", "-Command", command],
      { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    return null;
  }

  return normalizePwshProbeEnv(host, parseProbeLines(output));
}

function probeRemoteEnvViaPosix(host) {
  const script = [
    "echo shell=$(basename $SHELL)",
    "echo home=$HOME",
    "command -v claude >/dev/null 2>&1 && echo claude=$(command -v claude) || echo claude=notfound",
    "echo os=$(uname -s | tr A-Z a-z)",
  ].join("\n");

  let output;
  try {
    output = execFileSync("ssh", [host, "sh"], {
      encoding: "utf8",
      timeout: 15000,
      input: script,
    });
  } catch {
    return null;
  }

  return normalizePosixProbeEnv(host, parseProbeLines(output));
}

function probeRemoteEnv(host, opts = {}) {
  const force = opts.force === true;

  if (!force) {
    const cached = readRemoteEnvCache(host);
    if (isRemoteEnvCacheFresh(cached)) {
      return cached.env;
    }
  }

  const pwshEnv = probeRemoteEnvViaPwsh(host);
  if (pwshEnv) {
    writeRemoteEnvCache(host, pwshEnv);
    return pwshEnv;
  }

  const posixEnv = probeRemoteEnvViaPosix(host);
  if (posixEnv) {
    writeRemoteEnvCache(host, posixEnv);
    return posixEnv;
  }

  throw new Error(`remote probe failed for ${host}`);
}

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function resolveRemoteDir(dir, env) {
  const requestedDir = dir || env.home;

  if (env.os === "win32") {
    const winDir = requestedDir.replace(/\//g, "\\");
    if (winDir === "~") return env.home;
    if (/^~[\\/]/u.test(winDir))
      return win32Path.join(env.home, winDir.slice(2));
    if (isWindowsAbsolutePath(winDir)) return winDir;
    return win32Path.join(env.home, winDir);
  }

  if (requestedDir === "~") return env.home;
  if (requestedDir.startsWith("~/"))
    return posixPath.join(env.home, requestedDir.slice(2));
  if (requestedDir.startsWith("/")) return requestedDir;
  return posixPath.join(env.home, requestedDir);
}

/**
 * hosts.json capabilities_v2 의 실행파일 경로에서 PATH prefix 후보 디렉터리를 뽑는다.
 * 비로그인 ssh 에는 nvm PATH 가 없어 `#!/usr/bin/env node` 셔뱅이 실패하므로,
 * claude 바이너리가 있는 디렉터리를 PATH 앞에 붙여야 한다.
 * darwin/linux 호스트만 대상이며 경로 하드코딩은 하지 않는다.
 * @param {object|null} host hosts-compat 가 정규화한 호스트 객체
 * @returns {string[]}
 */
export function collectRemoteBinDirs(host) {
  if (!host || typeof host !== "object") return [];
  if (host.os !== "darwin" && host.os !== "linux") return [];

  const rawCapabilities = host.raw?.capabilities_v2;
  if (!rawCapabilities || typeof rawCapabilities !== "object") return [];

  const orderedValues = [
    rawCapabilities.claude,
    ...Object.entries(rawCapabilities)
      .filter(([key]) => key !== "claude")
      .map(([, value]) => value),
  ];

  const dirs = [];
  for (const value of orderedValues) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) continue;
    const dir = posixPath.dirname(trimmed);
    if (dir === "." || dir === "/") continue;
    if (!SAFE_REMOTE_BIN_DIR_RE.test(dir)) continue;
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** hosts-compat 해석 결과에서 원격 PATH prefix 디렉터리를 얻는다. */
export function resolveRemoteBinDirs(hostName, options = {}) {
  const readHostFn =
    typeof options.readHost === "function" ? options.readHost : readHost;
  try {
    return collectRemoteBinDirs(readHostFn(hostName));
  } catch {
    return [];
  }
}

/** hosts-compat 해석 결과에서 원격 claude 실행 경로를 얻는다. */
export function resolveRemoteClaudePath(hostName, options = {}) {
  const readHostFn =
    typeof options.readHost === "function" ? options.readHost : readHost;
  try {
    const host = readHostFn(hostName);
    const configured = host?.raw?.capabilities_v2?.claude;
    return typeof configured === "string" && configured.trim()
      ? configured.trim()
      : null;
  } catch {
    return null;
  }
}

/** PATH prefix export 구문. 디렉터리가 없으면 빈 문자열. */
export function buildRemotePathExportCommand(binDirs = []) {
  const dirs = (Array.isArray(binDirs) ? binDirs : []).filter(
    (dir) => typeof dir === "string" && SAFE_REMOTE_BIN_DIR_RE.test(dir),
  );
  if (dirs.length === 0) return "";
  return `export PATH=${dirs.map((dir) => shellQuote(dir)).join(":")}:"$PATH"`;
}

/**
 * posix 원격 세션에 순서대로 보낼 명령 목록.
 * PATH prefix → cd → claude 실행 순서다.
 * @returns {string[]}
 */
export function buildRemotePosixSpawnCommands(spec = {}) {
  const {
    binDirs = [],
    claudePath,
    dir,
    permissionFlags = "",
    promptFile = null,
  } = spec;
  if (!claudePath) {
    throw new Error("buildRemotePosixSpawnCommands requires claudePath");
  }

  const commands = [];
  const pathExport = buildRemotePathExportCommand(binDirs);
  if (pathExport) commands.push(pathExport);
  if (dir) commands.push(`cd ${shellQuote(dir)}`);

  const flags = permissionFlags ? ` ${permissionFlags}` : "";
  if (promptFile) {
    commands.push(
      `${shellQuote(claudePath)}${flags} < ${shellQuote(promptFile)} && rm -f ${shellQuote(promptFile)}; ${buildPosixExitTail()}`,
    );
  } else {
    commands.push(`${shellQuote(claudePath)}${flags}; ${buildPosixExitTail()}`);
  }
  return commands;
}

/**
 * spawn 진입점의 레인 선택.
 * Windows 는 기존 psmux 레인을 그대로 유지하고, darwin/linux 는 tmux 가 있고
 * 원격이 posix 일 때만 tmux 레인을 탄다. 그 외는 모두 기존 fallback 이다.
 * @returns {"psmux"|"tmux"|"fallback"}
 */
export function resolveSpawnLane(options = {}) {
  const platform = options.platform ?? getPlatform();
  const multiplexerAvailable = options.multiplexerAvailable === true;

  if (platform === "win32") {
    return multiplexerAvailable ? "psmux" : "fallback";
  }
  if (platform !== "darwin" && platform !== "linux") return "fallback";
  if (!multiplexerAvailable) return "fallback";
  if (options.remoteOs !== "darwin" && options.remoteOs !== "linux") {
    return "fallback";
  }
  return "tmux";
}

/** detached tmux 세션 생성 인자. pane 이 곧바로 command 를 실행한다. */
export function buildTmuxSpawnSessionArgs(sessionName, command) {
  return ["new-session", "-d", "-s", sessionName, command];
}

/**
 * tmux pane 이 실행할 명령. 원격 posix 스크립트를 통째로 `ssh -t` 에 넘긴다.
 * 비로그인 ssh 라 PATH prefix 가 스크립트 첫 줄에 있어야 셔뱅이 산다.
 */
export function buildTmuxRemoteLaneCommand(host, remoteCommands = []) {
  const script = (Array.isArray(remoteCommands) ? remoteCommands : [])
    .filter(Boolean)
    .join("\n");
  if (!script) {
    throw new Error("buildTmuxRemoteLaneCommand requires remote commands");
  }
  return `ssh -t ${host} ${shellQuote(script)}`;
}

function resolveRemoteStageDir(env, stageId) {
  const normalizedHome = normalizeCommandPath(env.home);
  return `${normalizedHome}/${REMOTE_STAGE_ROOT}/${stageId}`;
}

function ensureRemoteStageDir(host, env, remoteStageDir) {
  if (env.os === "win32") {
    const safePath = escapePwshSingleQuoted(remoteStageDir);
    const command = `New-Item -ItemType Directory -Path '${safePath}' -Force | Out-Null`;
    execFileSync("ssh", [host, "pwsh", "-NoProfile", "-Command", command], {
      timeout: 10000,
      stdio: "pipe",
    });
    return;
  }

  execFileSync(
    "ssh",
    [host, "sh", "-lc", `mkdir -p ${shellQuote(remoteStageDir)}`],
    {
      timeout: 10000,
      stdio: "pipe",
    },
  );
}

function uploadFileToRemote(host, localPath, remotePath) {
  // scp는 remote path를 셸 확장 없이 직접 전달 — shellQuote 불필요
  // Windows 원격에서 쿼트가 리터럴 문자로 해석되어 경로 오류 발생
  execFileSync("scp", [localPath, `${host}:${remotePath}`], {
    timeout: 15000,
    stdio: "pipe",
  });
}

function stageRemotePromptFiles(host, env, transferCandidates, stageId) {
  if (!transferCandidates || transferCandidates.length === 0) {
    return { remoteStageDir: null, stagedFiles: [] };
  }

  const remoteStageDir = resolveRemoteStageDir(env, stageId);
  ensureRemoteStageDir(host, env, remoteStageDir);

  const basenameCounts = new Map();
  const stagedFiles = transferCandidates.map((candidate) => {
    const fileName = basename(candidate.localPath);
    const count = (basenameCounts.get(fileName) || 0) + 1;
    basenameCounts.set(fileName, count);
    const stagedName = count === 1 ? fileName : `${count}-${fileName}`;
    const remotePath = `${remoteStageDir}/${stagedName}`;
    uploadFileToRemote(host, candidate.localPath, remotePath);
    return {
      ...candidate,
      remotePath,
    };
  });

  return { remoteStageDir, stagedFiles };
}

/**
 * 프롬프트를 원격 스테이지 디렉터리에 파일로 올린다.
 * send-keys 로 긴 프롬프트를 보내면 깨지므로 파일 리다이렉트로 전달한다.
 * @returns {string|null} 원격 프롬프트 파일 경로 (프롬프트가 없으면 null)
 */
function uploadRemotePromptFile(host, env, stageId, prompt) {
  if (!prompt) return null;

  const stageDir = resolveRemoteStageDir(env, stageId);
  ensureRemoteStageDir(host, env, stageDir);

  const localPromptFile = join(
    tmpdir(),
    `tfx-prompt-${randomUUID().slice(0, 8)}.md`,
  );
  writeFileSync(localPromptFile, prompt, { encoding: "utf8" });
  const remotePromptFile = `${stageDir}/prompt.md`;
  uploadFileToRemote(host, localPromptFile, remotePromptFile);
  try {
    unlinkSync(localPromptFile);
  } catch {
    /* cleanup best-effort */
  }
  return remotePromptFile;
}

function listSessionNamesFromRawOutput(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(":")[0]?.trim())
    .filter(Boolean);
}

function listSpawnSessions() {
  const helperSessions = listPsmuxSessions().filter((name) =>
    name.startsWith("tfx-spawn-"),
  );
  if (helperSessions.length > 0) {
    return helperSessions;
  }

  try {
    return listSessionNamesFromRawOutput(psmuxExec(["list-sessions"])).filter(
      (name) => name.startsWith("tfx-spawn-"),
    );
  } catch {
    return [];
  }
}

async function openAttachTab(sessionName, title = null) {
  if (IS_WINDOWS_LOCAL) {
    const _wtArgs = title;
    try {
      const wt = (await import("../hub/team/wt-manager.mjs")).createWtManager();
      await wt.createTab({
        title: title || sessionName,
        command: `psmux attach -t ${sessionName}`,
      });
    } catch {
      /* fallback below */
    }
    return;
  }

  attachPsmuxSession(sessionName);
}

/**
 * 현재 tmux 창을 분할해 세션에 붙일 때 쓰는 인자.
 * 중첩 attach 를 막으려고 `env -u TMUX` 로 TMUX 를 제거한다.
 */
export function buildTmuxAttachSplitArgs(sessionName) {
  return [
    "split-window",
    `env -u TMUX tmux attach -t ${shellQuote(sessionName)}`,
  ];
}

/**
 * spawn 직후 자동 attach. 리드가 tmux 안이면 현재 창을 분할하고,
 * 아니면 기존 탭 attach 경로를 쓴다. `--no-attach` 는 attach:false 로 전달된다.
 * @returns {Promise<{attached: boolean, mode: string, error?: string}>}
 */
export async function attachSpawnedSession(
  sessionName,
  title = null,
  options = {},
) {
  if (options.attach === false) {
    return { attached: false, mode: "skipped" };
  }

  const env = options.env || process.env;
  if (env.TMUX) {
    const exec =
      typeof options.multiplexerExec === "function"
        ? options.multiplexerExec
        : psmuxExec;
    try {
      exec(buildTmuxAttachSplitArgs(sessionName));
      return { attached: true, mode: "tmux-split" };
    } catch (error) {
      const message = error?.message || String(error);
      const openTab =
        typeof options.openAttachTab === "function"
          ? options.openAttachTab
          : openAttachTab;
      try {
        await openTab(sessionName, title);
        return { attached: true, mode: "tab", error: message };
      } catch (tabError) {
        return {
          attached: false,
          mode: "failed",
          error: tabError?.message || message,
        };
      }
    }
  }

  const openTab =
    typeof options.openAttachTab === "function"
      ? options.openAttachTab
      : openAttachTab;
  try {
    await openTab(sessionName, title);
    return { attached: true, mode: "tab" };
  } catch (error) {
    return {
      attached: false,
      mode: "failed",
      error: error?.message || String(error),
    };
  }
}

function getLastNonEmptyLine(text) {
  const lines = String(text)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.at(-1) || "";
}

async function waitForRemotePrompt(sessionName, paneId) {
  const baseline = capturePsmuxPane(paneId, 20);
  const capture = startCapture(sessionName, paneId);
  const deadline = Date.now() + 15_000;

  while (Date.now() <= deadline) {
    const remainingMs = Math.max(250, deadline - Date.now());
    await waitForPattern(
      sessionName,
      paneId,
      SSH_PROMPT_PATTERN,
      Math.min(1, remainingMs / 1000),
      { logPath: capture.logPath },
    );

    const tail = capturePsmuxPane(paneId, 20);
    const lastLine = getLastNonEmptyLine(tail);
    if (tail !== baseline && SSH_PROMPT_PATTERN.test(lastLine)) {
      return;
    }
  }

  throw new Error(
    `ssh prompt wait timed out for ${sessionName}: ${capturePsmuxPane(paneId, 20)}`,
  );
}

/** @returns {boolean|null} true=dead, false=alive, null=probe 실패 */
function isPrimaryPaneDead(paneId) {
  try {
    const output = psmuxExec([
      "list-panes",
      "-t",
      paneId,
      "-F",
      "#{pane_dead}",
    ]);
    const lines = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.some((line) => line === "1")) return true;
    return false;
  } catch {
    return null;
  }
}

async function watchSpawnSessionExit(sessionName, options = {}) {
  const paneId = options.paneId || `${sessionName}:0.0`;
  const pollMs = parsePositiveInt(
    options.pollMs,
    DEFAULT_CLEANUP_WATCH_POLL_MS,
  );
  const graceMs = parsePositiveInt(
    options.graceMs,
    DEFAULT_CLEANUP_WATCH_GRACE_MS,
  );
  const maxWaitMs = parsePositiveInt(
    options.maxWaitMs,
    DEFAULT_CLEANUP_WATCH_MAX_MS,
  );
  const sessionExists =
    typeof options.sessionExists === "function"
      ? options.sessionExists
      : psmuxSessionExists;
  const getPaneStatus =
    typeof options.getPaneStatus === "function"
      ? options.getPaneStatus
      : (targetPaneId) => ({
          isDead: isPrimaryPaneDead(targetPaneId),
          exitCode: null,
        });
  const killSession =
    typeof options.killSession === "function"
      ? options.killSession
      : killPsmuxSession;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep =
    typeof options.sleep === "function" ? options.sleep : sleepMsAsync;
  const startedAt = now();
  let consecutiveErrors = 0;

  while (now() - startedAt <= maxWaitMs) {
    if (!sessionExists(sessionName)) {
      return { cleaned: false, reason: "session-missing" };
    }

    const paneStatus = getPaneStatus(paneId) || {};
    if (paneStatus.isDead == null) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 10) {
        return { cleaned: false, reason: "probe-failed" };
      }
    } else {
      consecutiveErrors = 0;
    }

    if (paneStatus.isDead === true) {
      await sleep(graceMs);

      if (!sessionExists(sessionName)) {
        return { cleaned: false, reason: "session-missing" };
      }

      const afterGrace = getPaneStatus(paneId) || {};
      if (afterGrace.isDead === true) {
        killSession(sessionName);
        return {
          cleaned: true,
          reason: "pane-dead",
          exitCode: afterGrace.exitCode ?? paneStatus.exitCode ?? null,
        };
      }
    }

    await sleep(pollMs);
  }

  return { cleaned: false, reason: "timeout" };
}

async function runSpawnCleanupWatcher(sessionName, paneId, timingOptions = {}) {
  await watchSpawnSessionExit(sessionName, {
    paneId,
    pollMs: timingOptions.pollMs,
    graceMs: timingOptions.graceMs,
    maxWaitMs: timingOptions.maxMs,
  });
}

function startSpawnExitWatcher(sessionName, options = {}) {
  if (!options.force && !shouldUsePsmux()) {
    return false;
  }

  const paneId = options.paneId || `${sessionName}:0.0`;
  const args = buildSpawnCleanupWatcherArgs(sessionName, paneId, {
    graceMs: options.graceMs,
    maxMs: options.maxMs,
    pollMs: options.pollMs,
  });
  args[0] = options.scriptPath || args[0];
  const spawnFn =
    typeof options.spawnFn === "function" ? options.spawnFn : spawn;
  const child = spawnFn(options.execPath || process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (child && typeof child.unref === "function") {
    child.unref();
  }
  return true;
}

function startSpawnSessionCleanupWatcher(
  sessionName,
  paneId,
  timingOptions = {},
) {
  try {
    startSpawnExitWatcher(sessionName, {
      ...timingOptions,
      force: true,
      paneId,
    });
  } catch {
    // watcher 시작 실패는 spawn 자체 실패로 보지 않는다.
  }
}

function spawnLocal(args, claudePath, prompt) {
  if (!shouldUsePsmux()) {
    spawnLocalFallback(args, claudePath, prompt);
    return;
  }

  const dir = args.dir ? resolve(args.dir) : process.cwd();
  const slug = buildSessionSlug(args.spawnName);
  const sessionName = deduplicateSessionName(`tfx-spawn-${slug}`);
  const paneId = `${sessionName}:0.0`;
  const permissionFlags = getPermissionFlag().join(" ");
  const claudePathNorm = normalizeCommandPath(claudePath);

  // 임시파일 생성 (프롬프트가 있을 때만)
  // 정리는 pwsh 스크립트 내부에서 수행 (Node exit 시 삭제하면 pane 실행 전 사라짐)
  let tmpFile = null;
  if (prompt) {
    tmpFile = join(tmpdir(), `tfx-prompt-${randomUUID().slice(0, 8)}.md`);
    writeFileSync(tmpFile, prompt, { encoding: "utf8" });
  }

  createPsmuxSession(sessionName, { layout: "1xN", paneCount: 1 });
  try {
    sendKeysToPane(paneId, `cd '${escapePwshSingleQuoted(dir)}'`);
    sleepMs(300);

    if (prompt && tmpFile) {
      // pwsh -File 패턴: 인라인 쿼팅 문제 회피 (피드백: -Command 금지)
      // 1단계: 프롬프트를 Get-Content -Raw → claude -p (one-shot), 세션 ID 추출
      // 2단계: --resume으로 인터랙티브 세션 이어붙이기
      const tmpFileNorm = normalizeCommandPath(tmpFile);
      const flags = getPermissionFlag()
        .map((f) => `'${escapePwshSingleQuoted(f)}'`)
        .join(", ");
      const scriptContent = [
        `$ErrorActionPreference = 'SilentlyContinue'`,
        `$t = '${escapePwshSingleQuoted(tmpFileNorm)}'`,
        `$c = '${escapePwshSingleQuoted(claudePathNorm)}'`,
        `$f = @(${flags})`,
        `$raw = Get-Content -Raw $t`,
        `Remove-Item -ErrorAction SilentlyContinue $t`,
        `Remove-Item -ErrorAction SilentlyContinue $MyInvocation.MyCommand.Definition`,
        `& $c @f $raw`,
        `$trifluxExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }`,
        `exit $trifluxExit`,
      ].join("\n");
      const scriptFile = join(
        tmpdir(),
        `tfx-spawn-${randomUUID().slice(0, 8)}.ps1`,
      );
      writeFileSync(scriptFile, scriptContent, { encoding: "utf8" });
      sendKeysToPane(
        paneId,
        `pwsh -NoProfile -File '${escapePwshSingleQuoted(normalizeCommandPath(scriptFile))}'; ${buildPwshExitTail()}`,
      );
    } else {
      const command = buildLocalClaudeCommand(claudePathNorm, permissionFlags);
      sendKeysToPane(paneId, command);
    }

    startSpawnSessionCleanupWatcher(sessionName, paneId);
    void attachSpawnedSession(sessionName, `local:${slug}`, {
      attach: args.attach,
    });
    console.log(sessionName);
  } catch (err) {
    try {
      killPsmuxSession(sessionName);
    } catch {}
    throw err;
  }
}

/**
 * darwin/linux → posix 원격 레인. detached tmux 세션 pane 이 `ssh -t` 로
 * PATH prefix + cd + claude 스크립트를 실행한다.
 * 세션명 규약이 psmux 레인과 같으므로 --monitor/--kill 이 그대로 붙는다.
 */
async function spawnRemoteViaTmux(args, promptContext, env) {
  const { host } = args;
  if (!env?.claudePath) {
    console.error(
      `claude not found on ${host}. Install Claude Code on the remote host first.`,
    );
    process.exit(1);
  }

  const resolvedDir = resolveRemoteDir(args.dir, env);
  const slug = buildSessionSlug(args.spawnName);
  const sessionName = deduplicateSessionName(
    `${SPAWN_SESSION_PREFIX}${host}-${slug}`,
  );
  const paneId = `${sessionName}:0.0`;
  const permissionFlags = getPermissionFlag().join(" ");
  let prompt = promptContext.prompt;

  try {
    const { stagedFiles } = stageRemotePromptFiles(
      host,
      env,
      promptContext.transferCandidates,
      sessionName,
    );
    prompt = rewritePromptPaths(prompt, stagedFiles);
  } catch (error) {
    failFast(
      `failed to stage remote files: ${error?.message || String(error)}`,
    );
  }

  let remotePromptFile = null;
  try {
    remotePromptFile = uploadRemotePromptFile(host, env, sessionName, prompt);
  } catch (error) {
    failFast(
      `failed to stage remote prompt: ${error?.message || String(error)}`,
    );
  }

  const paneCommand = buildTmuxRemoteLaneCommand(
    host,
    buildRemotePosixSpawnCommands({
      binDirs: resolveRemoteBinDirs(host),
      claudePath: env.claudePath,
      dir: resolvedDir,
      permissionFlags,
      promptFile: remotePromptFile,
    }),
  );

  psmuxExec(buildTmuxSpawnSessionArgs(sessionName, paneCommand));
  try {
    startSpawnSessionCleanupWatcher(sessionName, paneId);

    const waited = await waitForClaudeScreenState({
      capture: () => capturePsmuxPane(paneId, 40),
      targetStates: [CLAUDE_SCREEN_HOME, CLAUDE_SCREEN_REPL],
      timeoutMs: 60_000,
    });
    if (!waited.ready) {
      console.error(
        formatMonitorEvent({
          event: "spawn-wait-timeout",
          session: sessionName,
          state: waited.state,
        }),
      );
    }

    await attachSpawnedSession(sessionName, `${host}:${slug}`, {
      attach: args.attach,
    });
    console.log(sessionName);
  } catch (err) {
    try {
      killPsmuxSession(sessionName);
    } catch {}
    throw err;
  }
}

async function spawnRemote(args, promptContext) {
  const { host } = args;
  if (!host) {
    console.error("--host required for remote spawn");
    process.exit(1);
  }

  if (!IS_WINDOWS_LOCAL) {
    const multiplexerAvailable = hasPsmux();
    let remoteEnv = null;
    if (multiplexerAvailable) {
      try {
        remoteEnv = probeRemoteEnv(host);
      } catch {
        remoteEnv = null;
      }
    }

    const lane = resolveSpawnLane({
      multiplexerAvailable,
      remoteOs: remoteEnv?.os ?? null,
    });
    if (lane === "tmux") {
      await spawnRemoteViaTmux(args, promptContext, remoteEnv);
      return;
    }
    spawnRemoteFallback(args, promptContext);
    return;
  }

  if (!shouldUsePsmux()) {
    spawnRemoteFallback(args, promptContext);
    return;
  }

  const env = probeRemoteEnv(host);
  if (!env.claudePath) {
    console.error(
      `claude not found on ${host}. Install Claude Code on the remote host first.`,
    );
    process.exit(1);
  }
  const resolvedDir = resolveRemoteDir(args.dir, env);
  const slug = buildSessionSlug(args.spawnName);
  const sessionName = deduplicateSessionName(`tfx-spawn-${host}-${slug}`);
  const paneId = `${sessionName}:0.0`;
  const permissionFlags = getPermissionFlag().join(" ");
  let prompt = promptContext.prompt;

  try {
    const { stagedFiles } = stageRemotePromptFiles(
      host,
      env,
      promptContext.transferCandidates,
      sessionName,
    );
    prompt = rewritePromptPaths(prompt, stagedFiles);
  } catch (error) {
    failFast(
      `failed to stage remote files: ${error?.message || String(error)}`,
    );
  }

  createPsmuxSession(sessionName, { layout: "1xN", paneCount: 1 });
  try {
    sendKeysToPane(paneId, buildRemoteBootstrapCommand(host));
    await waitForRemotePrompt(sessionName, paneId);

    const remoteBinDirs = resolveRemoteBinDirs(host);

    if (env.shell === "pwsh") {
      sendKeysToPane(paneId, `cd '${escapePwshSingleQuoted(resolvedDir)}'`);
    }

    if (prompt) {
      // file-based prompt delivery: SCP prompt → remote launcher script
      // send-keys로 긴 프롬프트를 보내면 깨지므로 파일 전송 후 스크립트 실행
      const stageDir = resolveRemoteStageDir(env, sessionName);
      ensureRemoteStageDir(host, env, stageDir);

      const localPromptFile = join(
        tmpdir(),
        `tfx-prompt-${randomUUID().slice(0, 8)}.md`,
      );
      writeFileSync(localPromptFile, prompt, { encoding: "utf8" });
      const remotePromptFile = `${stageDir}/prompt.md`;
      uploadFileToRemote(host, localPromptFile, remotePromptFile);
      try {
        unlinkSync(localPromptFile);
      } catch {
        /* cleanup best-effort */
      }

      if (env.shell === "pwsh") {
        const remotePromptWin = remotePromptFile.replace(/\//g, "\\");
        const scriptContent = [
          `$ErrorActionPreference = 'SilentlyContinue'`,
          `$t = '${escapePwshSingleQuoted(remotePromptWin)}'`,
          `$c = '${escapePwshSingleQuoted(env.claudePath)}'`,
          `$raw = Get-Content -Raw $t`,
          `Remove-Item -ErrorAction SilentlyContinue $t`,
          `Remove-Item -ErrorAction SilentlyContinue $MyInvocation.MyCommand.Definition`,
          `& $c ${permissionFlags} $raw`,
          `$trifluxExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }`,
          `exit $trifluxExit`,
        ].join("\n");
        const localScript = join(
          tmpdir(),
          `tfx-spawn-${randomUUID().slice(0, 8)}.ps1`,
        );
        writeFileSync(localScript, scriptContent, { encoding: "utf8" });
        const remoteScript = `${stageDir}/launch.ps1`;
        uploadFileToRemote(host, localScript, remoteScript);
        try {
          unlinkSync(localScript);
        } catch {
          /* cleanup best-effort */
        }

        const remoteScriptWin = remoteScript.replace(/\//g, "\\");
        sendKeysToPane(
          paneId,
          `pwsh -NoProfile -File '${escapePwshSingleQuoted(remoteScriptWin)}'`,
        );
      } else {
        for (const command of buildRemotePosixSpawnCommands({
          binDirs: remoteBinDirs,
          claudePath: env.claudePath,
          dir: resolvedDir,
          permissionFlags,
          promptFile: remotePromptFile,
        })) {
          sendKeysToPane(paneId, command);
        }
      }
    } else if (env.shell === "pwsh") {
      sendKeysToPane(paneId, buildRemoteClaudeCommand(env, permissionFlags));
    } else {
      for (const command of buildRemotePosixSpawnCommands({
        binDirs: remoteBinDirs,
        claudePath: env.claudePath,
        dir: resolvedDir,
        permissionFlags,
      })) {
        sendKeysToPane(paneId, command);
      }
    }

    startSpawnSessionCleanupWatcher(sessionName, paneId);
    await attachSpawnedSession(sessionName, `${host}:${slug}`, {
      attach: args.attach,
    });
    console.log(sessionName);
  } catch (err) {
    try {
      killPsmuxSession(sessionName);
    } catch {}
    throw err;
  }
}

function sendPromptToSession(sessionName, prompt) {
  requirePsmux();
  if (!psmuxSessionExists(sessionName)) {
    throw new Error(`psmux session not found: ${sessionName}`);
  }
  sendKeysToPane(`${sessionName}:0.0`, prompt);
}

function attachSession(sessionName) {
  requirePsmux();
  if (!psmuxSessionExists(sessionName)) {
    throw new Error(`psmux session not found: ${sessionName}`);
  }
  openAttachTab(sessionName);
}

function captureSession(sessionName, lines = 30) {
  requirePsmux();
  if (!psmuxSessionExists(sessionName)) {
    throw new Error(`psmux session not found: ${sessionName}`);
  }
  return capturePsmuxPane(`${sessionName}:0.0`, lines);
}

/**
 * claude TUI \ucea1\ucc98 \ud14d\uc2a4\ud2b8\ub97c \ud654\uba74 \uc0c1\ud0dc\ub85c \ubd84\ub958\ud55c\ub2e4.
 * claude 2.1.x\ub294 REPL\uc774 \uc544\ub2c8\ub77c \uc138\uc158 \ub9e4\ub2c8\uc800 \ud648 \ud654\uba74\uc73c\ub85c \ubd80\ud305\ud558\ubbc0\ub85c,
 * \ud504\ub86c\ud504\ud2b8 \uae30\ud638\ub9cc \ubcf4\ub294 \ud310\uc815\uc740 \ud648 \ud654\uba74\uc744 REPL\ub85c \uc624\ud310\ud55c\ub2e4.
 * @param {string} captureText
 * @returns {"home"|"repl"|"trust_prompt"|"needs_input"|"busy"|"unknown"}
 */
export function classifyClaudeScreen(captureText) {
  const text = String(captureText ?? "");
  if (!text.trim()) return CLAUDE_SCREEN_UNKNOWN;

  if (CLAUDE_TRUST_SIGNAL.test(text)) return CLAUDE_SCREEN_TRUST;
  if (CLAUDE_NEEDS_INPUT_SIGNAL.test(text)) return CLAUDE_SCREEN_NEEDS_INPUT;
  if (CLAUDE_BUSY_SIGNAL.test(text)) return CLAUDE_SCREEN_BUSY;
  if (CLAUDE_HOME_SIGNAL.test(text)) return CLAUDE_SCREEN_HOME;
  if (CLAUDE_REPL_SIGNALS.some((pattern) => pattern.test(text))) {
    return CLAUDE_SCREEN_REPL;
  }
  if (CLAUDE_REPL_LAST_LINE.test(getLastNonEmptyLine(text))) {
    return CLAUDE_SCREEN_REPL;
  }
  return CLAUDE_SCREEN_UNKNOWN;
}

function normalizeTargetStates(targetStates) {
  const list = Array.isArray(targetStates)
    ? targetStates
    : targetStates
      ? [targetStates]
      : [CLAUDE_SCREEN_REPL, CLAUDE_SCREEN_HOME];
  const normalized = list.map((state) => String(state)).filter(Boolean);
  return normalized.length > 0
    ? normalized
    : [CLAUDE_SCREEN_REPL, CLAUDE_SCREEN_HOME];
}

/**
 * \ucea1\ucc98 \ud3f4\ub9c1\uc73c\ub85c \ubaa9\ud45c \ud654\uba74 \uc0c1\ud0dc \ub3c4\ub2ec\uc744 \uae30\ub2e4\ub9b0\ub2e4.
 * capture/now/sleep \uc740 \uc8fc\uc785 \uac00\ub2a5\ud558\ubbc0\ub85c \uc2e4\uc81c tmux \uc5c6\uc774 \ub2e8\uc704 \ud14c\uc2a4\ud2b8\ud560 \uc218 \uc788\ub2e4.
 * @returns {Promise<{ready: boolean, state: string, timedOut: boolean, states: string[]}>}
 */
export async function waitForClaudeScreenState(options = {}) {
  const capture = options.capture;
  if (typeof capture !== "function") {
    throw new TypeError("waitForClaudeScreenState requires a capture function");
  }
  const targetStates = normalizeTargetStates(options.targetStates);
  const targets = new Set(targetStates);
  const timeoutMs = parsePositiveInt(options.timeoutMs, 60_000);
  const pollMs = parsePositiveInt(options.pollMs, DEFAULT_SCREEN_WAIT_POLL_MS);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep =
    typeof options.sleep === "function" ? options.sleep : sleepMsAsync;
  const onState =
    typeof options.onState === "function" ? options.onState : () => {};

  const deadline = now() + timeoutMs;
  const seen = [];
  let lastState = CLAUDE_SCREEN_UNKNOWN;

  while (now() <= deadline) {
    lastState = classifyClaudeScreen(capture());
    if (seen.at(-1) !== lastState) {
      seen.push(lastState);
      onState(lastState);
    }
    if (targets.has(lastState)) {
      return { ready: true, state: lastState, timedOut: false, states: seen };
    }
    await sleep(pollMs);
  }

  return { ready: false, state: lastState, timedOut: true, states: seen };
}

/**
 * \uc138\uc158\uc758 claude\uac00 \ubaa9\ud45c \ud654\uba74 \uc0c1\ud0dc\uc5d0 \ub3c4\ub2ec\ud560 \ub54c\uae4c\uc9c0 \ub300\uae30\ud55c\ub2e4.
 * @param {string} sessionName
 * @param {number} [timeoutSec]
 * @param {{targetStates?: string[]|string, pollMs?: number, capture?: Function}} [options]
 */
async function waitForClaudeReady(sessionName, timeoutSec = 60, options = {}) {
  const capture =
    typeof options.capture === "function"
      ? options.capture
      : (() => {
          requirePsmux();
          if (!psmuxSessionExists(sessionName)) {
            throw new Error(`psmux session not found: ${sessionName}`);
          }
          const paneId = `${sessionName}:0.0`;
          return () => capturePsmuxPane(paneId, 40);
        })();

  const result = await waitForClaudeScreenState({
    capture,
    now: options.now,
    pollMs: options.pollMs,
    sleep: options.sleep,
    targetStates: options.targetStates,
    timeoutMs: timeoutSec * 1000,
  });

  if (!result.ready) {
    throw new Error(
      `claude ready wait timed out after ${timeoutSec}s for ${sessionName} (last state: ${result.state})`,
    );
  }
  return result;
}

/** machine profile 의 stall 임계(초). 미설정이면 20분. */
export function resolveStallThresholdSec(env = process.env) {
  return parsePositiveInt(env.TFX_STALL_THRESHOLD, DEFAULT_STALL_THRESHOLD_SEC);
}

/** 구조화 stdout 라인. 소비자는 prefix 로 필터링한다. */
export function formatMonitorEvent(event) {
  return `${MONITOR_EVENT_PREFIX} ${JSON.stringify(event)}`;
}

/**
 * 로컬 capture-pane 폴링으로 화면 상태를 추적한다.
 * needs_input/trust_prompt 는 임계 대기 없이 즉시 보고하고,
 * 상태 전이 없이 임계 시간이 지나면 stall 을 보고한다.
 * @returns {Promise<{reason: string, state: string, events: object[]}>}
 */
export async function monitorClaudeSession(sessionName, options = {}) {
  const paneId = options.paneId || `${sessionName}:0.0`;
  const capture =
    typeof options.capture === "function"
      ? options.capture
      : () => capturePsmuxPane(paneId, 40);
  const sessionExists =
    typeof options.sessionExists === "function"
      ? options.sessionExists
      : psmuxSessionExists;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep =
    typeof options.sleep === "function" ? options.sleep : sleepMsAsync;
  const sendEnter =
    typeof options.sendEnter === "function"
      ? options.sendEnter
      : () => sendKeysToPane(paneId, "");
  const autoTrust = options.autoTrust === true;
  const pollMs = parsePositiveInt(options.pollMs, DEFAULT_MONITOR_POLL_MS);
  const maxMs = parsePositiveInt(options.maxMs, DEFAULT_MONITOR_MAX_MS);
  const stallThresholdMs =
    parsePositiveInt(
      options.stallThresholdSec,
      resolveStallThresholdSec(options.env || process.env),
    ) * 1000;

  const events = [];
  const emit =
    typeof options.emit === "function"
      ? options.emit
      : (event) => console.log(formatMonitorEvent(event));
  const record = (event) => {
    events.push(event);
    emit(event);
  };

  const startedAt = now();
  let state = null;
  let lastChangeAt = startedAt;
  let stallReported = false;

  while (now() - startedAt <= maxMs) {
    if (!sessionExists(sessionName)) {
      record({ at: now(), event: "session-gone", session: sessionName });
      return {
        events,
        reason: "session-gone",
        state: state || CLAUDE_SCREEN_UNKNOWN,
      };
    }

    const nextState = classifyClaudeScreen(capture());
    if (nextState !== state) {
      state = nextState;
      lastChangeAt = now();
      stallReported = false;
      record({ at: lastChangeAt, event: "state", session: sessionName, state });

      if (REMOTE_ACTIONABLE_STATES.has(state)) {
        record({
          at: now(),
          autoTrust,
          event: state,
          session: sessionName,
          state,
        });
        if (state === CLAUDE_SCREEN_TRUST && autoTrust) {
          sendEnter(sessionName);
          record({
            at: now(),
            event: "auto-trust-sent",
            session: sessionName,
          });
        }
      }
    } else if (!stallReported && now() - lastChangeAt >= stallThresholdMs) {
      stallReported = true;
      record({
        at: now(),
        event: "stall",
        session: sessionName,
        state,
        stalledMs: now() - lastChangeAt,
        thresholdMs: stallThresholdMs,
      });
    }

    await sleep(pollMs);
  }

  return {
    events,
    reason: "max-duration",
    state: state || CLAUDE_SCREEN_UNKNOWN,
  };
}

/** `tfx-spawn-<host>-<slug>` 세션명에서 원격 호스트를 역추론한다. */
export function inferRemoteHostFromSessionName(sessionName, hostNames = []) {
  const name = String(sessionName || "");
  if (!name.startsWith(SPAWN_SESSION_PREFIX)) return null;
  const rest = name.slice(SPAWN_SESSION_PREFIX.length);

  let best = null;
  for (const candidate of hostNames) {
    const host = String(candidate || "");
    if (!host) continue;
    if (rest !== host && !rest.startsWith(`${host}-`)) continue;
    if (!best || host.length > best.length) best = host;
  }
  return best;
}

function listKnownHostNames() {
  try {
    return Object.keys(readHosts().hosts || {});
  } catch {
    return [];
  }
}

/** 원격 백그라운드 세션까지 정리하는 공식 명령. */
export function buildRemoteDaemonStopCommand(binDirs = [], claudePath = null) {
  const pathExport = buildRemotePathExportCommand(binDirs);
  const binary = claudePath ? shellQuote(claudePath) : "claude";
  return `${pathExport ? `${pathExport}; ` : ""}${binary} daemon stop --any`;
}

/** readback 용 잔존 프로세스 카운트. `[c]laude` 로 자기 자신 매칭을 피한다. */
export function buildRemoteClaudeProcessCountCommand() {
  return "pgrep -f '[c]laude' | wc -l";
}

/** @returns {number|null} 파싱 실패 시 null (거짓 성공 금지) */
export function parseRemoteProcessCount(stdout) {
  const match = /\d+/.exec(String(stdout ?? ""));
  return match ? Number.parseInt(match[0], 10) : null;
}

function defaultRunRemoteCommand(host, command) {
  const stdout = execFileSync("ssh", [host, "sh", "-lc", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return { ok: true, stdout: String(stdout ?? "") };
}

/**
 * 로컬 psmux/tmux 세션과 원격 claude 잔존 프로세스를 함께 회수한다.
 * 원격 실패가 로컬 정리를 막지 않으며, readback 이 0 을 확인하지 못하면 ok:false 다.
 * @returns {Promise<{ok: boolean, session: string, local: object, remote: object|null}>}
 */
export async function killSpawnSession(sessionName, options = {}) {
  const killLocal =
    typeof options.killLocal === "function"
      ? options.killLocal
      : killPsmuxSession;
  const runRemote =
    typeof options.runRemote === "function"
      ? options.runRemote
      : defaultRunRemoteCommand;
  const sleep =
    typeof options.sleep === "function" ? options.sleep : sleepMsAsync;
  const retryDelayMs = parsePositiveInt(
    options.readbackRetryDelayMs,
    KILL_READBACK_RETRY_DELAY_MS,
  );

  const result = {
    local: { ok: false },
    ok: false,
    remote: null,
    session: sessionName,
  };

  try {
    killLocal(sessionName);
    result.local = { ok: true };
  } catch (error) {
    result.local = { error: error?.message || String(error), ok: false };
  }

  const hostNames = options.hostNames || listKnownHostNames();
  const host =
    options.host || inferRemoteHostFromSessionName(sessionName, hostNames);
  if (!host) {
    result.ok = result.local.ok;
    return result;
  }

  const binDirs = options.binDirs || resolveRemoteBinDirs(host, options);
  const claudePath =
    options.claudePath || resolveRemoteClaudePath(host, options);
  const remote = {
    attempted: true,
    daemonStop: { ok: false },
    host,
    ok: false,
    remaining: null,
  };

  try {
    const stopped = runRemote(
      host,
      buildRemoteDaemonStopCommand(binDirs, claudePath),
    );
    remote.daemonStop = {
      ok: stopped?.ok !== false,
      output: String(stopped?.stdout ?? "").trim(),
    };
  } catch (error) {
    remote.daemonStop = { error: error?.message || String(error), ok: false };
  }

  const readRemaining = () => {
    try {
      const probe = runRemote(host, buildRemoteClaudeProcessCountCommand());
      return parseRemoteProcessCount(probe?.stdout);
    } catch (error) {
      remote.readbackError = error?.message || String(error);
      return null;
    }
  };

  remote.remaining = readRemaining();

  // `[c]laude` 는 claude 본체 외에 경로에 claude 가 든 프로세스도 잡는다.
  // 세션 종료 직후 OMC SessionEnd 훅 워커가 몇 초간 걸리는 실측이 있어,
  // remaining>0 이면 한 번만 재측정하고 그 값으로 판정한다.
  // 패턴을 좁히면 과소 매칭으로 거짓 성공이 나므로 패턴은 그대로 둔다.
  if (typeof remote.remaining === "number" && remote.remaining > 0) {
    await sleep(retryDelayMs);
    remote.firstRemaining = remote.remaining;
    remote.remaining = readRemaining();
    remote.retried = true;
  }

  remote.ok = remote.remaining === 0;
  result.remote = remote;
  result.ok = result.local.ok && remote.ok;
  return result;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "watch-cleanup") {
    if (!args.sessionName) {
      console.error("--watch-cleanup requires a session name");
      process.exit(1);
    }

    const paneId = args.watchPane || `${args.sessionName}:0.0`;
    await runSpawnCleanupWatcher(args.sessionName, paneId, {
      graceMs: args.watchGraceMs,
      maxMs: args.watchMaxMs,
      pollMs: args.watchPollMs,
    });
    return;
  }

  if (args.command === "list") {
    console.log(listSpawnSessions().join("\n"));
    return;
  }

  if (args.command === "attach") {
    if (!args.sessionName) {
      console.error("--attach requires a session name");
      process.exit(1);
    }
    attachSession(args.sessionName);
    return;
  }

  if (args.command === "probe") {
    if (!args.probeHost) {
      console.error("--probe requires a host");
      process.exit(1);
    }
    console.log(
      JSON.stringify(probeRemoteEnv(args.probeHost, { force: true }), null, 2),
    );
    return;
  }

  if (args.command === "capture") {
    if (!args.sessionName) {
      console.error("--capture requires a session name");
      process.exit(1);
    }
    console.log(captureSession(args.sessionName));
    return;
  }

  if (args.command === "wait") {
    if (!args.sessionName) {
      console.error("--wait requires a session name");
      process.exit(1);
    }
    const waited = await waitForClaudeReady(args.sessionName);
    console.log(waited.state);
    return;
  }

  if (args.command === "monitor") {
    if (!args.sessionName) {
      console.error("--monitor requires a session name");
      process.exit(1);
    }
    requirePsmux();
    await monitorClaudeSession(args.sessionName, {
      autoTrust: args.autoTrust,
    });
    return;
  }

  if (args.command === "kill") {
    if (!args.sessionName) {
      console.error("--kill requires a session name");
      process.exit(1);
    }
    const killResult = await killSpawnSession(args.sessionName, {
      host: args.host,
    });
    console.log(JSON.stringify(killResult, null, 2));
    if (!killResult.ok) process.exit(1);
    return;
  }

  const promptContext = buildPromptContext(args, {
    includeTransferFiles: Boolean(args.host),
  });
  const prompt = promptContext.prompt;

  if (args.local && args.transferFiles.length > 0) {
    console.warn(
      "[tfx] --transfer는 원격 모드에서만 사용 가능합니다 (--local에서는 무시됨)",
    );
  }

  if (args.command === "send") {
    if (!args.sessionName) {
      console.error("--send requires a session name");
      process.exit(1);
    }
    if (!prompt) {
      console.error("--send requires a prompt or --handoff");
      process.exit(1);
    }
    sendPromptToSession(args.sessionName, prompt);
    return;
  }

  if (!args.local && !args.host) {
    console.log(usageText());
    return;
  }

  if (args.local) {
    spawnLocal(args, detectClaudePath(), prompt);
    return;
  }

  await spawnRemote(args, promptContext);
}

const selfRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (selfRun) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export const __remoteSpawnTest = {
  buildPromptContext,
  parseArgs,
  rewritePromptPaths,
  startSpawnExitWatcher,
  stageRemotePromptFiles,
  validateTransferCandidate,
  waitForClaudeReady,
  watchSpawnSessionExit,
};
