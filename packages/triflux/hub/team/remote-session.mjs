// Remote session primitives.
// Pure functions + SSH operations. No psmux, no WT, no CLI arg parsing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  posix as posixPath,
  win32 as win32Path,
} from "node:path";
import { execSshWithRetry } from "../lib/ssh-retry.mjs";

const REMOTE_ENV_TTL_MS = 86_400_000; // 24h
const REMOTE_STAGE_ROOT = "tfx-remote";
const SAFE_HOST_RE = /^[a-zA-Z0-9._-]+$/;

// ── Shell quoting utilities ─────────────────────────────────────

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// PowerShell 은 ‘ ’ ‚ ‛ 도 작은따옴표로 읽는다. 따옴표 문자를 모두 겹쳐 써야 인용이 안 끝난다.
export function escapePwshSingleQuoted(value) {
  return String(value).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&");
}

// 큰따옴표 안에서는 $ 가 확장되고 “ ” „ 도 따옴표로 읽힌다. 모두 백틱으로 막는다.
export function escapePwshDoubleQuoted(value) {
  return String(value).replace(/[`$"\u201C\u201D\u201E]/g, "`$&");
}

// ssh 는 원격 명령 인자를 공백으로 이어 원격 셸에 다시 넘긴다. 스크립트는 인용한 문자열 하나로 만든다.
export function posixRemoteCommand(script) {
  return `sh -lc ${shellQuote(script)}`;
}

// pwsh 스크립트는 base64 로 넘겨 원격 기본 셸(cmd 나 pwsh)이 따옴표와 파이프를 해석하지 않게 한다.
export function pwshRemoteCommand(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `pwsh -NoProfile -EncodedCommand ${encoded}`;
}

function normalizeCommandPath(value) {
  return String(value).replace(/\\/g, "/");
}

// ── Validation ──────────────────────────────────────────────────

export function validateHost(host) {
  if (!host || !SAFE_HOST_RE.test(host)) {
    throw new Error(`invalid host name: ${host}`);
  }
  return host;
}

// ── Remote environment probe ────────────────────────────────────

function parseProbeLines(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("=");
        return idx === -1 ? null : [line.slice(0, idx), line.slice(idx + 1)];
      })
      .filter(Boolean),
  );
}

function normalizePwshProbeEnv(parsed) {
  if (parsed.shell !== "pwsh" || parsed.os !== "win32") return null;
  if (!parsed.home) return null;
  return Object.freeze({
    claudePath:
      !parsed.claude || parsed.claude === "notfound" ? null : parsed.claude,
    home: parsed.home,
    os: "win32",
    shell: "pwsh",
  });
}

function normalizePosixProbeEnv(parsed) {
  const os =
    parsed.os === "darwin" ? "darwin" : parsed.os === "linux" ? "linux" : null;
  if (!os || !parsed.home) return null;
  return Object.freeze({
    claudePath:
      !parsed.claude || parsed.claude === "notfound" ? null : parsed.claude,
    codexPath:
      !parsed.codex || parsed.codex === "notfound" ? null : parsed.codex,
    geminiPath:
      !parsed.gemini || parsed.gemini === "notfound" ? null : parsed.gemini,
    home: parsed.home,
    os,
    shell: parsed.shell === "zsh" ? "zsh" : "bash",
    node: parsed.node || null,
    cores: parsed.cores ? Number(parsed.cores) : null,
    ramGb: parsed.ram_gb ? Number(parsed.ram_gb) : null,
  });
}

function probeRemoteEnvViaPwsh(host) {
  const command = [
    "Write-Output 'shell=pwsh'",
    'Write-Output "home=$env:USERPROFILE"',
    'if (Test-Path "$env:USERPROFILE\\.local\\bin\\claude.exe") { Write-Output "claude=$env:USERPROFILE\\.local\\bin\\claude.exe" } elseif (Get-Command claude -ErrorAction SilentlyContinue) { Write-Output "claude=$((Get-Command claude).Source)" } else { Write-Output \'claude=notfound\' }',
    "Write-Output \"os=$([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) ? 'win32' : 'other')\"",
  ].join("; ");

  try {
    const output = execSshWithRetry(
      [host, "pwsh", "-NoProfile", "-Command", command],
      {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
        maxRetries: 2,
        baseDelayMs: 1000,
      },
    );
    return normalizePwshProbeEnv(parseProbeLines(output));
  } catch {
    return null;
  }
}

function probeRemoteEnvViaPosix(host) {
  const script = [
    '[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv" 2>/dev/null || true',
    "export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | sort -V | tail -1)/bin:$PATH 2>/dev/null",
    "echo shell=$(basename $SHELL)",
    "echo home=$HOME",
    "command -v claude >/dev/null 2>&1 && echo claude=$(command -v claude) || echo claude=notfound",
    "command -v codex >/dev/null 2>&1 && echo codex=$(command -v codex) || echo codex=notfound",
    "command -v gemini >/dev/null 2>&1 && echo gemini=$(command -v gemini) || echo gemini=notfound",
    "echo os=$(uname -s | tr A-Z a-z)",
    "node --version 2>/dev/null && echo node=$(node --version) || echo node=notfound",
    // darwin: sysctl, linux: nproc + /proc/meminfo
    "if [ $(uname -s) = Darwin ]; then echo cores=$(sysctl -n hw.ncpu); echo ram_gb=$(($(sysctl -n hw.memsize) / 1073741824)); else echo cores=$(nproc 2>/dev/null || echo 0); echo ram_gb=$(($(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}') / 1048576)); fi",
  ].join("\n");

  try {
    const output = execSshWithRetry([host, "sh"], {
      encoding: "utf8",
      timeout: 15000,
      input: script,
      maxRetries: 2,
      baseDelayMs: 1000,
    });
    return normalizePosixProbeEnv(parseProbeLines(output));
  } catch {
    return null;
  }
}

// ── Cache ───────────────────────────────────────────────────────

// cwd 의 .omc 에 두면 실행한 저장소마다 원격 홈 경로가 흩어져 남는다. 사용자 상태 경로에 둔다.
export function tfxStateDir(env = process.env) {
  // XDG 명세대로 상대 경로는 무시한다. 받아들이면 캐시가 다시 cwd 아래로 간다.
  const xdgState = isAbsolute(env.XDG_STATE_HOME || "")
    ? env.XDG_STATE_HOME
    : "";
  const stateRoot =
    xdgState ||
    (process.platform === "win32"
      ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : join(homedir(), ".local", "state"));
  return join(stateRoot, "triflux");
}

export function remoteEnvCacheDir(env = process.env) {
  return join(tfxStateDir(env), "remote-env");
}

function getEnvCachePath(host, cacheDir) {
  return join(cacheDir, `${host}.json`);
}

function readEnvCache(host, cacheDir) {
  const cachePath = getEnvCachePath(host, cacheDir);
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isEnvCacheFresh(entry, now = Date.now()) {
  if (!entry?.env || typeof entry.cachedAt !== "number") return false;
  const age = now - entry.cachedAt;
  // 미래 시각을 허용하면 그 캐시가 영원히 신선하게 남는다.
  return age >= 0 && age < REMOTE_ENV_TTL_MS;
}

function writeEnvCache(host, env, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    getEnvCachePath(host, cacheDir),
    JSON.stringify({ cachedAt: Date.now(), env }, null, 2),
    "utf8",
  );
}

/**
 * Probe remote host environment (OS, shell, Claude path, home dir).
 * Results are cached for 24h.
 *
 * @param {string} host — SSH host
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] — bypass cache
 * @param {string} [opts.cacheDir]: cache directory (default: remoteEnvCacheDir())
 * @returns {Readonly<RemoteEnv>}
 */
export function probeRemoteEnv(host, opts = {}) {
  validateHost(host);
  const force = opts.force === true;
  const cacheDir = opts.cacheDir || remoteEnvCacheDir();

  if (!force) {
    const cached = readEnvCache(host, cacheDir);
    if (isEnvCacheFresh(cached)) return cached.env;
  }

  const pwshEnv = probeRemoteEnvViaPwsh(host);
  if (pwshEnv) {
    writeEnvCache(host, pwshEnv, cacheDir);
    return pwshEnv;
  }

  const posixEnv = probeRemoteEnvViaPosix(host);
  if (posixEnv) {
    writeEnvCache(host, posixEnv, cacheDir);
    return posixEnv;
  }

  throw new Error(`remote probe failed for ${host}`);
}

// ── Remote directory resolution ─────────────────────────────────

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

/**
 * Resolve a directory path on a remote host.
 * Handles ~ expansion and OS-specific path normalization.
 *
 * @param {string} dir — requested directory (or empty for home)
 * @param {RemoteEnv} env
 * @returns {string}
 */
export function resolveRemoteDir(dir, env) {
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

// ── Remote file staging ─────────────────────────────────────────

/**
 * Resolve the remote staging directory path.
 * @param {RemoteEnv} env
 * @param {string} stageId
 * @returns {string}
 */
export function resolveRemoteStageDir(env, stageId) {
  return `${normalizeCommandPath(env.home)}/${REMOTE_STAGE_ROOT}/${stageId}`;
}

/**
 * Ensure the remote staging directory exists via SSH.
 * @param {string} host
 * @param {RemoteEnv} env
 * @param {string} remoteStageDir
 */
export function ensureRemoteStageDir(host, env, remoteStageDir) {
  const command =
    env.os === "win32"
      ? pwshRemoteCommand(
          `New-Item -ItemType Directory -Path '${escapePwshSingleQuoted(remoteStageDir)}' -Force | Out-Null`,
        )
      : posixRemoteCommand(`mkdir -p ${shellQuote(remoteStageDir)}`);
  execFileSync("ssh", [host, command], { timeout: 10000, stdio: "pipe" });
}

/**
 * Upload a file to remote host via scp.
 * @param {string} host
 * @param {string} localPath
 * @param {string} remotePath
 */
export function uploadFileToRemote(host, localPath, remotePath) {
  execFileSync("scp", [localPath, `${host}:${remotePath}`], {
    timeout: 15000,
    stdio: "pipe",
  });
}

/**
 * Stage local files on a remote host for prompt delivery.
 *
 * @param {string} host
 * @param {RemoteEnv} env
 * @param {Array<{ localPath: string }>} transferCandidates
 * @param {string} stageId
 * @returns {{ remoteStageDir: string|null, stagedFiles: Array<{ localPath: string, remotePath: string }> }}
 */
export function stageRemotePromptFiles(host, env, transferCandidates, stageId) {
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
    return { ...candidate, remotePath };
  });

  return { remoteStageDir, stagedFiles };
}

/**
 * Execute a git command on a remote host via SSH.
 *
 * @param {string} host
 * @param {RemoteEnv} env
 * @param {string[]} gitArgs — git subcommand + args
 * @param {string} cwd — remote working directory
 * @returns {string} stdout
 */
export function remoteGit(host, env, gitArgs, cwd) {
  const command =
    env.os === "win32"
      ? pwshRemoteCommand(
          [
            `Set-Location '${escapePwshSingleQuoted(cwd)}';`,
            "git",
            ...gitArgs.map((arg) => `'${escapePwshSingleQuoted(arg)}'`),
          ].join(" "),
        )
      : posixRemoteCommand(
          `cd ${shellQuote(cwd)} && ${["git", ...gitArgs].map(shellQuote).join(" ")}`,
        );
  return execFileSync("ssh", [host, command], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
