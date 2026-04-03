import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const TEMP_DIR = IS_WINDOWS ? os.tmpdir() : '/tmp';
export const PATH_SEP = path.sep;

function getPathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function coercePathInput(value, platform) {
  const text = String(value ?? '');
  if (platform === 'win32') {
    return text.replaceAll('/', '\\');
  }
  return text.replaceAll('\\', '/');
}

function sanitizePipeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizePath(value, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = getPathApi(platform);
  const normalized = pathApi.normalize(coercePathInput(value, platform));

  if (platform === 'win32') {
    return normalized.replaceAll('\\', '/');
  }
  return normalized;
}

export function whichCommand(name, options = {}) {
  const commandName = String(name ?? '').trim();
  if (!commandName) return null;

  const platform = options.platform || process.platform;
  const lookupCommand = platform === 'win32' ? 'where' : 'which';

  try {
    const output = execFileSync(lookupCommand, [commandName], {
      encoding: 'utf8',
      timeout: options.timeout ?? 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: options.env || process.env,
      cwd: options.cwd,
    });

    const match = String(output)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);

    return match || null;
  } catch {
    return null;
  }
}

export function killProcess(pid, options = {}) {
  const numericPid = Number.parseInt(String(pid), 10);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;

  const platform = options.platform || process.platform;
  const signal = options.signal || 'SIGTERM';
  const tree = options.tree === true;
  const force = options.force === true || signal === 'SIGKILL';

  try {
    if (platform === 'win32' && (tree || force)) {
      const command = [
        'taskkill',
        '/PID',
        String(numericPid),
        tree ? '/T' : '',
        force ? '/F' : '',
      ]
        .filter(Boolean)
        .join(' ');
      execSync(command, {
        stdio: 'ignore',
        timeout: options.timeout ?? 5000,
        windowsHide: true,
      });
      return true;
    }

    process.kill(numericPid, signal);
    return true;
  } catch {
    return false;
  }
}

export function pipePath(name, pid = process.pid, options = {}) {
  const platform = options.platform || process.platform;
  const safeName = sanitizePipeSegment(name) || 'triflux';
  const suffix = pid == null || pid === '' ? safeName : `${safeName}-${pid}`;

  if (platform === 'win32') {
    return `\\\\.\\pipe\\${suffix}`;
  }

  const baseDir = options.tempDir || TEMP_DIR;
  return path.posix.join(baseDir, `${suffix}.sock`);
}

export function isPathWithin(resolvedPath, dir, options = {}) {
  if (!resolvedPath || !dir) return false;

  const platform = options.platform || process.platform;
  const pathApi = getPathApi(platform);
  const left = pathApi.resolve(coercePathInput(resolvedPath, platform));
  const right = pathApi.resolve(coercePathInput(dir, platform));

  const normalizedLeft = platform === 'win32' ? left.toLowerCase() : left;
  const normalizedRight = platform === 'win32' ? right.toLowerCase() : right;
  const relative = pathApi.relative(normalizedRight, normalizedLeft);

  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}
