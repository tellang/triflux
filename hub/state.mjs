import { execSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_FILE_NAME = 'hub-state.json';
const LOCK_FILE_NAME = 'hub-start.lock';

let heldLockPath = null;
let heldLockFd = null;
let cachedVersionHash = null;

function getStateDir(options = {}) {
  return options.stateDir || process.env.TFX_HUB_STATE_DIR?.trim() || join(homedir(), '.claude', 'cache', 'tfx-hub');
}

function getStatePath(options = {}) {
  return join(getStateDir(options), STATE_FILE_NAME);
}

function getLockPath(options = {}) {
  return options.lockPath || join(getStateDir(options), LOCK_FILE_NAME);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function safeReplaceFile(tempPath, targetPath) {
  try {
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) {
      try { unlinkSync(tempPath); } catch {}
      throw error;
    }
    try { unlinkSync(targetPath); } catch {}
    renameSync(tempPath, targetPath);
  }
}

export function writeState({ pid, port, version, sessionId, startedAt }, options = {}) {
  const stateDir = getStateDir(options);
  const statePath = getStatePath(options);
  const tempPath = join(stateDir, `${STATE_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
  const payload = { pid, port, version, sessionId, startedAt };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  safeReplaceFile(tempPath, statePath);
  return payload;
}

export function readState(options = {}) {
  const statePath = getStatePath(options);
  try {
    if (!existsSync(statePath)) return null;
    return parseJson(readFileSync(statePath, 'utf8'), null);
  } catch {
    return null;
  }
}

export async function isServerHealthy(port, options = {}) {
  const resolvedPort = Number(port);
  if (!Number.isFinite(resolvedPort) || resolvedPort <= 0) return false;

  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 1000);
  const baseUrl = options.baseUrl || `http://127.0.0.1:${resolvedPort}`;

  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

export function getVersionHash(options = {}) {
  if (cachedVersionHash && !options.force) return cachedVersionHash;

  const packageJsonPath = join(PROJECT_ROOT, 'package.json');
  const pkg = parseJson(readFileSync(packageJsonPath, 'utf8'), {});
  const version = String(pkg?.version || '0.0.0').trim();

  let sha = String(process.env.TFX_HUB_GIT_SHA || '').trim();
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
    } catch {
      sha = '';
    }
  }

  cachedVersionHash = sha ? `${version}-${sha}` : version;
  return cachedVersionHash;
}

export async function acquireLock(options = {}) {
  if (heldLockFd !== null && heldLockPath) {
    return { path: heldLockPath };
  }

  const lockPath = getLockPath(options);
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 3000);
  const pollMs = Math.max(10, Number(options.pollMs) || 50);
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(lockPath), { recursive: true });

  while (Date.now() <= deadline) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      heldLockFd = fd;
      heldLockPath = lockPath;
      return { path: lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const raw = readFileSync(lockPath, 'utf8');
        const data = parseJson(raw, {});
        const stats = statSync(lockPath);
        const staleByPid = !isPidAlive(data?.pid);
        const staleByAge = Date.now() - stats.mtimeMs > timeoutMs;
        if (staleByPid || staleByAge) {
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {}

      await sleep(pollMs);
    }
  }

  throw new Error(`hub start lock busy: ${lockPath}`);
}

export function releaseLock(options = {}) {
  const lockPath = options.lockPath || heldLockPath || getLockPath(options);

  if (heldLockFd !== null) {
    try { closeSync(heldLockFd); } catch {}
    heldLockFd = null;
  }

  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {}

  if (!options.lockPath || options.lockPath === heldLockPath) {
    heldLockPath = null;
  }
}
