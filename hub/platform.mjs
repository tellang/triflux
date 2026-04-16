import { execFile, execFileSync, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
export const TEMP_DIR = IS_WINDOWS ? os.tmpdir() : "/tmp";
export const PATH_SEP = path.sep;

function getPathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function coercePathInput(value, platform) {
  const text = String(value ?? "");
  if (platform === "win32") {
    return text.replaceAll("/", "\\");
  }
  return text.replaceAll("\\", "/");
}

function sanitizePipeSegment(value) {
  return String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildWhichCommandSpec(name, options = {}) {
  const commandName = String(name ?? "").trim();
  if (!commandName) return null;

  const platform = options.platform || process.platform;
  return {
    lookupCommand: platform === "win32" ? "where" : "which",
    args: [commandName],
    execOptions: {
      encoding: "utf8",
      timeout: options.timeout ?? 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: options.env || process.env,
      cwd: options.cwd,
    },
  };
}

function parseWhichCommandOutput(output) {
  return (
    String(output)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

function execFileAsync(command, args, options, execFileFn = execFile) {
  return new Promise((resolve, reject) => {
    execFileFn(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 경로를 플랫폼에 맞게 정규화합니다.
 * Windows 환경에서는 역슬래시(\)를 슬래시(/)로 변환하여 반환합니다.
 *
 * @param {string} value - 정규화할 경로 문자열
 * @param {object} [options] - 옵션
 * @param {string} [options.platform] - 대상 플랫폼 (기본값: process.platform)
 * @returns {string} 정규화된 경로
 */
export function normalizePath(value, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = getPathApi(platform);
  const normalized = pathApi.normalize(coercePathInput(value, platform));

  if (platform === "win32") {
    return normalized.replaceAll("\\", "/");
  }
  return normalized;
}

/**
 * 시스템에서 실행 가능한 명령의 절대 경로를 찾습니다.
 * Windows에서는 'where', Unix 계열에서는 'which' 명령을 사용합니다.
 *
 * @param {string} name - 찾을 명령어 이름
 * @param {object} [options] - 옵션
 * @param {string} [options.platform] - 대상 플랫폼
 * @param {number} [options.timeout=5000] - 검색 타임아웃 (ms)
 * @param {object} [options.env] - 환경 변수
 * @param {string} [options.cwd] - 작업 디렉토리
 * @returns {string|null} 명령어의 절대 경로 또는 찾지 못한 경우 null
 */
export function whichCommand(name, options = {}) {
  const spec = buildWhichCommandSpec(name, options);
  if (!spec) return null;

  try {
    const output = execFileSync(
      spec.lookupCommand,
      spec.args,
      spec.execOptions,
    );
    return parseWhichCommandOutput(output);
  } catch {
    return null;
  }
}

export async function whichCommandAsync(name, options = {}) {
  const spec = buildWhichCommandSpec(name, options);
  if (!spec) return null;

  try {
    const output = await execFileAsync(
      spec.lookupCommand,
      spec.args,
      spec.execOptions,
      options.execFileFn || execFile,
    );
    return parseWhichCommandOutput(output);
  } catch {
    return null;
  }
}

/**
 * 프로세스를 종료합니다.
 * Windows에서는 트리 구조 종료(/T) 및 강제 종료(/F)를 지원합니다.
 *
 * @param {number|string} pid - 종료할 프로세스 ID
 * @param {object} [options] - 옵션
 * @param {string} [options.platform] - 대상 플랫폼
 * @param {string} [options.signal='SIGTERM'] - 전송할 신호
 * @param {boolean} [options.tree=false] - 자식 프로세스까지 포함하여 종료할지 여부
 * @param {boolean} [options.force=false] - 강제 종료 여부
 * @param {number} [options.timeout=5000] - 타임아웃 (ms)
 * @returns {boolean} 종료 성공 여부
 */
export function killProcess(pid, options = {}) {
  const numericPid = Number.parseInt(String(pid), 10);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;

  const platform = options.platform || process.platform;
  const signal = options.signal || "SIGTERM";
  const tree = options.tree === true;
  const force = options.force === true || signal === "SIGKILL";

  try {
    if (platform === "win32" && (tree || force)) {
      const command = [
        "taskkill",
        "/PID",
        String(numericPid),
        tree ? "/T" : "",
        force ? "/F" : "",
      ]
        .filter(Boolean)
        .join(" ");
      execSync(command, {
        stdio: "ignore",
        timeout: options.timeout ?? 5000,
        windowsHide: true,
      });
      return true;
    }

    // macOS/Linux: tree 옵션이면 pkill -P로 자식 프로세스 먼저 종료
    if (tree) {
      try {
        execSync(`pkill -P ${numericPid}`, { stdio: "ignore", timeout: 3000 });
      } catch { /* 자식 없으면 무시 */ }
    }
    process.kill(numericPid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * 플랫폼별 IPC 파이프 또는 소켓 경로를 생성합니다.
 * Windows에서는 네임드 파이프 경로를, Unix 계열에서는 도메인 소켓 파일 경로를 반환합니다.
 *
 * @param {string} name - 파이프/소켓 기본 이름
 * @param {number|string} [pid=process.pid] - 프로세스 ID (식별자 추가용)
 * @param {object} [options] - 옵션
 * @param {string} [options.platform] - 대상 플랫폼
 * @param {string} [options.tempDir] - 임시 디렉토리 경로 (Unix 전용)
 * @returns {string} 플랫폼별 파이프/소켓 경로
 */
export function pipePath(name, pid = process.pid, options = {}) {
  const platform = options.platform || process.platform;
  const safeName = sanitizePipeSegment(name) || "triflux";
  const suffix = pid == null || pid === "" ? safeName : `${safeName}-${pid}`;

  if (platform === "win32") {
    return `\\\\.\\pipe\\${suffix}`;
  }

  const baseDir = options.tempDir || TEMP_DIR;
  return path.posix.join(baseDir, `${suffix}.sock`);
}

/**
 * 특정 경로가 대상 디렉토리 내부에 포함되는지 확인합니다.
 * 대소문자 구분 및 상대 경로 처리를 플랫폼 규격에 맞게 수행합니다.
 *
 * @param {string} resolvedPath - 검사할 절대 경로
 * @param {string} dir - 기준이 되는 대상 디렉토리 경로
 * @param {object} [options] - 옵션
 * @param {string} [options.platform] - 대상 플랫폼
 * @returns {boolean} 포함 여부
 */
export function isPathWithin(resolvedPath, dir, options = {}) {
  if (!resolvedPath || !dir) return false;

  const platform = options.platform || process.platform;
  const pathApi = getPathApi(platform);
  const left = pathApi.resolve(coercePathInput(resolvedPath, platform));
  const right = pathApi.resolve(coercePathInput(dir, platform));

  const normalizedLeft = platform === "win32" ? left.toLowerCase() : left;
  const normalizedRight = platform === "win32" ? right.toLowerCase() : right;
  const relative = pathApi.relative(normalizedRight, normalizedLeft);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !pathApi.isAbsolute(relative))
  );
}
