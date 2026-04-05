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

/**
 * 허브의 현재 상태(PID, 포트, 버전 등)를 파일에 기록합니다.
 * 원자적(atomic) 쓰기를 위해 임시 파일을 생성한 후 교체하는 방식을 사용합니다.
 * 
 * @param {object} payload - 상태 데이터
 * @param {number} payload.pid - 허브 프로세스 ID
 * @param {number} payload.port - 허브 서버 포트
 * @param {string} payload.version - 허브 버전
 * @param {string} payload.sessionId - 현재 세션 ID
 * @param {string} payload.startedAt - 시작 시각 (ISO 8601)
 * @param {object} [options] - 옵션
 * @param {string} [options.stateDir] - 상태 파일이 저장될 디렉토리
 * @returns {object} 기록된 상태 데이터
 */
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

/**
 * 파일로부터 허브의 현재 상태를 읽어옵니다.
 * 
 * @param {object} [options] - 옵션
 * @param {string} [options.stateDir] - 상태 파일이 저장된 디렉토리
 * @returns {object|null} 읽어온 상태 데이터 또는 실패 시 null
 */
export function readState(options = {}) {
  const statePath = getStatePath(options);
  try {
    if (!existsSync(statePath)) return null;
    return parseJson(readFileSync(statePath, 'utf8'), null);
  } catch {
    return null;
  }
}

/**
 * 지정된 포트에서 실행 중인 허브 서버의 헬스 체크를 수행합니다.
 * 
 * @param {number|string} port - 서버 포트
 * @param {object} [options] - 옵션
 * @param {number} [options.timeoutMs=1000] - 요청 타임아웃
 * @param {string} [options.baseUrl] - 서버 베이스 URL
 * @returns {Promise<boolean>} 서버 정상 작동 여부
 */
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

/**
 * 현재 프로젝트의 버전 해시를 생성합니다.
 * package.json의 버전과 Git commit SHA를 조합합니다.
 * 
 * @param {object} [options] - 옵션
 * @param {boolean} [options.force=false] - 캐시를 무시하고 새로 생성할지 여부
 * @returns {string} 버전 해시 문자열
 */
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

/**
 * 허브 시작 시 중복 실행을 방지하기 위한 잠금(lock)을 획득합니다.
 * 이미 실행 중인 다른 프로세스가 있는지 확인하고 유효한 잠금을 획득할 때까지 재시도합니다.
 * 
 * @param {object} [options] - 옵션
 * @param {number} [options.timeoutMs=3000] - 최대 대기 시간
 * @param {number} [options.pollMs=50] - 재시도 간격
 * @param {string} [options.lockPath] - 잠금 파일 경로
 * @returns {Promise<{path: string}>} 잠금 파일 경로
 * @throws {Error} 타임아웃 내에 잠금을 획득하지 못한 경우
 */
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

/**
 * 획득했던 잠금을 해제합니다. 잠금 파일을 삭제하고 관련 리소스를 정리합니다.
 * 
 * @param {object} [options] - 옵션
 * @param {string} [options.lockPath] - 명시적인 잠금 파일 경로
 */
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
