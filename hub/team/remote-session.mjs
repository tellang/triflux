// hub/team/remote-session.mjs — Remote session primitives for swarm integration
// Extracted from scripts/remote-spawn.mjs for reuse by swarm-hypervisor.
// Pure functions + SSH operations. No psmux, no WT, no CLI arg parsing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, posix as posixPath, win32 as win32Path } from 'node:path';
import { execSshWithRetry } from '../lib/ssh-retry.mjs';

const REMOTE_ENV_TTL_MS = 86_400_000; // 24h
const REMOTE_STAGE_ROOT = 'tfx-remote';
const SAFE_HOST_RE = /^[a-zA-Z0-9._-]+$/;

// ── Shell quoting utilities ─────────────────────────────────────

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function escapePwshSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

export function escapePwshDoubleQuoted(value) {
  return String(value).replace(/`/g, '``').replace(/"/g, '`"');
}

function normalizeCommandPath(value) {
  return String(value).replace(/\\/g, '/');
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
        const idx = line.indexOf('=');
        return idx === -1 ? null : [line.slice(0, idx), line.slice(idx + 1)];
      })
      .filter(Boolean),
  );
}

function normalizePwshProbeEnv(parsed) {
  if (parsed.shell !== 'pwsh' || parsed.os !== 'win32') return null;
  if (!parsed.home) return null;
  return Object.freeze({
    claudePath: (!parsed.claude || parsed.claude === 'notfound') ? null : parsed.claude,
    home: parsed.home,
    os: 'win32',
    shell: 'pwsh',
  });
}

function normalizePosixProbeEnv(parsed) {
  const os = parsed.os === 'darwin' ? 'darwin' : parsed.os === 'linux' ? 'linux' : null;
  if (!os || !parsed.home) return null;
  return Object.freeze({
    claudePath: (!parsed.claude || parsed.claude === 'notfound') ? null : parsed.claude,
    home: parsed.home,
    os,
    shell: parsed.shell === 'zsh' ? 'zsh' : 'bash',
  });
}

function probeRemoteEnvViaPwsh(host) {
  const command = [
    "Write-Output 'shell=pwsh'",
    'Write-Output "home=$env:USERPROFILE"',
    'if (Test-Path "$env:USERPROFILE\\.local\\bin\\claude.exe") { Write-Output "claude=$env:USERPROFILE\\.local\\bin\\claude.exe" } elseif (Get-Command claude -ErrorAction SilentlyContinue) { Write-Output "claude=$((Get-Command claude).Source)" } else { Write-Output \'claude=notfound\' }',
    'Write-Output "os=$([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) ? \'win32\' : \'other\')"',
  ].join('; ');

  try {
    const output = execSshWithRetry([host, 'pwsh', '-NoProfile', '-Command', command], {
      encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
      maxRetries: 2, baseDelayMs: 1000,
    });
    return normalizePwshProbeEnv(parseProbeLines(output));
  } catch {
    return null;
  }
}

function probeRemoteEnvViaPosix(host) {
  const script = [
    'echo shell=$(basename $SHELL)',
    'echo home=$HOME',
    'command -v claude >/dev/null 2>&1 && echo claude=$(command -v claude) || echo claude=notfound',
    'echo os=$(uname -s | tr A-Z a-z)',
  ].join('\n');

  try {
    const output = execSshWithRetry([host, 'sh'], {
      encoding: 'utf8', timeout: 15000, input: script,
      maxRetries: 2, baseDelayMs: 1000,
    });
    return normalizePosixProbeEnv(parseProbeLines(output));
  } catch {
    return null;
  }
}

// ── Cache ───────────────────────────────────────────────────────

function getEnvCachePath(host, cacheDir) {
  return join(cacheDir, `${host}.json`);
}

function readEnvCache(host, cacheDir) {
  const cachePath = getEnvCachePath(host, cacheDir);
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isEnvCacheFresh(entry) {
  return Boolean(
    entry
    && typeof entry.cachedAt === 'number'
    && entry.env
    && (Date.now() - entry.cachedAt) < REMOTE_ENV_TTL_MS,
  );
}

function writeEnvCache(host, env, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(getEnvCachePath(host, cacheDir), JSON.stringify({ cachedAt: Date.now(), env }, null, 2), 'utf8');
}

/**
 * Probe remote host environment (OS, shell, Claude path, home dir).
 * Results are cached for 24h.
 *
 * @param {string} host — SSH host
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] — bypass cache
 * @param {string} [opts.cacheDir] — cache directory (default: .omc/state/remote-env)
 * @returns {Readonly<RemoteEnv>}
 */
export function probeRemoteEnv(host, opts = {}) {
  validateHost(host);
  const force = opts.force === true;
  const cacheDir = opts.cacheDir || join('.omc', 'state', 'remote-env');

  if (!force) {
    const cached = readEnvCache(host, cacheDir);
    if (isEnvCacheFresh(cached)) return cached.env;
  }

  const pwshEnv = probeRemoteEnvViaPwsh(host);
  if (pwshEnv) { writeEnvCache(host, pwshEnv, cacheDir); return pwshEnv; }

  const posixEnv = probeRemoteEnvViaPosix(host);
  if (posixEnv) { writeEnvCache(host, posixEnv, cacheDir); return posixEnv; }

  throw new Error(`remote probe failed for ${host}`);
}

// ── Remote directory resolution ─────────────────────────────────

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith('\\\\');
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

  if (env.os === 'win32') {
    const winDir = requestedDir.replace(/\//g, '\\');
    if (winDir === '~') return env.home;
    if (/^~[\\/]/u.test(winDir)) return win32Path.join(env.home, winDir.slice(2));
    if (isWindowsAbsolutePath(winDir)) return winDir;
    return win32Path.join(env.home, winDir);
  }

  if (requestedDir === '~') return env.home;
  if (requestedDir.startsWith('~/')) return posixPath.join(env.home, requestedDir.slice(2));
  if (requestedDir.startsWith('/')) return requestedDir;
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
  if (env.os === 'win32') {
    const safePath = escapePwshSingleQuoted(remoteStageDir);
    execFileSync('ssh', [host, 'pwsh', '-NoProfile', '-Command', `New-Item -ItemType Directory -Path '${safePath}' -Force | Out-Null`], { timeout: 10000, stdio: 'pipe' });
    return;
  }
  execFileSync('ssh', [host, 'sh', '-lc', `mkdir -p ${shellQuote(remoteStageDir)}`], { timeout: 10000, stdio: 'pipe' });
}

/**
 * Upload a file to remote host via scp.
 * @param {string} host
 * @param {string} localPath
 * @param {string} remotePath
 */
export function uploadFileToRemote(host, localPath, remotePath) {
  execFileSync('scp', [localPath, `${host}:${remotePath}`], { timeout: 15000, stdio: 'pipe' });
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
  const gitCmd = ['git', ...gitArgs].map((a) => shellQuote(a)).join(' ');

  if (env.os === 'win32') {
    const cdPath = escapePwshSingleQuoted(cwd);
    const command = `Set-Location '${cdPath}'; ${gitCmd}`;
    return execFileSync('ssh', [host, 'pwsh', '-NoProfile', '-Command', command], {
      encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  return execFileSync('ssh', [host, 'sh', '-lc', `cd ${shellQuote(cwd)} && ${gitCmd}`], {
    encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
