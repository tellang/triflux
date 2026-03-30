#!/usr/bin/env node
// remote-spawn.mjs — 로컬/원격 Claude 세션 실행 유틸리티
//
// Usage:
//   node remote-spawn.mjs --local [--dir <path>] [--prompt "..."] [--handoff <file>]
//   node remote-spawn.mjs --host <ssh-host> [--dir <path>] [--prompt "..."] [--handoff <file>]
//   node remote-spawn.mjs --send <session> "prompt"
//   node remote-spawn.mjs --list
//   node remote-spawn.mjs --attach <session>
//   node remote-spawn.mjs --probe <ssh-host>

import { randomUUID } from "crypto";
import { execFileSync, execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir, platform as getPlatform, tmpdir } from "os";
import { join, posix as posixPath, resolve, win32 as win32Path } from "path";
import { fileURLToPath } from "url";
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
const SSH_PROMPT_PATTERN = /(\$|%|#|PS |>)\s*$/;
const IS_WINDOWS_LOCAL = getPlatform() === "win32";
const SELF_SCRIPT_PATH = fileURLToPath(import.meta.url);

const DEFAULT_CLEANUP_WATCH_POLL_MS = 1000;
const DEFAULT_CLEANUP_WATCH_GRACE_MS = 1500;
const DEFAULT_CLEANUP_WATCH_MAX_MS = 60 * 60 * 1000;

const SAFE_HOST_RE = /^[a-zA-Z0-9._-]+$/;
const SAFE_DIR_RE = /^[a-zA-Z0-9_.~\/:\\-]+$/;

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
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
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
  return `& '${escapePwshSingleQuoted(claudePathNorm)}'${permissionFlags ? ` ${permissionFlags}` : ""}; ${buildPwshExitTail()}`;
}

export function buildRemoteClaudeCommand(env, permissionFlags = "") {
  if (env.shell === "pwsh") {
    return `& "${escapePwshDoubleQuoted(env.claudePath)}"${permissionFlags ? ` ${permissionFlags}` : ""}; ${buildPwshExitTail()}`;
  }
  return `${shellQuote(env.claudePath)}${permissionFlags ? ` ${permissionFlags}` : ""}; ${buildPosixExitTail()}`;
}

export function resolveCleanupWatcherTimingOptions(source = {}, env = process.env) {
  return Object.freeze({
    graceMs: parsePositiveInt(source.graceMs ?? env.TFX_SPAWN_CLEANUP_GRACE_MS, DEFAULT_CLEANUP_WATCH_GRACE_MS),
    maxMs: parsePositiveInt(source.maxMs ?? env.TFX_SPAWN_CLEANUP_MAX_MS, DEFAULT_CLEANUP_WATCH_MAX_MS),
    pollMs: parsePositiveInt(source.pollMs ?? env.TFX_SPAWN_CLEANUP_POLL_MS, DEFAULT_CLEANUP_WATCH_POLL_MS),
  });
}

export function buildSpawnCleanupWatcherArgs(sessionName, paneId, timingOptions = {}) {
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

function usageText() {
  return `Usage:
  remote-spawn --local [--dir <path>] [--prompt "task"] [--handoff <file>]
  remote-spawn --host <ssh-host> [--dir <path>] [--prompt "task"] [--handoff <file>]
  remote-spawn --send <session> "prompt"
  remote-spawn --list
  remote-spawn --attach <session>
  remote-spawn --probe <ssh-host>

Options:
  --local          로컬 WT 탭에서 Claude 실행
  --host <name>    SSH 호스트로 원격 Claude 실행
  --dir <path>     작업 디렉토리 (기본: 현재 디렉토리 / 원격 홈)
  --prompt "..."   Claude에 전달할 첫 메시지
  --handoff <file> 핸드오프 파일 경로 (prompt와 결합 가능)
  --send <session> 실행 중인 세션에 프롬프트 전송
  --list           tfx-spawn-* psmux 세션 목록
  --attach <name>  WT 새 탭에서 세션 attach
  --probe <host>   SSH 원격 환경 강제 프로브 + 캐시 갱신
  --capture <name> 세션 pane 내용 캡처 출력
  --wait <name>    세션의 Claude 준비 완료 대기 (기본 60초)`;
}

function parseArgs(argv) {
  let command = "spawn";
  let host = null;
  let dir = null;
  let prompt = null;
  let handoff = null;
  let local = false;
  let sessionName = null;
  let probeHost = null;
  let watchPane = null;
  let watchGraceMs = null;
  let watchPollMs = null;
  let watchMaxMs = null;
  const promptParts = [];

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--local") {
      local = true;
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

  const mergedPrompt = prompt ?? (promptParts.length > 0 ? promptParts.join(" ") : null);
  return {
    command,
    dir,
    handoff,
    host,
    local,
    probeHost,
    prompt: mergedPrompt,
    sessionName,
    watchGraceMs,
    watchMaxMs,
    watchPane,
    watchPollMs,
  };
}

function parseVersion(versionStr) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionStr);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
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
        encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      });
      return parseVersion(out);
    }
    const out = execFileSync(binPath, ["--version"], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

function detectClaudePath() {
  if (process.env.CLAUDE_BIN_PATH) return process.env.CLAUDE_BIN_PATH;

  const candidates = [];

  const wingetPath = join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "claude.exe");
  if (existsSync(wingetPath)) candidates.push(wingetPath);

  const npmPath = join(process.env.APPDATA || "", "npm", "claude.cmd");
  if (existsSync(npmPath)) candidates.push(npmPath);

  try {
    const command = IS_WINDOWS_LOCAL ? "where" : "which";
    const result = execFileSync(command, ["claude"], { encoding: "utf8", timeout: 5000 }).trim();
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
  return process.env.TFX_CLAUDE_SAFE_MODE === "1" ? [] : ["--dangerously-skip-permissions"];
}

function buildPrompt(args) {
  let content = "";

  if (args.handoff) {
    const handoffPath = resolve(args.handoff);
    if (!existsSync(handoffPath)) {
      console.error(`handoff file not found: ${handoffPath}`);
      process.exit(1);
    }
    const size = statSync(handoffPath).size;
    if (size > MAX_HANDOFF_BYTES) {
      console.error(`handoff file too large: ${size} bytes (max ${MAX_HANDOFF_BYTES})`);
      process.exit(1);
    }
    content = readFileSync(handoffPath, "utf8").trim();
  }

  if (args.prompt) {
    content = content ? `${content}\n\n---\n\n${args.prompt}` : args.prompt;
  }

  return content;
}

function spawnLocalFallback(args, claudePath, prompt) {
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

  const wtArgs = ["new-tab", "-d", dir, "--"];
  const claudeForward = claudePath.replace(/\\/g, "/");

  if (prompt) {
    const psQuoted = `'${prompt.replace(/'/g, "''")}'`;
    wtArgs.push(
      "pwsh",
      "-NoProfile",
      "-Command",
      `& '${claudeForward}' ${getPermissionFlag().join(" ")} ${psQuoted}`,
    );
  } else {
    wtArgs.push(claudeForward, ...getPermissionFlag());
  }

  try {
    spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    console.log(`spawned local Claude in WT tab → ${dir}`);
  } catch (error) {
    console.error("wt.exe spawn failed:", error.message);
    process.exit(1);
  }
}

function spawnRemoteFallback(args, prompt) {
  const { host } = args;
  if (!host) {
    console.error("--host required for remote spawn");
    process.exit(1);
  }

  const dir = args.dir || "~";
  const permFlags = getPermissionFlag();
  const scriptLines = [
    `cd '${dir.replace(/'/g, "''")}'`,
  ];

  if (prompt) {
    const safePrompt = prompt.replace(/'/g, "''");
    scriptLines.push(`& "$env:USERPROFILE\\.local\\bin\\claude.exe" ${permFlags.join(" ")} '${safePrompt}'`);
  } else {
    scriptLines.push(`& "$env:USERPROFILE\\.local\\bin\\claude.exe" ${permFlags.join(" ")}`);
  }

  const scriptContent = scriptLines.join("\n");
  const localScript = join(tmpdir(), "tfx-remote-spawn.ps1");
  writeFileSync(localScript, scriptContent, "utf8");

  try {
    execFileSync("scp", [localScript, `${host}:tfx-remote-spawn.ps1`], { timeout: 10000, stdio: "pipe" });
  } catch (error) {
    console.error("failed to copy script to remote:", error.message);
    process.exit(1);
  }

  let remoteHome;
  try {
    remoteHome = execFileSync("ssh", [host, "echo", "$env:USERPROFILE"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    remoteHome = `C:\\Users\\${host}`;
  }

  const remoteScript = `${remoteHome.replace(/\\/g, "/")}/tfx-remote-spawn.ps1`;
  const remoteCmd = `pwsh -NoExit -File ${remoteScript}`;

  if (IS_WINDOWS_LOCAL) {
    const wtArgs = [
      "new-tab",
      "--title",
      `Claude@${host}`,
      "--",
      "ssh",
      "-t",
      "--",
      host,
      remoteCmd,
    ];
    try {
      spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false }).unref();
      console.log(`spawned remote Claude → ${host}:${dir}`);
    } catch (error) {
      console.error("wt.exe spawn failed:", error.message);
      process.exit(1);
    }
  } else {
    const child = spawn("ssh", ["-t", "--", host, remoteCmd], { stdio: "inherit" });
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
    claudePath: (!parsed.claude || parsed.claude === "notfound") ? null : parsed.claude,
    home: parsed.home,
    os: "win32",
    shell: "pwsh",
  });
}

function normalizePosixProbeEnv(host, parsed) {
  const os = parsed.os === "darwin" ? "darwin" : parsed.os === "linux" ? "linux" : null;
  if (!os || !parsed.home) {
    return null;
  }

  return Object.freeze({
    claudePath: (!parsed.claude || parsed.claude === "notfound") ? null : parsed.claude,
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
    cacheEntry
    && typeof cacheEntry.cachedAt === "number"
    && cacheEntry.env
    && (Date.now() - cacheEntry.cachedAt) < REMOTE_ENV_TTL_MS,
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
    'Write-Output "os=$([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) ? \'win32\' : \'other\')"',
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
    if (/^~[\\/]/u.test(winDir)) return win32Path.join(env.home, winDir.slice(2));
    if (isWindowsAbsolutePath(winDir)) return winDir;
    return win32Path.join(env.home, winDir);
  }

  if (requestedDir === "~") return env.home;
  if (requestedDir.startsWith("~/")) return posixPath.join(env.home, requestedDir.slice(2));
  if (requestedDir.startsWith("/")) return requestedDir;
  return posixPath.join(env.home, requestedDir);
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
  const helperSessions = listPsmuxSessions().filter((name) => name.startsWith("tfx-spawn-"));
  if (helperSessions.length > 0) {
    return helperSessions;
  }

  try {
    return listSessionNamesFromRawOutput(psmuxExec(["list-sessions"]))
      .filter((name) => name.startsWith("tfx-spawn-"));
  } catch {
    return [];
  }
}

function openAttachTab(sessionName, title = null) {
  if (IS_WINDOWS_LOCAL) {
    const wtArgs = title
      ? ["new-tab", "--title", title, "--", "psmux", "attach", "-t", sessionName]
      : ["new-tab", "--", "psmux", "attach", "-t", sessionName];
    spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return;
  }

  attachPsmuxSession(sessionName);
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

  throw new Error(`ssh prompt wait timed out for ${sessionName}: ${capturePsmuxPane(paneId, 20)}`);
}

/** @returns {boolean|null} true=dead, false=alive, null=probe 실패 */
function isPrimaryPaneDead(paneId) {
  try {
    const output = psmuxExec(["list-panes", "-t", paneId, "-F", "#{pane_dead}"]);
    const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.some((line) => line === "1")) return true;
    return false;
  } catch {
    return null;
  }
}

async function runSpawnCleanupWatcher(sessionName, paneId, timingOptions = {}) {
  const timings = resolveCleanupWatcherTimingOptions(timingOptions);
  const startedAt = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - startedAt <= timings.maxMs) {
    if (!psmuxSessionExists(sessionName)) {
      return;
    }

    const dead = isPrimaryPaneDead(paneId);
    if (dead === null) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 10) return; // psmux 반복 실패 시 조기 종료
    } else {
      consecutiveErrors = 0;
    }
    if (dead === true) {
      await sleepMsAsync(timings.graceMs);

      if (!psmuxSessionExists(sessionName)) {
        return;
      }

      if (isPrimaryPaneDead(paneId) === true) {
        try { killPsmuxSession(sessionName); } catch {}
        return;
      }
    }

    await sleepMsAsync(timings.pollMs);
  }
}

function startSpawnSessionCleanupWatcher(sessionName, paneId, timingOptions = {}) {
  const args = buildSpawnCleanupWatcherArgs(sessionName, paneId, timingOptions);
  try {
    spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
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
  const sessionName = `tfx-spawn-${randomUUID().slice(0, 8)}`;
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
      const flags = getPermissionFlag().map((f) => `'${escapePwshSingleQuoted(f)}'`).join(", ");
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
      const scriptFile = join(tmpdir(), `tfx-spawn-${randomUUID().slice(0, 8)}.ps1`);
      writeFileSync(scriptFile, scriptContent, { encoding: "utf8" });
      sendKeysToPane(paneId, `pwsh -NoProfile -File '${escapePwshSingleQuoted(normalizeCommandPath(scriptFile))}'; ${buildPwshExitTail()}`);
    } else {
      const command = buildLocalClaudeCommand(claudePathNorm, permissionFlags);
      sendKeysToPane(paneId, command);
    }

    startSpawnSessionCleanupWatcher(sessionName, paneId);
    openAttachTab(sessionName, "Claude@local");
    console.log(sessionName);
  } catch (err) {
    try { killPsmuxSession(sessionName); } catch {}
    throw err;
  }
}

async function spawnRemote(args, prompt) {
  const { host } = args;
  if (!host) {
    console.error("--host required for remote spawn");
    process.exit(1);
  }

  if (!shouldUsePsmux()) {
    spawnRemoteFallback(args, prompt);
    return;
  }

  const env = probeRemoteEnv(host);
  if (!env.claudePath) {
    console.error(`claude not found on ${host}. Install Claude Code on the remote host first.`);
    process.exit(1);
  }
  const resolvedDir = resolveRemoteDir(args.dir, env);
  const sessionName = `tfx-spawn-${host}-${randomUUID().slice(0, 8)}`;
  const paneId = `${sessionName}:0.0`;
  const permissionFlags = getPermissionFlag().join(" ");

  createPsmuxSession(sessionName, { layout: "1xN", paneCount: 1 });
  try {
    sendKeysToPane(paneId, buildRemoteBootstrapCommand(host));
    await waitForRemotePrompt(sessionName, paneId);

    const claudeCommand = buildRemoteClaudeCommand(env, permissionFlags);
    if (env.shell === "pwsh") {
      sendKeysToPane(paneId, `cd '${escapePwshSingleQuoted(resolvedDir)}'`);
    } else {
      sendKeysToPane(paneId, `cd ${shellQuote(resolvedDir)}`);
    }
    sendKeysToPane(paneId, claudeCommand);

    if (prompt) {
      sleepMs(2000);
      sendKeysToPane(paneId, prompt);
    }

    startSpawnSessionCleanupWatcher(sessionName, paneId);
    openAttachTab(sessionName, `Claude@${host}`);
    console.log(sessionName);
  } catch (err) {
    try { killPsmuxSession(sessionName); } catch {}
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

async function waitForClaudeReady(sessionName, timeoutSec = 60) {
  requirePsmux();
  if (!psmuxSessionExists(sessionName)) {
    throw new Error(`psmux session not found: ${sessionName}`);
  }
  const paneId = `${sessionName}:0.0`;
  const readyPattern = /(\u276f|\u2795|>\s*$|bypass permissions)/;
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() <= deadline) {
    const snapshot = capturePsmuxPane(paneId, 5);
    const lastLine = snapshot.split(/\r?\n/).filter((l) => l.trim()).at(-1) || "";
    if (readyPattern.test(lastLine)) {
      return true;
    }
    sleepMs(1000);
  }
  throw new Error(`claude ready wait timed out after ${timeoutSec}s for ${sessionName}`);
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
    console.log(JSON.stringify(probeRemoteEnv(args.probeHost, { force: true }), null, 2));
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
    await waitForClaudeReady(args.sessionName);
    console.log("ready");
    return;
  }

  const prompt = buildPrompt(args);

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

  await spawnRemote(args, prompt);
}

const selfRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (selfRun) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
