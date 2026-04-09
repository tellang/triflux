// hub/lib/path-utils.mjs — Windows/POSIX 경로 변환 유틸리티

/**
 * Windows 경로를 Git Bash 스타일 POSIX 경로로 변환한다.
 * C:\foo\bar → /c/foo/bar
 * 이미 POSIX 경로면 그대로 반환.
 * null/undefined → 빈 문자열
 * @param {string|null|undefined} windowsPath
 * @returns {string}
 */
export function toPosixPath(windowsPath) {
  if (windowsPath == null) return "";
  const p = String(windowsPath);
  if (!p) return "";

  // 이미 POSIX 경로 (/ 로 시작하거나 드라이브 레터 없음)
  const winDriveMatch = p.match(/^([A-Za-z]):[/\\](.*)/);
  if (!winDriveMatch) {
    // 백슬래시만 있는 상대 경로도 forward slash로 변환
    return p.replace(/\\/g, "/");
  }

  const drive = winDriveMatch[1].toLowerCase();
  const rest = winDriveMatch[2].replace(/\\/g, "/");
  return `/${drive}/${rest}`;
}

/**
 * POSIX 경로(Git Bash 스타일)를 Windows 경로로 변환한다.
 * /c/foo/bar → C:\foo\bar
 * 이미 Windows 경로면 그대로 반환.
 * null/undefined → 빈 문자열
 * @param {string|null|undefined} posixPath
 * @returns {string}
 */
export function toWindowsPath(posixPath) {
  if (posixPath == null) return "";
  const p = String(posixPath);
  if (!p) return "";

  // 이미 Windows 경로
  if (/^[A-Za-z]:/.test(p)) {
    return p.replace(/\//g, "\\");
  }

  // Git Bash 스타일: /c/foo/bar
  const gitBashMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (gitBashMatch) {
    const drive = gitBashMatch[1].toUpperCase();
    const rest = gitBashMatch[2] ? gitBashMatch[2].replace(/\//g, "\\") : "\\";
    return `${drive}:${rest}`;
  }

  return p;
}

/**
 * 현재 OS에 맞게 경로를 정규화한다.
 * win32: backslash, 그 외: forward slash
 * @param {string|null|undefined} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (p == null) return "";
  const str = String(p);
  if (process.platform === "win32") {
    return str.replace(/\//g, "\\");
  }
  return str.replace(/\\/g, "/");
}

/**
 * 쉘 타입에 맞는 경로로 변환한다.
 * @param {string|null|undefined} path
 * @param {'git-bash'|'wsl'|'cmd'|'powershell'} shellType
 * @returns {string}
 */
export function resolveShellPath(path, shellType) {
  if (path == null) return "";
  const p = String(path);

  switch (shellType) {
    case "git-bash":
      return toPosixPath(p);

    case "wsl": {
      // Git Bash 경로를 먼저 Windows로 변환 후 WSL 형식으로
      const winPath = /^[A-Za-z]:/.test(p) ? p : toWindowsPath(p);
      const wslDriveMatch = winPath.match(/^([A-Za-z]):[/\\](.*)/);
      if (wslDriveMatch) {
        const drive = wslDriveMatch[1].toLowerCase();
        const rest = wslDriveMatch[2].replace(/\\/g, "/");
        return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
      }
      // 이미 /mnt/ 형식이면 그대로
      if (p.startsWith("/mnt/")) return p;
      return p.replace(/\\/g, "/");
    }

    case "cmd":
    case "powershell":
      return toWindowsPath(p);

    default:
      return p;
  }
}

/**
 * 환경 변수와 플랫폼 정보로 현재 쉘 타입을 추론한다.
 * @returns {'git-bash'|'wsl'|'cmd'|'powershell'|'unix'}
 */
export function detectShellType() {
  // WSL 감지: WSL_DISTRO_NAME 또는 WSLENV
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
    return "wsl";
  }

  // Windows 플랫폼
  if (process.platform === "win32") {
    const shell = process.env.SHELL || "";
    const term = process.env.TERM || "";
    const msystem = process.env.MSYSTEM || "";

    // Git Bash 감지: SHELL=/usr/bin/bash + MSYSTEM=MINGW64 등
    if (
      shell.includes("bash") ||
      msystem.startsWith("MINGW") ||
      msystem.startsWith("MSYS") ||
      term === "xterm"
    ) {
      return "git-bash";
    }

    // PowerShell 감지
    if (process.env.PSModulePath || process.env.PSHOME) {
      return "powershell";
    }

    return "cmd";
  }

  // 비-Windows
  return "unix";
}

/**
 * WSL 경로 여부를 확인한다 (/mnt/ 시작).
 * @param {string|null|undefined} p
 * @returns {boolean}
 */
export function isWslPath(p) {
  if (p == null) return false;
  return String(p).startsWith("/mnt/");
}

/**
 * Git Bash 경로 여부를 확인한다 (/c/ 또는 /d/ 등 단일 소문자 드라이브 레터).
 * @param {string|null|undefined} p
 * @returns {boolean}
 */
export function isGitBashPath(p) {
  if (p == null) return false;
  return /^\/[a-zA-Z](\/|$)/.test(String(p));
}
